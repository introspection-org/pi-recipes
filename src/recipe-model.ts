import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  CacheRetention,
  Model,
  OpenRouterRouting,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const CACHE_RETENTIONS = new Set(["none", "short", "long"]);

const MODEL_KEYS = new Set([
  "name",
  "thinking_level",
  "temperature",
  "max_tokens",
  "cache_retention",
  "timeout_ms",
  "max_retries",
  "max_retry_delay_ms",
  "providers",
]);

const AI_KEYS = new Set(["model", "thinking_level", "options", "providers"]);

const BLOCKED_AI_OPTION_KEYS = new Set([
  "apiKey",
  "env",
  "fetch",
  "headers",
  "onPayload",
  "onResponse",
  "reasoning",
  "sessionId",
  "signal",
  "telemetryContext",
]);

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const PROVIDER_KEYS = new Set(["openrouter", "anthropic"]);

const OPENROUTER_PROVIDER_KEYS = new Set(["routing"]);

const OPENROUTER_KEYS = new Set([
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "zdr",
  "enforce_distillable_text",
  "order",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "max_price",
  "preferred_min_throughput",
  "preferred_max_latency",
]);

const ANTHROPIC_KEYS = new Set(["betas", "context_management"]);

export interface RecipeAgentModelStreamOptions extends Record<string, unknown> {
  temperature?: number;
  maxTokens?: number;
  cacheRetention?: CacheRetention;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

export interface RecipeAgentModelAnthropicOptions {
  betas?: string[];
  contextManagement?: unknown;
}

export interface RecipeAgentModelConfig {
  name?: string;
  thinkingLevel?: ThinkingLevel;
  streamOptions?: RecipeAgentModelStreamOptions;
  openrouter?: OpenRouterRouting;
  anthropic?: RecipeAgentModelAnthropicOptions;
}

export class RecipeModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeModelConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase()
  );
}

function normalizeSnakeCaseObject(
  context: string,
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(`${context}: expected object`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SNAKE_CASE_KEY.test(key)) {
      throw new RecipeModelConfigError(
        `${context} has non-snake_case key "${key}"`
      );
    }
    const normalizedKey = snakeToCamel(key);
    if (BLOCKED_AI_OPTION_KEYS.has(normalizedKey)) {
      throw new RecipeModelConfigError(
        `${context} cannot configure host-owned option "${key}"`
      );
    }
    normalized[normalizedKey] = child;
  }
  return normalized;
}

function optionalString(
  context: string,
  key: string,
  value: unknown
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RecipeModelConfigError(
      `${context} has invalid ${key}: expected string`
    );
  }
  return value.trim() || undefined;
}

function optionalNumber(
  context: string,
  key: string,
  value: unknown,
  min: number
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${key}: expected number >= ${min}`
    );
  }
  return value;
}

function optionalInteger(
  context: string,
  key: string,
  value: unknown,
  min: number
): number | undefined {
  const parsed = optionalNumber(context, key, value, min);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${key}: expected integer`
    );
  }
  return parsed;
}

function optionalStringArray(
  context: string,
  key: string,
  value: unknown
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${key}: expected string array`
    );
  }
  return value.map((item) => item.trim());
}

function parseThinkingLevel(
  context: string,
  key: string,
  value: unknown
): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new RecipeModelConfigError(
      `${context} has unsupported ${key} "${value}"`
    );
  }
  return value as ThinkingLevel;
}

function assertKnownKeys(
  context: string,
  keyPrefix: string,
  data: Record<string, unknown>,
  allowed: Set<string>
): void {
  const unknown = Object.keys(data).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RecipeModelConfigError(
      `${context} has unsupported ${keyPrefix} key(s): ${unknown.join(", ")}`
    );
  }
}

function parseOpenRouterRouting(
  context: string,
  value: unknown,
  prefix: "ai" | "model"
): OpenRouterRouting | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${prefix}.providers.openrouter.routing: expected object`
    );
  }
  assertKnownKeys(
    context,
    `${prefix}.providers.openrouter.routing`,
    value,
    OPENROUTER_KEYS
  );
  return { ...value } as OpenRouterRouting;
}

