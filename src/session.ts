import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
  type AgentSessionRuntimeDiagnostic,
  type EventBus,
  type ExtensionFactory,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  instrumentSession,
  type AgentMeta,
  type InstrumentSessionOptions,
} from "@introspection-sdk/introspection-pi";
import { createAgentTool, type AgentRunController } from "./agent-tool.js";
import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "./mcp-catalog.js";
import {
  createIsolatedMcpEnvironment,
  configureMcpLocalConfigPath,
  isolateMcpEnvironment,
  materializeMcpSession,
  materializeSessionMcpCli,
  readMcpSessionConfig,
  restoreMcpEnvironment,
  resolveAgentMcpSelections,
  snapshotMcpEnvironment,
  stopMcpDaemon,
  type McpLocalConfig,
  type ScopedMcpToolSelection,
} from "./mcp.js";
import { createMcpToolSet } from "./mcp-tools.js";
import { expectedProviderEnvVars } from "./provider-env.js";
import { loadRecipeExtensionFactory } from "./recipe-extensions.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
} from "./recipe-model.js";
import {
  resolveRecipeAgent,
  resolveRecipe,
  type ResolvedRecipeAgent,
  type ResolvedRecipe,
} from "./recipe/resolve.js";

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
export interface CreateAgentSessionFromRecipeOptions {
  recipeDir: string;
  /** Default: `agents/agent.yaml`, else the recipe's single-agent rule. */
  agentName?: string;
  /** Agent workspace. Default: `process.cwd()`. */
  cwd?: string;
  /** Model credentials. Default: derived from provider env keys. */
  credentials?: CredentialStore;
  /** Override the recipe's `<provider>/<model_id>` spec. */
  model?: string;
  /**
   * Host-constructed model transport. The recipe still owns its model
   * configuration; this replaces only catalog lookup and transport wiring.
   */
  modelOverride?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Explicit local MCP binding file. Default: `<cwd|recipeDir>/.pi/mcp.local.json`. */
  mcpBindingsPath?: string;
  /** Inline MCP bindings, for hosts that synthesize them instead of reading a file. */
  mcpBindings?: McpLocalConfig;
  /**
   * MCP provisioning owner. "session" (default) resolves bindings and
   * prepares the session MCP runtime in `env`; "host" trusts that the host
   * already materialized a runtime covering exactly this agent's policy.
   */
  mcpProvisioning?: "session" | "host";
  /** `${VAR}` resolution source and MCP runtime environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default: `SessionManager.inMemory(cwd)`. */
  sessionManager?: SessionManager;
  /** Host-owned settings (compaction, retry). Default: `SettingsManager.create(cwd, recipeDir)`. */
  settingsManager?: SettingsManager;
  /** Host extensions appended after the recipe's own extensions. */
  extensionFactories?: ExtensionFactory[];
  /** Host event bus shared with the surrounding application. */
  eventBus?: EventBus;
  /** Host-owned tools. Recipe tool selection still decides which names are live. */
  customTools?: ToolDefinition[];
  /**
   * Subagent run controller. Default: an in-process controller spawning
   * child Recipe sessions. Pass `null` to disable the `agent` tool
   * even when the recipe declares subagents.
   */
  runController?: AgentRunController | null;
  /** Host hooks for the shared `agent` tool UI contract. */
  agentToolOptions?: {
    acknowledgeCompletions?(ids: readonly string[]): void;
  };
  /** Concurrency bound for the default in-process subagent controller. */
  subagentLimits?: { concurrency?: number };
  /** Extra skill roots beyond the recipe's. */
  additionalSkillPaths?: string[];
  /** Replace the recipe's resolved skill roots with host-materialized roots. */
  skillPaths?: string[];
  /** Post-resolution system prompt hook. */
  systemPrompt?: (resolved: string) => string;
  /** Observe Pi resource diagnostics during construction. */
  onDiagnostics?: (diagnostics: AgentSessionRuntimeDiagnostic[]) => void;
  /** Tap on `session.subscribe`, detached at dispose. */
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * Attach GenAI semantic-convention instrumentation with a host-owned OTel
   * tracer. Recipes creates no provider, processor, exporter, or global
   * context; those remain the host's responsibility.
   */
  otel?: RecipeSessionOtelOptions;
}

