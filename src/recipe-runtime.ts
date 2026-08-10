const RUNTIME_KEYS = new Set([
  "steering_mode",
  "follow_up_mode",
  "tool_execution",
  "retry",
  "compaction",
  "branch_summary",
  "images",
]);

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export type RecipeQueueMode = "all" | "one-at-a-time";
export type RecipeToolExecutionMode = "parallel" | "sequential";

export interface RecipeAgentRuntimeConfig {
  steeringMode?: RecipeQueueMode;
  followUpMode?: RecipeQueueMode;
  toolExecution?: RecipeToolExecutionMode;
  settings?: Record<string, unknown>;
}

export class RecipeRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeRuntimeConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase()
  );
}

function normalizeObject(context: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RecipeRuntimeConfigError(`${context}: expected object`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SNAKE_CASE_KEY.test(key)) {
      throw new RecipeRuntimeConfigError(
        `${context} has non-snake_case key "${key}"`
      );
    }
    normalized[snakeToCamel(key)] = isRecord(child)
      ? normalizeObject(`${context}.${key}`, child)
      : child;
  }
  return normalized;
}

function parseQueueMode(
  context: string,
  key: string,
  value: unknown
): RecipeQueueMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "all" && value !== "one-at-a-time") {
    throw new RecipeRuntimeConfigError(
      `${context} has invalid runtime.${key}: expected all or one-at-a-time`
    );
  }
  return value;
}

export function parseRecipeAgentRuntimeConfig(
  context: string,
  value: unknown
): RecipeAgentRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecipeRuntimeConfigError(
      `${context} has invalid runtime: expected object`
    );
  }
  const unknown = Object.keys(value).filter((key) => !RUNTIME_KEYS.has(key));
  if (unknown.length > 0) {
    throw new RecipeRuntimeConfigError(
      `${context} has unsupported runtime key(s): ${unknown.join(", ")}`
    );
  }

  const steeringMode = parseQueueMode(
    context,
    "steering_mode",
    value.steering_mode
  );
  const followUpMode = parseQueueMode(
    context,
    "follow_up_mode",
    value.follow_up_mode
  );
  const toolExecution = value.tool_execution;
  if (
    toolExecution !== undefined &&
    toolExecution !== "parallel" &&
    toolExecution !== "sequential"
  ) {
    throw new RecipeRuntimeConfigError(
      `${context} has invalid runtime.tool_execution: expected parallel or sequential`
    );
  }

  const settings: Record<string, unknown> = {
    ...(steeringMode ? { steeringMode } : {}),
    ...(followUpMode ? { followUpMode } : {}),
  };
  for (const key of ["retry", "compaction", "branch_summary", "images"] as const) {
    if (value[key] === undefined) continue;
    settings[snakeToCamel(key)] = normalizeObject(
      `${context} runtime.${key}`,
      value[key]
    );
  }

  return {
    ...(steeringMode ? { steeringMode } : {}),
    ...(followUpMode ? { followUpMode } : {}),
    ...(toolExecution ? { toolExecution } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

export function mergeRecipeAgentRuntimeConfig(
  base: RecipeAgentRuntimeConfig | undefined,
  overlay: RecipeAgentRuntimeConfig | undefined
): RecipeAgentRuntimeConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const settings = mergeObjects(base.settings ?? {}, overlay.settings ?? {});
  return {
    ...base,
    ...overlay,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

function mergeObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? mergeObjects(merged[key], value)
      : value;
  }
  return merged;
}
