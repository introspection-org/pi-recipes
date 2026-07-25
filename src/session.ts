import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createAgentTool, type AgentRunController } from "./agent-tool.js";
import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "./mcp-catalog.js";
import {
  clearMcpSession,
  configureMcpLocalConfigPath,
  materializeMcpSession,
  materializeSessionMcpCli,
  resolveAgentMcpSelections,
  stopMcpDaemon,
  type McpLocalConfig,
  type ScopedMcpToolSelection,
} from "./mcp.js";
import { expectedProviderEnvVars } from "./provider-env.js";
import { loadRecipeExtensionFactory } from "./recipe-extensions.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
} from "./recipe-model.js";
import { resolveRecipe, type ResolvedRecipe } from "./recipe/resolve.js";
import { instrumentRecipeSession } from "./tracing.js";

export { expectedProviderEnvVars } from "./provider-env.js";

/**
 * Everything between "resolved recipe" and "live Pi session", done once:
 * model construction and credentials, MCP materialization, skills /
 * extensions / system-prompt wiring, subagent tool registration.
 *
 * Fails closed at construction: recipe resolution errors propagate, a
 * `required: true` MCP server with no binding throws `McpBindingError`, and a
 * model whose provider has no credential throws `RecipeCredentialError`.
 */
export interface CreateRecipeSessionOptions {
  recipeDir: string;
  /** Default: `agents/agent.yaml`, else the recipe's single-agent rule. */
  agentName?: string;
  /** Agent workspace. Default: `process.cwd()`. */
  cwd?: string;
  /** Model credentials. Default: derived from provider env keys. */
  credentials?: CredentialStore;
  /** Override the recipe's `<provider>/<model_id>` spec. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Explicit local MCP binding file. Default: `<cwd|recipeDir>/.pi/mcp.local.json`. */
  mcpBindingsPath?: string;
  /** Inline MCP bindings, for hosts that synthesize them instead of reading a file. */
  mcpBindings?: McpLocalConfig;
  /**
   * MCP materialization mode. "materialize" (default) resolves bindings and
   * prepares the session MCP runtime in `env`; "inherit" trusts that the host
   * process already materialized a session covering this agent's servers
   * (subagent sessions run this way).
   */
  mcpMode?: "materialize" | "inherit";
  /** `${VAR}` resolution source and MCP runtime environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default: `SessionManager.inMemory(cwd)`. */
  sessionManager?: SessionManager;
  /** Host-owned settings (compaction, retry). Default: `SettingsManager.create(cwd, recipeDir)`. */
  settingsManager?: SettingsManager;
  /** Host extensions appended after the recipe's own extensions. */
  extensionFactories?: ExtensionFactory[];
  /**
   * Subagent run controller. Default: an in-process controller spawning
   * children through this same rung. Pass `null` to disable the `agent` tool
   * even when the recipe declares subagents.
   */
  runController?: AgentRunController | null;
  /** Bounds for the default in-process subagent controller. */
  subagentLimits?: { concurrency?: number; depth?: number };
  /** Extra skill roots beyond the recipe's. */
  additionalSkillPaths?: string[];
  /** Post-resolution system prompt hook. */
  systemPrompt?: (resolved: string) => string;
  /** Tap on `session.subscribe`, detached at dispose. */
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * Span identity when recipe telemetry is initialized (see
   * `initRecipeTelemetry`): `conversation_id` groups this session's gen_ai
   * spans. Default: a fresh UUID per session.
   */
  telemetry?: { conversationId?: string };
}

export interface RecipeSessionHandle {
  /** The live Pi session: prompt / steer / followUp / abort / subscribe. */
  session: AgentSession;
  recipe: ResolvedRecipe;
  /** The subagent run controller serving this session's `agent` tool. */
  runs: AgentRunController;
  /** Abort any in-flight turn, dispose the session, stop session MCP. */
  dispose(): Promise<void>;
}

/** The session model's provider has no resolvable credential. */
export class RecipeCredentialError extends Error {
  override readonly name = "RecipeCredentialError";

  constructor(
    readonly provider: string,
    /** Env vars that would satisfy the provider, most conventional first. */
    readonly expectedEnvVars: readonly string[]
  ) {
    super(
      `No credential for model provider "${provider}": set ${expectedEnvVars.join(" or ")}, or pass a CredentialStore via credentials`
    );
  }
}

/** The recipe's model spec does not resolve to a known model. */
export class RecipeModelError extends Error {
  override readonly name = "RecipeModelError";

  constructor(readonly modelSpec: string) {
    super(`Recipe model is not available: ${modelSpec}`);
  }
}

