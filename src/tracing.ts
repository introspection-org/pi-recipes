import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  instrumentAgent,
  instrumentStream,
  type AbortTerminationReason,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi";
import {
  context as otelContext,
  trace,
  type Attributes,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

export type { AgentMeta } from "@introspection-sdk/introspection-pi";

/**
 * Trace export for recipe sessions: the OTel **GenAI semantic-convention**
 * instrumentation (`invoke_agent` run spans, `chat {model}` model-call spans
 * with token usage, `execute_tool` spans) wired to env-configured OTLP
 * export, so a recipe served or embedded anywhere ships its traces to any
 * OTLP backend.
 *
 * Nothing is emitted by default. `initRecipeTracing` builds a provider only
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
 * This module is deliberately light — its runtime imports are only the OTel
 * API and the instrumentation package — so the engine can depend on it from
 * every embedding rung without paying for the export stack. The provider
 * bootstrap (SDK trace provider, OTLP exporters, protobuf encoding) lives in
 * `tracing-bootstrap.ts` and is loaded lazily, only when
 * `initRecipeTracing` is actually called.
 *
 * Once initialized, `createRecipeSession` attaches the instrumentation to
 * every session it builds (subagent sessions included). Hosts that already
 * own an OTel provider skip `initRecipeTracing` and call
 * `instrumentRecipeSession` with their own tracer instead.
 */
export interface InitRecipeTracingOptions {
  /** Fallback service name; `OTEL_SERVICE_NAME` wins. Default: "pi-recipes". */
  serviceName?: string;
  /** Extra resource attributes stamped on all spans. */
  resourceAttributes?: Record<string, string>;
  /**
   * Explicit processors instead of the env-derived OTLP pipelines — the
   * test / embedding seam. When set, env export config is ignored.
   */
  spanProcessors?: SpanProcessor[];
  /**
   * Source for the ingest pair (`INTROSPECTION_TOKEN`,
   * `INTROSPECTION_BASE_OTEL_URL`) and `OTEL_SERVICE_NAME`. Default:
   * `process.env`. The standard `OTEL_EXPORTER_OTLP_*` target always reads
   * the process env — the exporter resolves that contract itself.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Handle to a provider created by `initRecipeTracing`: ownership of
 * shutdown is holding the handle. `flush` after a run settles on
 * short-lived hosts; `shutdown` once on host close.
 */
export interface RecipeTracing {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Instrumentation scope of the tracer that produces the gen_ai spans. */
export const RECIPE_TRACER_NAME = "pi-recipes";

/** The provider surface this module needs; the SDK provider satisfies it. */
export interface RecipeTraceProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let provider: RecipeTraceProvider | null = null;
let ownsContextManager = false;
let initializing: Promise<RecipeTracing | null> | null = null;

/**
 * Initialize the recipe trace provider. Returns a handle when this call
 * created it — holding the handle is owning `shutdown()` — and null when no
 * export target is configured, a provider already exists (the earlier owner
 * keeps its handle), or the host's own global OTel provider is already
 * registered (the host wins; nothing is overwritten).
 */
export function initRecipeTracing(
  options: InitRecipeTracingOptions = {}
): Promise<RecipeTracing | null> {
  if (provider || initializing) {
    // Whoever got here first owns the provider; later callers get null once
    // any in-flight init settles.
    return (initializing ?? Promise.resolve(null)).then(() => null);
  }
  initializing = (async () => {
    try {
      const { bootstrapRecipeTracing } = await import(
        "./tracing-bootstrap.js"
      );
      const created = await bootstrapRecipeTracing(options);
      if (!created) return null;
      provider = created.provider;
      ownsContextManager = created.ownsContextManager;
      return {
        flush: flushRecipeTracing,
        shutdown: shutdownRecipeTracing,
      };
    } finally {
      initializing = null;
    }
  })();
  return initializing;
}

/** The recipe tracer, or undefined while telemetry is uninitialized. */
export function getRecipeTracer(): Tracer | undefined {
  if (!provider) return undefined;
  return trace.getTracer(RECIPE_TRACER_NAME);
}

/** Flush pending spans; call after a run settles on short-lived hosts. */
export async function flushRecipeTracing(): Promise<void> {
  await provider?.forceFlush();
}

/** Flush, shut down, and unregister the provider (idempotent). */
export async function shutdownRecipeTracing(): Promise<void> {
  if (!provider) return;
  const active = provider;
  const ownedContextManager = ownsContextManager;
  provider = null;
  ownsContextManager = false;
  try {
    await active.forceFlush();
    await active.shutdown();
  } finally {
    // The global tracer provider is ours whenever `provider` was set — init
    // only records it after winning the registration. The context manager
    // may have been the host's; only disable what this module registered.
    trace.disable();
    if (ownedContextManager) otelContext.disable();
  }
}

export interface InstrumentRecipeSessionOptions {
  /** Span identity for this session. */
  meta: AgentMeta;
  /** Default: the recipe tracer (when `initRecipeTracing` ran). */
  tracer?: Tracer;
  /**
   * Emit one `invoke_agent` span per run and nest chat/tool spans under it.
   * Hosts that create their own turn/run spans set false and supply
   * `getParentContext` instead. Default: true.
   */
  runSpans?: boolean;
  /**
   * Parent context for chat and tool spans. Default: the active run span
   * (when `runSpans` is on), else the active OTel context.
   */
  getParentContext?: () => Context | null | undefined;
  /**
   * Classify a chat stream that ended via the caller's AbortSignal:
   * `"cancelled"` / `"awaiting_user"` end the span cleanly, `null` keeps
   * the abort classified as an error. Default: aborts are `"cancelled"`.
   */
  abortTerminationReason?: () => AbortTerminationReason | null;
  /** Host attributes (tenant labels, correlation ids) added to every span. */
  extraAttributes?: () => Attributes;
}

interface SessionEntryLike {
  type?: string;
  summary?: unknown;
}

/**
 * Attach the GenAI instrumentation to a live session: one `invoke_agent`
 * span per run, `chat {model}` spans nested under it via the wrapped stream
 * function, `execute_tool` spans per tool call. Hosts that own their span
 * topology pass `runSpans: false` + `getParentContext` (and optionally
 * `abortTerminationReason` / `extraAttributes`) to parent everything onto
 * their own turn spans. Returns a detach that restores the stream function
 * and finalizes open spans, or undefined when no tracer is available.
 */
export function instrumentRecipeSession(
  session: AgentSession,
  options: InstrumentRecipeSessionOptions
): (() => void) | undefined {
  const tracer = options.tracer ?? getRecipeTracer();
  if (!tracer) return undefined;

  const agent = session.agent;
  const original = agent.streamFunction;
  const extraAttributes = options.extraAttributes;
  const instrumentation = instrumentAgent(agent, {
    tracer,
    meta: options.meta,
    runSpans: options.runSpans ?? true,
    ...(options.getParentContext
      ? { getParentContext: options.getParentContext }
      : {}),
    ...(extraAttributes ? { extraAttributes: () => extraAttributes() } : {}),
  });
  agent.streamFunction = instrumentStream(original, {
    tracer,
    meta: options.meta,
    getParentContext:
      options.getParentContext ?? (() => instrumentation.getRunContext()),
    ...(options.abortTerminationReason
      ? { abortTerminationReason: options.abortTerminationReason }
      : {}),
    ...(extraAttributes ? { extraAttributes: () => extraAttributes() } : {}),
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
