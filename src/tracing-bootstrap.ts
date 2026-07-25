/**
 * The heavy half of recipe tracing: provider construction and the OTLP
 * export pipeline. Loaded lazily from `initRecipeTracing` so hosts that
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

export interface RecipeTracingBootstrap {
  provider: RecipeTraceProvider;
  /** True when this bootstrap registered the global context manager. */
  ownsContextManager: boolean;
}

/**
 * The export target is the standard OTLP env contract, nothing else:
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT`) plus the usual
 * `_HEADERS` / `_TIMEOUT` / `_COMPRESSION` / cert companions, all read by
 * the exporter itself. Any collector or vendor backend is configured the
 * same way — including a hosted one behind a bearer token:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
 *   OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <token>
 */
function envSpanProcessors(): SpanProcessor[] {
  if (
    !process.env.OTEL_EXPORTER_OTLP_ENDPOINT &&
    !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ) {
    return [];
  }
  return [new BatchSpanProcessor(new OTLPTraceExporter())];
}

/**
 * Build the provider and register it globally. Returns null when there is
 * nothing to export to, or when another global tracer provider is already
 * registered — the host's OTel setup wins and nothing is overwritten.
 */
export async function bootstrapRecipeTracing(
  options: InitRecipeTracingOptions
): Promise<RecipeTracingBootstrap | null> {
  const spanProcessors = options.spanProcessors ?? envSpanProcessors();
  if (spanProcessors.length === 0) return null;

  const serviceName =
    process.env.OTEL_SERVICE_NAME ?? options.serviceName ?? "pi-recipes";
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
    console.error(
      `[tracing] trace export enabled (service=${serviceName}) -> ${
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }`
    );
  }
  return { provider, ownsContextManager };
}