function parseOpenRouterProvider(
  context: string,
  value: unknown,
  prefix: "ai" | "model"
): OpenRouterRouting | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${prefix}.providers.openrouter: expected object`
    );
  }
  assertKnownKeys(
    context,
    `${prefix}.providers.openrouter`,
    value,
    OPENROUTER_PROVIDER_KEYS
  );
  return parseOpenRouterRouting(context, value.routing, prefix);
}

function parseAnthropic(
  context: string,
  value: unknown,
  prefix: "ai" | "model"
): RecipeAgentModelAnthropicOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${prefix}.providers.anthropic: expected object`
    );
  }
  assertKnownKeys(context, `${prefix}.providers.anthropic`, value, ANTHROPIC_KEYS);
  const betas = optionalStringArray(
    context,
    `${prefix}.providers.anthropic.betas`,
    value.betas
  );
  return {
    ...(betas ? { betas } : {}),
    ...(value.context_management !== undefined
      ? { contextManagement: value.context_management }
      : {}),
  };
}

function parseProviders(
  context: string,
  value: unknown,
  prefix: "ai" | "model"
): Pick<RecipeAgentModelConfig, "openrouter" | "anthropic"> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(
      `${context} has invalid ${prefix}.providers: expected object`
    );
  }
  assertKnownKeys(context, `${prefix}.providers`, value, PROVIDER_KEYS);
  const openrouter = parseOpenRouterProvider(context, value.openrouter, prefix);
  const anthropic = parseAnthropic(context, value.anthropic, prefix);
  return {
    ...(openrouter ? { openrouter } : {}),
    ...(anthropic ? { anthropic } : {}),
  };
}

/**
 * Parse an agent YAML `model:` block into a validated config.
 *
 * Accepts the documented keys only; unknown keys, malformed values, and
 * invalid or unknown fields throw
 * {@link RecipeModelConfigError} so typos fail loudly instead of silently
 * changing model behavior.
 */
export function parseRecipeAgentModelConfig(
  context: string,
  value: unknown
): RecipeAgentModelConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(
      `${context} has invalid model: expected object`
    );
  }
  assertKnownKeys(context, "model", value, MODEL_KEYS);

  const thinkingLevel = parseThinkingLevel(
    context,
    "model.thinking_level",
    value.thinking_level
  );

  const cacheRetention = optionalString(
    context,
    "model.cache_retention",
    value.cache_retention
  );
  if (cacheRetention !== undefined && !CACHE_RETENTIONS.has(cacheRetention)) {
    throw new RecipeModelConfigError(
      `${context} has unsupported model.cache_retention "${cacheRetention}"`
    );
  }

  const temperature = optionalNumber(
    context,
    "model.temperature",
    value.temperature,
    0
  );
  const maxTokens = optionalInteger(
    context,
    "model.max_tokens",
    value.max_tokens,
    1
  );
  const timeoutMs = optionalInteger(
    context,
    "model.timeout_ms",
    value.timeout_ms,
    1
  );
  const maxRetries = optionalInteger(
    context,
    "model.max_retries",
    value.max_retries,
    0
  );
  const maxRetryDelayMs = optionalInteger(
    context,
    "model.max_retry_delay_ms",
    value.max_retry_delay_ms,
    0
  );
  const streamOptions: RecipeAgentModelStreamOptions = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cacheRetention
      ? { cacheRetention: cacheRetention as CacheRetention }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(maxRetryDelayMs !== undefined ? { maxRetryDelayMs } : {}),
  };

  const name = optionalString(context, "model.name", value.name);
  const providers = parseProviders(context, value.providers, "model");
  return {
    ...(name ? { name } : {}),
    ...(thinkingLevel
      ? { thinkingLevel: thinkingLevel as ThinkingLevel }
      : {}),
    ...(hasKeys(streamOptions) ? { streamOptions } : {}),
    ...(providers ?? {}),
  };
}

/**
 * Parse the preferred agent YAML `ai:` block. `options` keys are normalized
 * from Recipe snake_case to Pi camelCase without enumerating Pi's evolving
 * request-option surface. Nested values are deliberately left opaque.
 */