function parseModelSpec(spec: string): {
  provider: string;
  modelId: string;
  lookupProvider: string;
} {
  const slash = spec.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`
    );
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const lookupProvider = provider === "gemini" ? "google" : provider;
  return { provider, modelId, lookupProvider };
}

/**
 * Ambient-credential providers resolve from their own SDK chain (AWS
 * profiles, ADC); `getEnvApiKey` reports them as "<authenticated>".
 */
const AMBIENT_CREDENTIAL_SENTINEL = "<authenticated>";

/**
 * Resolve credentials fail-closed against the session's own `env`, never the
 * ambient process env: explicit store → per-provider env keys → error.
 */
async function resolveCredentialStore(
  lookupProvider: string,
  opts: CreateRecipeSessionOptions
): Promise<CredentialStore> {
  if (opts.credentials) {
    const stored = await opts.credentials.read(lookupProvider);
    if (!stored) {
      throw new RecipeCredentialError(
        lookupProvider,
        expectedProviderEnvVars(lookupProvider)
      );
    }
    return opts.credentials;
  }

  const env = opts.env ?? process.env;
  const store = new InMemoryCredentialStore();
  const apiKey =
    getEnvApiKey(lookupProvider, env as Record<string, string>) ??
    env[`${lookupProvider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
  if (!apiKey) {
    throw new RecipeCredentialError(
      lookupProvider,
      expectedProviderEnvVars(lookupProvider)
    );
  }
  if (apiKey !== AMBIENT_CREDENTIAL_SENTINEL) {
    await store.modify(lookupProvider, async () => ({
      type: "api_key",
      key: apiKey,
    }));
  }
  // Ambient-credential providers (Bedrock, Vertex ADC) keep an empty store;
  // the pi-ai provider resolves its own credential chain at stream time.
  return store;
}

function scopedMcpSelections(recipe: ResolvedRecipe): ScopedMcpToolSelection[] {
  return [recipe.agent, ...recipe.subagents.values()].flatMap((agent) =>
    resolveAgentMcpSelections(agent.mcp)
  );
}

interface MaterializedSessionMcp {
  materialized: boolean;
}

/**
 * Everything `createRecipeSession` fail-closes on, without creating a
 * session or starting MCP: recipe resolution, model lookup, credentials.
 * Hosts with a boot phase (the serve layer) run this once to fail fast.
 */
export async function preflightRecipeSession(
  opts: CreateRecipeSessionOptions
): Promise<ResolvedRecipe> {
  const recipe = resolveRecipe({
    recipeDir: opts.recipeDir,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
  });
  const modelSpec = opts.model ?? recipe.modelSpec;
  const { lookupProvider, modelId } = parseModelSpec(modelSpec);
  const credentials = await resolveCredentialStore(lookupProvider, opts);
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
  });
  const model =
    modelRuntime.getModel(lookupProvider, modelId) ??
    (getModel(lookupProvider as never, modelId as never) as
      | Model<any>
      | undefined);
  if (!model) {
    throw new RecipeModelError(modelSpec);
  }
  return recipe;
}

/**
 * Materialize the session MCP runtime for a recipe scope into `env` at
 * `cwd`. Exposed for hosts that materialize once per process (the serve
 * layer) and create their sessions with `mcpMode: "inherit"`.
 */
export async function materializeRecipeSessionMcp(
  recipe: ResolvedRecipe,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: Pick<
    CreateRecipeSessionOptions,
    "mcpBindings" | "mcpBindingsPath" | "mcpMode"
  > = {}
): Promise<{ materialized: boolean }> {
  return configureSessionMcp(recipe, cwd, env, {
    recipeDir: recipe.recipeDir,
    ...opts,
  });
}

async function configureSessionMcp(
  recipe: ResolvedRecipe,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: CreateRecipeSessionOptions
): Promise<MaterializedSessionMcp> {
  const selections = scopedMcpSelections(recipe);
  if (opts.mcpMode === "inherit") return { materialized: false };
  if (selections.length === 0) {
    await clearMcpSession(env, cwd);
    return { materialized: false };
  }

  if (opts.mcpBindingsPath) {
    env.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
  } else if (!opts.mcpBindings) {
    configureMcpLocalConfigPath({ cwd, recipeDir: recipe.recipeDir, env });
  }
  const [, session] = await Promise.all([
    materializeSessionMcpCli({ cwd, env }),
    materializeMcpSession({
      cwd,
      manifest: recipe.manifest,
      agentMcp: selections,
      env,
      ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
    }),
  ]);
  if (session.servers.length > 0) {
    // Warm tool catalogs in the background; sessions work without the warmup.
    void preloadMcpCatalogs({ env }).catch(() => {});
  }
  return { materialized: true };
}

