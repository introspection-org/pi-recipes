import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  instrumentAgent,
  instrumentStream,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi";
import { context as otelContext, trace, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export type { AgentMeta } from "@introspection-sdk/introspection-pi";

/**
 * Trace export for recipe sessions: the OTel **GenAI semantic-convention**
 * instrumentation (`invoke_agent` run spans, `chat {model}` model-call spans
 * with token usage, `execute_tool` spans) wired to env-configured OTLP
 * export, so a recipe served or embedded anywhere ships its traces to any
 * OTLP backend.
 *
 * Nothing is emitted by default. `initRecipeTelemetry` builds a provider only
 * when an export target is configured, from either or both of:
 *
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 *     (+ `_HEADERS`, `_TIMEOUT`, ...): the standard OTLP env contract, read
 *     by the exporter itself.
 *   - `INTROSPECTION_TOKEN` (+ `INTROSPECTION_BASE_OTEL_URL`): plain OTLP to
 *     the Introspection ingest with a bearer header — the same pair the
 *     managed runtime uses, so pointing a standalone deploy at the product
 *     is one env var.
 *
 * Once initialized, `createRecipeSession` attaches the instrumentation to
 * every session it builds (subagent sessions included). Hosts that already
 * own an OTel provider skip `initRecipeTelemetry` and call
 * `instrumentRecipeSession` with their own tracer instead.
 */
export interface InitRecipeTelemetryOptions {
  /** Fallback service name; `OTEL_SERVICE_NAME` wins. Default: "pi-recipes". */
  serviceName?: string;
  /** Extra resource attributes stamped on all spans. */
  resourceAttributes?: Record<string, string>;
  /**
   * Explicit processors instead of the env-derived OTLP pipelines — the
   * test / embedding seam. When set, env export config is ignored.
   */
  spanProcessors?: SpanProcessor[];
  /** Export configuration source. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Instrumentation scope of the tracer that produces the gen_ai spans. */
export const RECIPE_TRACER_NAME = "pi-recipes";

const DEFAULT_INTROSPECTION_OTEL_URL = "https://otel.introspection.dev";

let provider: BasicTracerProvider | null = null;

function envSpanProcessors(env: NodeJS.ProcessEnv): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  if (
    env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ) {
    // The exporter reads the OTEL_EXPORTER_OTLP_* contract from env itself.
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  if (env.INTROSPECTION_TOKEN) {
    const base = (
      env.INTROSPECTION_BASE_OTEL_URL ?? DEFAULT_INTROSPECTION_OTEL_URL
    ).replace(/\/$/, "");
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: base.endsWith("/v1/traces") ? base : `${base}/v1/traces`,
          headers: { authorization: `Bearer ${env.INTROSPECTION_TOKEN}` },
        })
      )
    );
  }
  return processors;
}

/**
 * Initialize the recipe trace provider. Returns true when this call created
 * it — the caller then owns `shutdownRecipeTelemetry()` — and false when no
 * export target is configured or a provider already exists.
 */
export function initRecipeTelemetry(
  options: InitRecipeTelemetryOptions = {}
): boolean {
  if (provider) return false;
  const env = options.env ?? process.env;
  const spanProcessors = options.spanProcessors ?? envSpanProcessors(env);
  if (spanProcessors.length === 0) return false;

  otelContext.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  );
  const serviceName =
    env.OTEL_SERVICE_NAME ?? options.serviceName ?? "pi-recipes";
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      ...options.resourceAttributes,
    }),
    spanProcessors,
  });
  trace.setGlobalTracerProvider(provider);
  if (!options.spanProcessors) {
    const targets = [
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
      env.INTROSPECTION_TOKEN
        ? (env.INTROSPECTION_BASE_OTEL_URL ?? DEFAULT_INTROSPECTION_OTEL_URL)
        : undefined,
    ].filter(Boolean);
    console.error(
      `[telemetry] trace export enabled (service=${serviceName}) -> ${targets.join(", ")}`
    );
  }
  return true;
}

/** The recipe tracer, or undefined while telemetry is uninitialized. */
export function getRecipeTracer(): Tracer | undefined {
  if (!provider) return undefined;
  return trace.getTracer(RECIPE_TRACER_NAME);
}

/** Flush pending spans; call after a run settles on short-lived hosts. */
export async function flushRecipeTelemetry(): Promise<void> {
  await provider?.forceFlush();
}

/** Flush, shut down, and unregister the provider (idempotent). */
export async function shutdownRecipeTelemetry(): Promise<void> {
  if (!provider) return;
  const active = provider;
  provider = null;
  try {
    await active.forceFlush();
    await active.shutdown();
  } finally {
    trace.disable();
    otelContext.disable();
  }
}

export interface InstrumentRecipeSessionOptions {
  /** Span identity for this session. */
  meta: AgentMeta;
  /** Default: the recipe tracer (when `initRecipeTelemetry` ran). */
  tracer?: Tracer;
}

interface SessionEntryLike {
  type?: string;
  summary?: unknown;
}

/**
 * Attach the GenAI instrumentation to a live session: one `invoke_agent`
 * span per run, `chat {model}` spans nested under it via the wrapped stream
 * function, `execute_tool` spans per tool call. Returns a detach that
 * restores the stream function and finalizes open spans, or undefined when
 * no tracer is available.
 */
export function instrumentRecipeSession(
  session: AgentSession,
  options: InstrumentRecipeSessionOptions
): (() => void) | undefined {
  const tracer = options.tracer ?? getRecipeTracer();
  if (!tracer) return undefined;

  const agent = session.agent;
  const original = agent.streamFunction;
  const instrumentation = instrumentAgent(agent, {
    tracer,
    meta: options.meta,
    runSpans: true,
  });
  agent.streamFunction = instrumentStream(original, {
    tracer,
    meta: options.meta,
    getParentContext: () => instrumentation.getRunContext(),
    // Structural compaction detection from the session tree, so telemetry
    // emits compaction parts regardless of pi's prose wrapper.
    getCompactionSummaries: () =>
      (session.sessionManager.getEntries() as SessionEntryLike[])
        .filter(
          (entry): entry is { summary: string } =>
            entry.type === "compaction" && typeof entry.summary === "string"
        )
        .map((entry) => entry.summary),
  });
  return () => {
    agent.streamFunction = original;
    instrumentation.stop();
  };
}