export function parseRecipeAgentAiConfig(
  context: string,
  value: unknown
): RecipeAgentModelConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeModelConfigError(`${context} has invalid ai: expected object`);
  }
  assertKnownKeys(context, "ai", value, AI_KEYS);

  const name = optionalString(context, "ai.model", value.model);
  const thinkingLevel = parseThinkingLevel(
    context,
    "ai.thinking_level",
    value.thinking_level
  );
  const streamOptions =
    value.options === undefined
      ? undefined
      : normalizeSnakeCaseObject(`${context} ai.options`, value.options);
  const providers = parseProviders(context, value.providers, "ai");
  return {
    ...(name ? { name } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(streamOptions && hasKeys(streamOptions) ? { streamOptions } : {}),
    ...(providers ?? {}),
  };
}

/**
 * Merge a child agent's model config over its `from:` base. Sections
 * (`streamOptions`, `openrouter`, `anthropic`) merge by key so a child can
 * override one option without restating the base's.
 */
export function mergeRecipeAgentModelConfig(
  base: RecipeAgentModelConfig | undefined,
  overlay: RecipeAgentModelConfig | undefined
): RecipeAgentModelConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  if (overlay.name !== undefined) {
    return overlay;
  }
  const streamOptions = {
    ...(base.streamOptions ?? {}),
    ...(overlay.streamOptions ?? {}),
  };
  const openrouter = {
    ...(base.openrouter ?? {}),
    ...(overlay.openrouter ?? {}),
  };
  const anthropic = {
    ...(base.anthropic ?? {}),
    ...(overlay.anthropic ?? {}),
  };
  return {
    ...base,
    ...overlay,
    ...(hasKeys(streamOptions) ? { streamOptions } : {}),
    ...(hasKeys(openrouter) ? { openrouter } : {}),
    ...(hasKeys(anthropic) ? { anthropic } : {}),
  };
}

/** Clone mutable model metadata before applying Recipe-local configuration. */
export function cloneModelForRecipe<T extends Model<any>>(model: T): T {
  return {
    ...model,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}

/** Apply provider routing and header options onto a pi-ai model instance. */
export function applyRecipeAgentModelConfigToModel<T extends Model<any>>(
  model: T,
  config: RecipeAgentModelConfig | undefined
): T {
  if (!config) return model;
  if (config.openrouter) {
    model.compat = {
      ...(model.compat ?? {}),
      openRouterRouting: config.openrouter,
    };
  }
  if (config.anthropic?.betas?.length) {
    const existing = model.headers?.["anthropic-beta"]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const betas = [
      ...new Set([...(existing ?? []), ...config.anthropic.betas]),
    ];
    model.headers = {
      ...(model.headers ?? {}),
      "anthropic-beta": betas.join(","),
    };
  }
  return model;
}

function mergeStreamOptions(
  current: SimpleStreamOptions | undefined,
  configured: RecipeAgentModelStreamOptions | undefined
): SimpleStreamOptions | undefined {
  if (!configured || Object.keys(configured).length === 0) return current;
  return {
    ...(current ?? {}),
    ...configured,
  };
}

function withAnthropicContextManagement(
  payload: unknown,
  model: Model<any>,
  config: RecipeAgentModelConfig
): unknown {
  const contextManagement = config.anthropic?.contextManagement;
  if (contextManagement === undefined) return payload;
  if (model.api !== "anthropic-messages") return payload;
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    context_management: contextManagement,
  };
}

/**
 * Apply stream options and Anthropic context management onto a live agent
 * session. Wraps the session's stream function and payload hook; safe to call
 * once per session.
 */
export function applyRecipeAgentModelConfigToSession(
  session: AgentSession,
  config: RecipeAgentModelConfig | undefined
): void {
  if (!config) return;

  if (config.streamOptions) {
    const baseStreamFn = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) =>
      baseStreamFn(
        model,
        context,
        mergeStreamOptions(options, config.streamOptions)
      );
  }

  if (config.anthropic?.contextManagement !== undefined) {
    const previousOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      const nextPayload = withAnthropicContextManagement(
        payload,
        model,
        config
      );
      const previousResult = previousOnPayload
        ? await previousOnPayload(nextPayload, model)
        : undefined;
      return previousResult === undefined ? nextPayload : previousResult;
    };
  }
}