export async function createRecipeSession(
  opts: CreateRecipeSessionOptions
): Promise<RecipeSessionHandle> {
  const recipe = resolveRecipe({
    recipeDir: opts.recipeDir,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
  });
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // Model + credentials, fail-closed before any MCP runtime starts.
  const modelSpec = opts.model ?? recipe.modelSpec;
  const { lookupProvider, modelId } = parseModelSpec(modelSpec);
  const credentials = await resolveCredentialStore(lookupProvider, opts);
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const model: Model<any> | undefined =
    modelRuntime.getModel(lookupProvider, modelId) ??
    (getModel(lookupProvider as never, modelId as never) as Model<any> | undefined);
  if (!model) {
    throw new RecipeModelError(modelSpec);
  }
  applyRecipeAgentModelConfigToModel(model, recipe.modelConfig);

  const mcp = await configureSessionMcp(recipe, cwd, env, opts);

  // Recipe extensions load through the shared jiti loader; host extensions
  // append after them, matching the Pi extension host's ordering.
  const inlineExtensions: InlineExtension[] = [];
  for (const extensionPath of recipe.extensionPaths) {
    inlineExtensions.push(
      await loadRecipeExtensionFactory(recipe.recipeDir, extensionPath)
    );
  }
  inlineExtensions.push(...(opts.extensionFactories ?? []));

  const services = await createAgentSessionServices({
    cwd,
    agentDir: recipe.recipeDir,
    modelRuntime,
    settingsManager:
      opts.settingsManager ?? SettingsManager.create(cwd, recipe.recipeDir),
    resourceLoaderOptions: {
      noSkills: true,
      additionalSkillPaths: [
        ...recipe.skillPaths,
        ...(opts.additionalSkillPaths ?? []),
      ],
      additionalPromptTemplatePaths: recipe.promptPaths,
      extensionFactories: inlineExtensions,
      systemPromptOverride: (base) => {
        const resolved = recipe.systemPromptOverride(base);
        return opts.systemPrompt ? opts.systemPrompt(resolved ?? "") : resolved;
      },
    },
  });

  // Subagents: the shared `agent` tool against an injected or in-process
  // controller. `runController: null` disables delegation outright.
  const wantsSubagents =
    recipe.subagents.size > 0 && opts.runController !== null;
  let runs: AgentRunController;
  if (opts.runController) {
    runs = opts.runController;
  } else {
    const { createInProcessRunController, inertRunController } = await import(
      "./run-controller.js"
    );
    runs = wantsSubagents
      ? createInProcessRunController({
          recipeDir: recipe.recipeDir,
          cwd,
          env,
          ...(opts.credentials ? { credentials: opts.credentials } : {}),
          concurrency: opts.subagentLimits?.concurrency,
          depth: opts.subagentLimits?.depth,
        })
      : inertRunController();
  }
  const tools = wantsSubagents
    ? recipe.tools
    : recipe.tools.filter((tool) => tool !== "agent");
  const customTools = wantsSubagents
    ? [createAgentTool(runs, recipe.subagents)]
    : [];

  const created = await createAgentSessionFromServices({
    services,
    sessionManager: opts.sessionManager ?? SessionManager.inMemory(cwd),
    model,
    ...(opts.thinkingLevel ?? recipe.thinkingLevel
      ? { thinkingLevel: (opts.thinkingLevel ?? recipe.thinkingLevel)! }
      : {}),
    tools,
    customTools,
  });
  const session = created.session;
  applyRecipeAgentModelConfigToSession(session, recipe.modelConfig);
  await session.bindExtensions({});

  const unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : undefined;

  // GenAI-semconv spans when the host initialized recipe telemetry (or its
  // own global provider is registered through instrumentRecipeSession).
  const detachTelemetry = instrumentRecipeSession(session, {
    meta: {
      conversationId: opts.telemetry?.conversationId ?? randomUUID(),
      agentId: `${recipe.manifest.name}/${recipe.agentName}`,
      agentName: recipe.agentName,
    },
  });

  let disposed = false;
  return {
    session,
    recipe,
    runs,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      try {
        await runs.list().reduce(async (prev, run) => {
          await prev;
          if (run.status === "running") {
            await runs.close(run.agent_run_id).catch(() => {});
          }
        }, Promise.resolve());
      } catch {
        // Child teardown is best-effort; the session still disposes.
      }
      try {
        await session.abort();
      } catch {
        // An idle session has nothing to abort.
      }
      session.dispose();
      detachTelemetry?.();
      if (mcp.materialized) {
        clearMcpCatalogPreload(env);
        await stopMcpDaemon(env);
      }
    },
  };
}