export interface RecipeSessionOtelOptions
  extends Omit<InstrumentSessionOptions, "meta"> {
  /**
   * Span identity. Missing fields derive from the resolved Recipe; a fresh
   * conversation id is generated per session by default.
   */
  meta?: Partial<AgentMeta>;
}

export interface RecipeSessionHandle {
  /** The live Pi session: prompt / steer / followUp / abort / subscribe. */
  session: AgentSession;
  /** The selected executable agent plan used to create this session. */
  agent: ResolvedRecipeAgent;
  /** The subagent run controller serving this session's `agent` tool. */
  runs: AgentRunController;
  /** Abort any in-flight turn, dispose the session, stop session MCP. */
  dispose(): Promise<void>;
}

/**
 * Host injections for an already-resolved Recipe.
 *
 * Use this with `createAgentSession()` when a host must inspect
 * the portable definition before materializing credentials, endpoints, or
 * other host resources. The exact inspected definition is then used for
 * construction without resolving the package a second time.
 */
export type CreateAgentSessionOptions = Omit<
  CreateAgentSessionFromRecipeOptions,
  "recipeDir" | "agentName"
> & {
  /**
   * The resolved Recipe that produced `agent`. Required by the default in-process
   * controller so child sessions use the exact same resolved source.
   */
  recipe?: ResolvedRecipe;
};

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

type MutableAgentSession = {
  agent?: { state?: { tools?: Array<{ parameters?: unknown }> } };
};

type SchemaPosition = "schema" | "schema-map" | "literal";

function schemaChildPosition(
  position: SchemaPosition,
  key: PropertyKey
): SchemaPosition {
  if (position === "schema-map") return "schema";
  if (position === "literal") return "literal";
  if (
    key === "properties" ||
    key === "patternProperties" ||
    key === "$defs" ||
    key === "definitions" ||
    key === "dependentSchemas"
  ) {
    return "schema-map";
  }
  if (
    key === "default" ||
    key === "const" ||
    key === "examples" ||
    key === "enum"
  ) {
    return "literal";
  }
  return "schema";
}

