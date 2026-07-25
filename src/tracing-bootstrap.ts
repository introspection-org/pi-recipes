/**
 * The heavy half of recipe tracing: provider construction and the OTLP
 * export pipelines. Loaded lazily from `initRecipeTracing` so hosts that
 * never export (and every embedding rung below serve) don't pay for the
 * exporter stack at module-eval time.
 */
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  InitRecipeTracingOptions,
  RecipeTraceProvider,
} from "./tracing.js";

const DEFAULT_INTROSPECTION_OTEL_URL = "https://otel.introspection.dev";

export interface RecipeTracingBootstrap {
  provider: RecipeTraceProvider;
  /** True when this bootstrap registered the global context manager. */
  ownsContextManager: boolean;
}

function envSpanProcessors(env: NodeJS.ProcessEnv): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  // The exporter reads the OTEL_EXPORTER_OTLP_* contract (endpoint, headers,
  // timeout, protocol, certs) from the process env itself, so this target is
  // gated on the process env too; the `env` option scopes only the ingest
  // pair below.
  if (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ) {
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
 * Build the provider and register it globally. Returns null when there is
 * nothing to export to, or when another global tracer provider is already
 * registered — the host's OTel setup wins and nothing is overwritten.
 */
export async function bootstrapRecipeTracing(
  options: InitRecipeTracingOptions
): Promise<RecipeTracingBootstrap | null> {
  const env = options.env ?? process.env;
  const spanProcessors = options.spanProcessors ?? envSpanProcessors(env);
  if (spanProcessors.length === 0) return null;

  const serviceName =
    env.OTEL_SERVICE_NAME ?? options.serviceName ?? "pi-recipes";
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      ...options.resourceAttributes,
    }),
    spanProcessors,
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    // A host-owned global provider is already registered; back off without
    // exporting anything.
    await provider.shutdown();
    return null;
  }
  // Registration can lose to a host-owned context manager; that manager
  // works for our spans too, so keep going — just don't disable it later.
  const ownsContextManager = otelContext.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  );

  if (!options.spanProcessors) {
    const targets = [
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      env.INTROSPECTION_TOKEN
        ? (env.INTROSPECTION_BASE_OTEL_URL ?? DEFAULT_INTROSPECTION_OTEL_URL)
        : undefined,
    ].filter(Boolean);
    console.error(
      `[tracing] trace export enabled (service=${serviceName}) -> ${targets.join(", ")}`
    );
  }
  return { provider, ownsContextManager };
}