function stripAdditionalProperties(
  value: unknown,
  position: SchemaPosition = "schema"
): unknown {
  if (value === null || typeof value !== "object") return value;
  const clone: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (position === "schema" && key === "additionalProperties") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      descriptor.value = stripAdditionalProperties(
        descriptor.value,
        schemaChildPosition(position, key)
      );
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

/**
 * Gemini rejects JSON Schema's `additionalProperties` keyword in tool
 * declarations. Normalize the final Recipe toolset after host tools and the
 * shared agent tool have been registered so every host gets the same behavior.
 */
function normalizeSessionToolsForModel(
  session: AgentSession,
  model: Model<any>
): void {
  const isGemini = [model.id, model.name].some((value) =>
    value?.toLowerCase().includes("gemini")
  );
  if (!isGemini) return;
  const mutableSession = session as MutableAgentSession;
  for (const tool of mutableSession.agent?.state?.tools ?? []) {
    tool.parameters = stripAdditionalProperties(tool.parameters);
  }
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
  opts: CreateAgentSessionFromRecipeOptions
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

function scopedMcpSelections(recipe: ResolvedRecipeAgent): ScopedMcpToolSelection[] {
  return resolveAgentMcpSelections(recipe.mcp);
}

interface MaterializedSessionMcp {
  materialized: boolean;
  tools?: ToolDefinition[];
  initialActiveToolNames?: string[];
  searchToolName?: string;
  release?: () => Promise<void>;
}

const leasedMcpEnvironments = new WeakSet<NodeJS.ProcessEnv>();

export class RecipeMcpEnvironmentInUseError extends Error {
  override readonly name = "RecipeMcpEnvironmentInUseError";

  constructor() {
    super(
      "This environment already belongs to a live materialized Recipe MCP session; use a separate env object per concurrent session or let the host materialize MCP once and pass mcpProvisioning: \"host\""
    );
  }
}

/**
 * Everything `createAgentSessionFromRecipe` fail-closes on, without creating a
 * session or starting MCP: recipe resolution, model lookup, credentials.
 * Hosts with a boot phase can run this once to fail fast.
 */
export async function preflightRecipeSession(
  opts: CreateAgentSessionFromRecipeOptions
): Promise<ResolvedRecipeAgent> {
  const recipe = resolveRecipeAgent({
    recipeDir: opts.recipeDir,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
  });
  const modelSpec = opts.model ?? recipe.modelSpec;
  const { lookupProvider, modelId } = parseModelSpec(modelSpec);
  const credentialProvider = opts.modelOverride?.provider ?? lookupProvider;
  const credentials = await resolveCredentialStore(credentialProvider, opts);
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
  });
  const model =
    opts.modelOverride ??
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
 * `cwd`. Exposed for hosts that materialize once per process and create their
 * sessions with `mcpProvisioning: "host"`.
 */
export async function materializeRecipeSessionMcp(
  recipe: ResolvedRecipeAgent,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: Pick<
    CreateAgentSessionFromRecipeOptions,
    "mcpBindings" | "mcpBindingsPath"
  > = {}
): Promise<{ materialized: boolean }> {
  const selections = scopedMcpSelections(recipe);
  if (selections.length === 0) return { materialized: false };
  if (opts.mcpBindingsPath) {
    env.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
  } else if (!opts.mcpBindings) {
    configureMcpLocalConfigPath({ cwd, recipeDir: recipe.recipeDir, env });
  }
  if (recipe.mcp?.mode === "cli") {
    await materializeSessionMcpCli({ cwd, env });
  }
  await materializeMcpSession({
    cwd,
    manifest: recipe.manifest,
    agentMcp: selections,
    env,
    ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
  });
  return { materialized: true };
}

async function configureSessionMcp(
  recipe: ResolvedRecipeAgent,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: CreateAgentSessionFromRecipeOptions,
  activation: {
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
  }
): Promise<MaterializedSessionMcp> {
  const selections = scopedMcpSelections(recipe);
  if (selections.length === 0) return { materialized: false };
  const mode = recipe.mcp?.mode ?? "cli";
  const hostProvisioned = opts.mcpProvisioning === "host";
  const snapshot =
    !hostProvisioned && mode === "cli"
      ? snapshotMcpEnvironment(env)
      : undefined;
  let runtimeEnv = env;
  let privateDirectory: string | undefined;
  let privateMcporterConfigPath: string | undefined;

  if (snapshot) {
    if (leasedMcpEnvironments.has(env)) {
      throw new RecipeMcpEnvironmentInUseError();
    }
    leasedMcpEnvironments.add(env);
    isolateMcpEnvironment(env);
  }

  const release = async () => {
    if (hostProvisioned) return;
    clearMcpCatalogPreload(runtimeEnv);
    await stopMcpDaemon(runtimeEnv);
    if (privateDirectory) {
      await rm(privateDirectory, { recursive: true, force: true });
    }
    if (snapshot) {
      restoreMcpEnvironment(env, snapshot);
      leasedMcpEnvironments.delete(env);
    }
  };

  try {
    if (!hostProvisioned && mode === "tools") {
      const isolated = await createIsolatedMcpEnvironment(env);
      runtimeEnv = isolated.env;
      privateDirectory = isolated.directory;
      privateMcporterConfigPath = isolated.mcporterConfigPath;
    }

    let session;
    if (hostProvisioned) {
      session = readMcpSessionConfig(cwd, runtimeEnv);
    } else {
      if (opts.mcpBindingsPath) {
        runtimeEnv.PI_RECIPES_MCP_LOCAL_CONFIG = opts.mcpBindingsPath;
      } else if (!opts.mcpBindings) {
        configureMcpLocalConfigPath({
          cwd,
          recipeDir: recipe.recipeDir,
          env: runtimeEnv,
        });
      }
      if (mode === "cli") {
        await materializeSessionMcpCli({ cwd, env: runtimeEnv });
      }
      session = await materializeMcpSession({
        cwd,
        manifest: recipe.manifest,
        agentMcp: selections,
        env: runtimeEnv,
        ...(opts.mcpBindings ? { localConfig: opts.mcpBindings } : {}),
        ...(privateMcporterConfigPath
          ? { mcporterConfigPath: privateMcporterConfigPath }
          : {}),
      });
    }

    if (mode === "tools") {
      const catalogs =
        session.servers.length > 0
          ? await preloadMcpCatalogs({
              env: runtimeEnv,
              allowPartial: true,
            })
          : [];
      const materialized = createMcpToolSet({
        session,
        catalogs,
        mcp: recipe.mcp!,
        env: runtimeEnv,
        activation,
      });
      return {
        materialized: !hostProvisioned,
        tools: materialized.tools,
        initialActiveToolNames: materialized.initialActiveToolNames,
        ...(materialized.searchToolName
          ? { searchToolName: materialized.searchToolName }
          : {}),
        release,
      };
    }

    if (session.servers.length > 0) {
      // Warm tool catalogs in the background; sessions work without the warmup.
      void preloadMcpCatalogs({ env: runtimeEnv }).catch(() => {});
    }
    return {
      materialized: !hostProvisioned,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function createSessionForAgent(
  recipe: ResolvedRecipeAgent,
  opts: CreateAgentSessionFromRecipeOptions & { recipe?: ResolvedRecipe }
): Promise<RecipeSessionHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const otel = opts.otel
    ? {
        ...opts.otel,
        meta: {
          conversationId: opts.otel.meta?.conversationId ?? randomUUID(),
          agentId:
            opts.otel.meta?.agentId ??
            `${recipe.manifest.name}/${recipe.name}`,
          agentName: opts.otel.meta?.agentName ?? recipe.name,
        },
      }
    : undefined;

  // Model + credentials, fail-closed before any MCP runtime starts.
  const modelSpec = opts.model ?? recipe.modelSpec;
  const { lookupProvider, modelId } = parseModelSpec(modelSpec);
  const credentialProvider = opts.modelOverride?.provider ?? lookupProvider;
  const credentials = await resolveCredentialStore(credentialProvider, opts);
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const model: Model<any> | undefined =
    opts.modelOverride ??
    modelRuntime.getModel(lookupProvider, modelId) ??
    (getModel(lookupProvider as never, modelId as never) as Model<any> | undefined);
  if (!model) {
    throw new RecipeModelError(modelSpec);
  }
  applyRecipeAgentModelConfigToModel(model, recipe.modelConfig);

  let session: AgentSession | undefined;
  let runs: AgentRunController | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachInstrumentation: (() => void) | undefined;
  const mcp = await configureSessionMcp(recipe, cwd, env, opts, {
    getActiveTools: () => session?.getActiveToolNames() ?? [],
    setActiveTools: (names) => session?.setActiveToolsByName(names),
  });

  const cleanup = async (): Promise<void> => {
    try {
      unsubscribe?.();
    } catch {
      // Continue releasing the remaining session-owned resources.
    }
    unsubscribe = undefined;
    if (runs) {
      try {
        await runs.shutdown();
      } catch {
        // Child teardown is best-effort; the session still disposes.
      }
    }
    if (session) {
      try {
        await session.abort();
      } catch {
        // An idle session has nothing to abort.
      }
      try {
        session.dispose();
      } catch {
        // Continue releasing instrumentation and MCP state.
      }
      session = undefined;
    }
    try {
      detachInstrumentation?.();
    } catch {
      // Continue releasing MCP state.
    }
    detachInstrumentation = undefined;
    await mcp.release?.();
  };

  try {
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
        eventBus: opts.eventBus,
        noSkills: true,
        additionalSkillPaths: [
          ...(opts.skillPaths ?? recipe.skillPaths),
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
    opts.onDiagnostics?.(services.diagnostics);

    // Subagents: the shared `agent` tool against an injected or in-process
    // controller. `runController: null` disables delegation outright.
    const wantsSubagents =
      recipe.subagents.size > 0 && opts.runController !== null;
    if (opts.runController) {
      runs = opts.runController;
    } else {
      const { createInProcessRunController, inertRunController } = await import(
        "./run-controller.js"
      );
      runs = wantsSubagents
        ? createInProcessRunController({
            recipe: opts.recipe!,
            cwd,
            env,
            ...(opts.credentials ? { credentials: opts.credentials } : {}),
            concurrency: opts.subagentLimits?.concurrency,
            ...(otel ? { otel } : {}),
          })
        : inertRunController();
    }
    const tools = wantsSubagents
      ? recipe.tools
      : recipe.tools.filter((tool) => tool !== "agent");
    const mcpToolNames = mcp.tools?.map((tool) => tool.name) ?? [];
    const occupiedToolNames = new Set([
      ...tools,
      ...(opts.customTools ?? []).map((tool) => tool.name),
      ...(wantsSubagents ? ["agent"] : []),
    ]);
    const collisions = mcpToolNames.filter((name) =>
      occupiedToolNames.has(name)
    );
    if (collisions.length > 0) {
      throw new Error(
        `Recipe MCP tool name collision: ${collisions.join(", ")}`
      );
    }
    const selectedToolNames = [...tools, ...mcpToolNames];
    const customTools = [
      ...(opts.customTools ?? []),
      ...(wantsSubagents
        ? [createAgentTool(runs, recipe.subagents, opts.agentToolOptions)]
        : []),
      ...(mcp.tools ?? []),
    ];

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: opts.sessionManager ?? SessionManager.inMemory(cwd),
      model,
      ...(opts.thinkingLevel ?? recipe.thinkingLevel
        ? { thinkingLevel: (opts.thinkingLevel ?? recipe.thinkingLevel)! }
        : {}),
      tools: selectedToolNames,
      customTools,
    });
    session = created.session;
    normalizeSessionToolsForModel(session, model);
    applyRecipeAgentModelConfigToSession(session, recipe.modelConfig);
    await session.bindExtensions({});
    if (mcp.tools) {
      const registered = new Set(
        session.getAllTools().map((tool) => tool.name)
      );
      const missingRegistered = mcpToolNames.filter(
        (name) => !registered.has(name)
      );
      if (missingRegistered.length > 0) {
        throw new Error(
          `Pi did not register Recipe MCP tool(s): ${missingRegistered.join(", ")}`
        );
      }
      const activeTools = [
        ...tools,
        ...(mcp.initialActiveToolNames ?? []),
        ...(mcp.searchToolName ? [mcp.searchToolName] : []),
      ];
      session.setActiveToolsByName(activeTools);
      const applied = new Set(session.getActiveToolNames());
      const missing = activeTools.filter((name) => !applied.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Pi did not activate Recipe tool(s): ${missing.join(", ")}`
        );
      }
    }

    unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : undefined;
    detachInstrumentation = otel
      ? instrumentSession(session, otel).detach
      : undefined;

    const liveSession = session;
    const liveRuns = runs;
    let disposed = false;
    return {
      session: liveSession,
      agent: recipe,
      runs: liveRuns,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function createAgentSessionFromRecipe(
  opts: CreateAgentSessionFromRecipeOptions
): Promise<RecipeSessionHandle> {
  const resolvedRecipe = resolveRecipe({ recipeDir: opts.recipeDir });
  const recipe = resolvedRecipe.selectAgent(opts.agentName);
  return createSessionForAgent(recipe, { ...opts, recipe: resolvedRecipe });
}

export async function createAgentSession(
  agent: ResolvedRecipeAgent,
  opts: CreateAgentSessionOptions
): Promise<RecipeSessionHandle> {
  if (opts.recipe && opts.recipe.selectAgent(agent.name) !== agent) {
    throw new Error(
      `Resolved agent "${agent.name}" does not belong to the supplied ResolvedRecipe`
    );
  }
  if (
    agent.subagents.size > 0 &&
    opts.runController === undefined &&
    !opts.recipe
  ) {
    throw new Error(
      "createAgentSession requires its ResolvedRecipe when using the default subagent controller"
    );
  }
  return createSessionForAgent(agent, {
    ...opts,
    recipeDir: agent.recipeDir,
    agentName: agent.name,
  });
}
