import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createRecipeChildAgentRunner,
  promptResultText,
  type RecipeChildToolEvent,
} from "./child-agent.js";
import {
  ChildAgentRunStore,
  type ChildRunSnapshot,
  type ChildToolActivity,
} from "./child-agent-store.js";
import {
  ChildCompletionQueue,
  envelopeFromRun,
  renderCompletionNotice,
  type ChildCompletionEnvelope,
} from "./child-agent-completions.js";
import {
  clearMcpSession,
  configureMcpLocalConfigPath,
  formatMcpConfigurationDiagnostics,
  materializeMcpSession,
  materializeSessionMcpCli,
  resolveAgentMcpSelections,
  stopMcpDaemon,
} from "./mcp.js";
import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "./mcp-catalog.js";
import { type RecipeAgentDefinition } from "./recipe-agent.js";
import { applyRecipeAgentModelConfigToModel } from "./recipe-model.js";
import {
  resolveRecipe,
  type ResolvedRecipe,
} from "./recipe/resolve.js";
import { resolveRecipeDirectory } from "./recipe-store.js";
import {
  createAgentTool,
  type AgentRunController,
  type AgentRunSummary,
} from "./agent-tool.js";

export interface PiRecipesExtensionOptions {
  env?: NodeJS.ProcessEnv;
  createChildAgentRunner?: CreateRecipeChildAgentRunner;
}

interface RecipeChildAgentRunner {
  start(): Promise<void>;
  prompt(prompt: string): Promise<unknown>;
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

type CreateRecipeChildAgentRunner = (opts: {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  modelRegistry?: ModelRegistry;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}) => RecipeChildAgentRunner;

interface AgentCallParams {
  action?: string;
  id?: string;
  name?: string;
  label?: string;
}

/** Mid-turn completion delivery retries on this cadence until the session idles. */
const COMPLETION_DELIVERY_RETRY_MS = 100;

interface ChildRun extends ChildRunSnapshot {
  runner: RecipeChildAgentRunner;
  promise: Promise<ChildRun>;
  notifyUpdate(): void;
}

interface RecipeLaunchState {
  key: string;
  cwd: string;
  resolved: ResolvedRecipe;
  extensionsLoaded: boolean;
  configured: boolean;
}

const require = createRequire(import.meta.url);

class RecipeLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeLaunchError";
  }
}

function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPathLikeRecipeInput(input: string): boolean {
  return (
    input.startsWith("/") ||
    input.startsWith(".") ||
    input.startsWith("~") ||
    input.includes("/")
  );
}

function recipeNotFoundMessage(input: string, resolvedPath: string): string {
  const lines = [`Recipe "${input}" was not found.`];
  if (isPathLikeRecipeInput(input)) {
    lines.push(`Resolved path: ${resolvedPath}`);
    lines.push("Make sure that directory exists and contains package.json with a pi block.");
  } else {
    lines.push(`No installed recipe matched "${input}", and no local directory exists at: ${resolvedPath}`);
    lines.push("Run `recipes list` to see installed recipes, or `recipes install <source>` first.");
  }
  lines.push("Then launch again with `pi --recipe <recipe>`.");
  return lines.join("\n");
}

function recipeLoadErrorMessage(input: string, reason: string): string {
  return [
    `Recipe "${input}" could not be loaded.`,
    reason,
    "Run `recipes check <recipe>` for a validation report.",
  ].join("\n");
}

function modelParts(spec: string): { provider: string; model: string } {
  const index = spec.indexOf("/");
  if (index < 0) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`
    );
  }
  return {
    provider: spec.slice(0, index),
    model: spec.slice(index + 1),
  };
}

function visibleSubagents(state: RecipeLaunchState): RecipeAgentDefinition[] {
  return [...state.resolved.subagents.values()];
}

function mcpSelectionsForAgent(agent: RecipeAgentDefinition) {
  return resolveAgentMcpSelections(agent.mcp);
}

function scopedMcpSelections(state: RecipeLaunchState) {
  return [state.resolved.agent, ...visibleSubagents(state)].flatMap(mcpSelectionsForAgent);
}

function textResult<TDetails>(text: string, details: TDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function resultText(result: unknown): string {
  const record = asRecord(result);
  return contentText(record?.content).trim();
}

function themeFg(theme: { fg?: (name: any, text: string) => string } | undefined, name: string, text: string): string {
  return theme?.fg ? theme.fg(name, text) : text;
}

function themeBold(theme: { bold?: (text: string) => string } | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

function truncateLine(text: string, max = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function formatAgentCall(
  args: AgentCallParams,
  theme: { fg?: (name: any, text: string) => string; bold?: (text: string) => string } | undefined
): string {
  const action = args.action ?? "start";
  const agent = args.name ?? args.id ?? "agent";
  const label = args.label ? ` ${themeFg(theme, "muted", `(${args.label})`)}` : "";
  return `${themeFg(theme, "toolTitle", themeBold(theme, `agent ${action}`))} ${themeFg(theme, "accent", agent)}${label}`;
}

// Keep the legacy wire value so resumed transcripts retain their renderer.
const AGENT_COMPLETIONS_TYPE = "recipe-agent-completions";

interface AgentCompletionsDetails {
  completions: ChildCompletionEnvelope[];
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Compact TUI rendering for a completion wake-up notice (pi-subagents style). */
function formatCompletionMessage(
  batch: readonly ChildCompletionEnvelope[],
  options: { expanded: boolean },
  theme: { fg?: (name: any, text: string) => string; bold?: (text: string) => string } | undefined
): string {
  const blocks = batch.map((envelope) => {
    const icon =
      envelope.status === "completed"
        ? themeFg(theme, "success", "✓")
        : themeFg(theme, "error", "✗");
    const label = envelope.label
      ? ` ${themeFg(theme, "muted", `(${envelope.label})`)}`
      : "";
    const duration =
      envelope.duration_ms !== undefined
        ? ` ${themeFg(theme, "muted", `· ${formatDurationMs(envelope.duration_ms)}`)}`
        : "";
    let text = `${icon} ${themeBold(theme, envelope.agent)} ${themeFg(theme, "muted", envelope.id)}${label} ${themeFg(theme, "muted", envelope.status)}${duration}`;
    const preview =
      (envelope.status === "failed"
        ? envelope.error ?? envelope.output_preview
        : envelope.output_preview
      )?.trim() ?? "";
    const lines = preview.split("\n").filter((line) => line.trim());
    const shown = options.expanded ? lines : lines.slice(0, 1);
    for (const line of shown.length > 0 ? shown : ["(no output)"]) {
      text += `\n  ${themeFg(theme, "muted", `⎿  ${options.expanded ? line : truncateLine(line)}`)}`;
    }
    if (!options.expanded && lines.length > 1) {
      text += `\n  ${themeFg(theme, "muted", "⎿  … (expand for full output)")}`;
    }
    return text;
  });
  return blocks.join("\n");
}

function snapshotOf(run: ChildRunSnapshot): ChildRunSnapshot {
  return {
    id: run.id,
    agent: run.agent,
    label: run.label,
    prompt: run.prompt,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    toolCalls: run.toolCalls.map((call) => ({ ...call })),
  };
}

function controllerSummary(
  run: ChildRunSnapshot,
  status: AgentRunSummary["status"] = run.status
): AgentRunSummary {
  const startedAt = Date.parse(run.startedAt);
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : undefined;
  const currentTool = [...run.toolCalls]
    .reverse()
    .find((call) => call.status === "running")?.name;
  return {
    agent_run_id: run.id,
    invocation_name: run.agent,
    agent_name: run.agent,
    label: run.label ?? run.agent,
    prompt: run.prompt,
    status,
    started_at: Number.isFinite(startedAt) ? startedAt : Date.now(),
    ...(completedAt !== undefined && Number.isFinite(completedAt)
      ? { completed_at: completedAt }
      : {}),
    last_activity_at:
      completedAt !== undefined && Number.isFinite(completedAt)
        ? completedAt
        : Number.isFinite(startedAt)
          ? startedAt
          : Date.now(),
    ...(currentTool ? { current_tool: currentTool } : {}),
    nested_tools: run.toolCalls.map((call) => ({
      toolName: call.name,
      verb: call.name,
      detail: call.output ?? call.error ?? "",
      ...(asRecord(call.args) ? { toolInput: asRecord(call.args)! } : {}),
    })),
    output_preview: run.output,
    output: run.output,
    error: run.error,
  };
}

function nameList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `  - ${item}`) : ["  - none"];
}

function activeRecipeTools(
  state: RecipeLaunchState,
  activeTools: string[]
): string[] {
  const active = new Set(activeTools);
  const recipeTools = new Set(state.resolved.tools);
  return [...recipeTools]
    .filter((tool) => active.has(tool))
    .sort();
}

function recipeSummary(state: RecipeLaunchState, activeTools: string[]): string {
  const subagents = visibleSubagents(state).map((agent) => agent.name);
  return [
    "Active Recipe",
    `Name: ${state.resolved.manifest.name}@${state.resolved.manifest.version}`,
    state.resolved.manifest.description ? `Description: ${state.resolved.manifest.description}` : undefined,
    `Agent: ${state.resolved.agentName}`,
    `Model: ${state.resolved.agent.model?.name ?? "(session default)"}`,
    `Thinking level: ${state.resolved.agent.model?.thinkingLevel ?? "(session default)"}`,
    `Subagents: ${nameList(subagents)}`,
    "",
    "Active recipe tools:",
    ...bulletList(activeRecipeTools(state, activeTools)),
    "",
    `Directory: ${state.resolved.recipeDir}`,
    `Workspace: ${state.cwd}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function applyChildToolEvent(run: ChildRun, event: RecipeChildToolEvent): void {
  const existing = run.toolCalls.find((call) => call.id === event.id);
  if (event.type === "start") {
    if (existing) {
      existing.name = event.name;
      existing.args = event.args;
      existing.status = "running";
      existing.completedAt = undefined;
      existing.output = undefined;
      existing.error = undefined;
      return;
    }
    run.toolCalls.push({
      id: event.id,
      name: event.name,
      args: event.args,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    return;
  }

  const call =
    existing ??
    (() => {
      const created: ChildToolActivity = {
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      run.toolCalls.push(created);
      return created;
    })();

  call.name = event.name;
  call.args = event.args;
  if (event.type === "update") {
    const text = resultText(event.partialResult);
    if (text) call.output = text;
    return;
  }

  call.completedAt = new Date().toISOString();
  call.status = event.isError ? "failed" : "completed";
  const text = resultText(event.result);
  if (text) call.output = text;
  if (event.isError) call.error = text || "Tool failed";
}

function resolvePackage(specifier: string): string | undefined {
  try {
    return import.meta.resolve(specifier);
  } catch {
    // Fall through to CommonJS resolution for packages that do not expose ESM exports.
  }
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

function resolvePackageModuleRoot(packageName: string): string | undefined {
  const resolved = resolvePackage(packageName);
  if (!resolved) return undefined;
  return dirname(resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved);
}

function recipeExtensionAliases(): Record<string, string> {
  return Object.fromEntries(
    [
      // Jiti aliases are package-prefix mappings. They must point at the
      // directory containing a package's resolved modules, not an entry file,
      // so Jiti can append exported subpaths without corrupting the path.
      // The self-alias also keeps recipe interaction imports on this package
      // instance, sharing interrupt state with the child-agent runner.
      ["@introspection-ai/pi-recipes", resolvePackageModuleRoot("@introspection-ai/pi-recipes")],
      ["@earendil-works/pi-coding-agent", resolvePackageModuleRoot("@earendil-works/pi-coding-agent")],
      ["@earendil-works/pi-agent-core", resolvePackageModuleRoot("@earendil-works/pi-agent-core")],
      ["@earendil-works/pi-ai", resolvePackageModuleRoot("@earendil-works/pi-ai")],
      ["typebox", resolvePackageModuleRoot("typebox")],
      ["@sinclair/typebox", resolvePackageModuleRoot("typebox")],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function loadJiti(): { createJiti: (url: string, opts: Record<string, unknown>) => { import: (id: string, opts?: { default?: boolean }) => Promise<unknown> } } {
  try {
    return require("jiti") as ReturnType<typeof loadJiti>;
  } catch {
    const piAgentEntry = resolvePackage("@earendil-works/pi-coding-agent");
    if (!piAgentEntry) {
      throw new Error("Unable to resolve @earendil-works/pi-coding-agent for recipe extension loading");
    }
    const piRequire = createRequire(piAgentEntry);
    return piRequire("jiti") as ReturnType<typeof loadJiti>;
  }
}

async function loadRecipeExtensionFactory(
  recipeDir: string,
  extensionPath: string
): Promise<ExtensionFactory> {
  const { createJiti } = loadJiti();
  const recipeLoaderUrl = pathToFileURL(join(recipeDir, ".recipe-extension-loader.js")).href;
  const jiti = createJiti(recipeLoaderUrl, {
    moduleCache: false,
    alias: recipeExtensionAliases(),
  });
  const loaded = await jiti.import(extensionPath, { default: true });
  const factory =
    typeof loaded === "function"
      ? loaded
      : loaded && typeof loaded === "object" && "default" in loaded && typeof loaded.default === "function"
        ? loaded.default
        : undefined;
  if (!factory) {
    throw new Error(`Recipe extension does not export a factory function: ${extensionPath}`);
  }
  return factory as ExtensionFactory;
}

export function createPiRecipesExtension(
  opts: PiRecipesExtensionOptions = {}
): ExtensionFactory {
  const env = opts.env ?? process.env;
  const createChildAgentRunner =
    opts.createChildAgentRunner ?? createRecipeChildAgentRunner;
  let state: RecipeLaunchState | null = null;
  let lastLaunchErrorKey: string | null = null;
  let childRunIndex = 0;
  const childRuns = new Map<string, ChildRun>();
  // Runs restored from a previous Pi process via rehydrateChildRuns(). They
  // have no live runner: readable (status/wait) but not controllable.
  const archivedRuns = new Map<string, ChildRunSnapshot>();
  let runStore: { cwd: string; store: ChildAgentRunStore } | null = null;
  // Background completions pending delivery to the parent model.
  const completions = new ChildCompletionQueue();
  // Latest extension context, for the idle check gating completion delivery.
  let sessionCtx: Pick<ExtensionContext, "isIdle"> | null = null;
  let localAgentContext: ExtensionContext | null = null;
  let sessionConfigurationError: string | null = null;
  const visibleAgentDefinitions = new Map<string, RecipeAgentDefinition>();

  function storeFor(cwd: string): ChildAgentRunStore {
    if (runStore?.cwd !== cwd) {
      runStore = { cwd, store: new ChildAgentRunStore(cwd) };
    }
    return runStore.store;
  }

  async function persistRun(cwd: string, run: ChildRunSnapshot): Promise<void> {
    try {
      await storeFor(cwd).writeStatus(snapshotOf(run));
    } catch {
      // persistence is best-effort; the live run stays authoritative
    }
  }

  function nextChildRunId(): string {
    return `agent-run-${++childRunIndex}`;
  }

  /**
   * Restore run snapshots persisted under `.pi/agents/` by a previous Pi
   * process, so run ids referenced in a resumed conversation stay resolvable.
   * A run persisted as `running` died with the old process — it is flipped to
   * `interrupted` (never silently "resumed"). Returns the number restored.
   */
  async function rehydrateChildRuns(cwd: string): Promise<number> {
    const store = storeFor(cwd);
    const persisted = await store.readPersistedSnapshots();
    let restored = 0;
    for (const snapshot of persisted) {
      const indexMatch = /^(?:agent-run|recipe-agent)-(\d+)$/.exec(snapshot.id);
      if (indexMatch) {
        childRunIndex = Math.max(childRunIndex, Number(indexMatch[1]));
      }
      if (childRuns.has(snapshot.id) || archivedRuns.has(snapshot.id)) {
        continue;
      }
      if (snapshot.status === "running") {
        snapshot.status = "interrupted";
        snapshot.completedAt = snapshot.completedAt ?? new Date().toISOString();
        snapshot.error = "Pi session restarted while the run was in flight";
        await persistRun(cwd, snapshot);
      }
      archivedRuns.set(snapshot.id, snapshot);
      restored += 1;
    }
    return restored;
  }

  function findRunSnapshot(id: string): ChildRunSnapshot | undefined {
    return childRuns.get(id) ?? archivedRuns.get(id);
  }

  const localRunController: AgentRunController = {
    list() {
      return [
        ...childRuns.values(),
        ...[...archivedRuns.values()].filter(
          (snapshot) => !childRuns.has(snapshot.id)
        ),
      ].map((run) => controllerSummary(run));
    },
    get(id) {
      const run = findRunSnapshot(id);
      return run ? controllerSummary(run) : null;
    },
    async start(input) {
      if (!state || !localAgentContext) {
        throw new Error("No recipe session is active");
      }
      const run = await runChildAgent(
        state,
        input.name,
        input.prompt,
        input.label,
        localAgentContext,
        input.onUpdate
      );
      return controllerSummary(run);
    },
    async wait(id, signal) {
      const run = findRunSnapshot(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status !== "running" || !childRuns.has(id)) {
        return controllerSummary(run);
      }
      await waitForRun(childRuns.get(id)!, signal);
      return controllerSummary(findRunSnapshot(id)!);
    },
    async message(id, message) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        await run.runner.steer(message);
        return controllerSummary(run);
      }
      run.status = "running";
      run.completedAt = undefined;
      run.error = undefined;
      run.output = undefined;
      run.promise = executeChildPrompt(run, message, state?.cwd ?? process.cwd());
      void persistRun(state?.cwd ?? process.cwd(), run);
      return controllerSummary(run);
    },
    async interrupt(id) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        run.status = "interrupted";
        run.completedAt = run.completedAt ?? new Date().toISOString();
        await run.runner.cancel();
        if (state) void persistRun(state.cwd, run);
      }
      return controllerSummary(run);
    },
    async close(id) {
      if (archivedRuns.has(id) && !childRuns.has(id)) {
        throw new Error(
          `Agent run ${id} belongs to a previous Pi session and cannot be controlled`
        );
      }
      const run = childRuns.get(id);
      if (!run) throw new Error(`Unknown agent run: ${id}`);
      if (run.status === "running") {
        run.status = "interrupted";
        await run.runner.cancel();
        await run.promise;
      }
      await run.runner.shutdown();
      childRuns.delete(id);
      return controllerSummary(run, "closed");
    },
  };

  async function closeAllChildRuns(): Promise<void> {
    await Promise.all(
      [...childRuns.keys()].map((id) => localRunController.close(id))
    );
  }

  function archivedControlError(id: string) {
    return {
      ...textResult(
        `Agent run ${id} belongs to a previous Pi session and cannot be controlled; only status and wait are available.`,
        { id }
      ),
      isError: true,
    };
  }

  // Launch selection is immutable for the lifetime of this extension. Resolved
  // values are exported below for shell tools, but must not become inputs to a
  // later session load in the same process.
  const launchRecipeDir = stringFlag(env.PI_RECIPE_DIR);
  const launchAgentName = stringFlag(env.PI_AGENT_NAME);

  function recipeFlag(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe")) ?? launchRecipeDir;
  }

  function selectedAgentName(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("agent")) ?? launchAgentName;
  }

  function loadState(pi: Parameters<ExtensionFactory>[0], cwd: string): RecipeLaunchState | null {
    const flag = recipeFlag(pi);
    if (!flag) return null;

    const recipeDir = resolveRecipeDirectory(flag, { cwd, env });
    if (!existsSync(recipeDir)) {
      throw new RecipeLaunchError(recipeNotFoundMessage(flag, recipeDir));
    }
    const requestedAgentName = selectedAgentName(pi);
    const key = [cwd, recipeDir, requestedAgentName ?? ""].join("\0");
    if (state?.key === key) return state;

    let resolved: ResolvedRecipe;
    try {
      resolved = resolveRecipe({
        recipeDir,
        agentName: requestedAgentName,
      });
    } catch (err) {
      throw new RecipeLaunchError(
        recipeLoadErrorMessage(flag, err instanceof Error ? err.message : String(err))
      );
    }
    // Keep the recipe selected by CLI flags visible to shell commands and
    // recipe-authored instructions. In production `env` is process.env, so
    // built-in shell tools and child agents inherit these resolved values.
    env.PI_RECIPE_DIR = recipeDir;
    env.PI_AGENT_NAME = resolved.agentName;

    state = {
      key,
      cwd,
      resolved,
      extensionsLoaded: false,
      configured: false,
    };
    return state;
  }

  function safeLoadState(
    pi: Parameters<ExtensionFactory>[0],
    cwd: string,
    ctx?: Pick<ExtensionContext, "ui">
  ): RecipeLaunchState | null {
    try {
      return loadState(pi, cwd);
    } catch (err) {
      if (!(err instanceof RecipeLaunchError)) throw err;
      const key = [cwd, recipeFlag(pi) ?? "", err.message].join("\0");
      if (ctx && lastLaunchErrorKey !== key) {
        ctx.ui.notify(err.message, "warning");
        lastLaunchErrorKey = key;
      }
      return null;
    }
  }

  async function loadRecipeExtensions(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    launchState: RecipeLaunchState
  ): Promise<void> {
    if (launchState.extensionsLoaded) return;
    let loadedCount = 0;
    for (const extensionPath of launchState.resolved.extensionPaths) {
      try {
        const factory = await loadRecipeExtensionFactory(launchState.resolved.recipeDir, extensionPath);
        await factory(pi);
        loadedCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `Recipe extension failed to load: ${extensionPath}\n${message}`,
          "warning"
        );
      }
    }
    launchState.extensionsLoaded = true;
    if (launchState.resolved.extensionPaths.length > 0) {
      ctx.ui.notify(
        `Recipe extensions: ${loadedCount}/${launchState.resolved.extensionPaths.length} loaded`,
        "info"
      );
    }
  }

  async function configureSession(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    launchState: RecipeLaunchState
  ): Promise<void> {
    if (launchState.configured) return;

    const labelParts = [
      `${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version}`,
      `agent:${launchState.resolved.agentName}`,
    ].filter(Boolean);
    pi.setSessionName(labelParts.join(" "));

    const { provider, model } = modelParts(launchState.resolved.modelSpec);
    const lookupProvider = provider === "gemini" ? "google" : provider;
    const resolvedModel = ctx.modelRegistry.find(lookupProvider, model);
    if (!resolvedModel) {
      throw new Error(
        `Recipe model is not available: ${launchState.resolved.modelSpec}`
      );
    }
    applyRecipeAgentModelConfigToModel(
      resolvedModel,
      launchState.resolved.modelConfig
    );
    const ok = await pi.setModel(resolvedModel);
    if (!ok) {
      throw new Error(
        `Recipe model has no configured API key: ${launchState.resolved.modelSpec}`
      );
    }

    if (launchState.resolved.thinkingLevel) {
      pi.setThinkingLevel(launchState.resolved.thinkingLevel);
    }

    const activeTools = new Set(launchState.resolved.tools);
    pi.setActiveTools([...activeTools]);
    launchState.configured = true;
    sessionConfigurationError = null;
  }

  async function configureMcp(
    launchState: RecipeLaunchState,
    ctx: Pick<ExtensionContext, "ui">
  ): Promise<void> {
    const mcpSelections = scopedMcpSelections(launchState);
    if (mcpSelections.length === 0) {
      await clearMcpSession(env, launchState.cwd);
      return;
    }

    configureMcpLocalConfigPath({
      cwd: launchState.cwd,
      recipeDir: launchState.resolved.recipeDir,
      env,
    });
    const [, session] = await Promise.all([
      materializeSessionMcpCli({
        cwd: launchState.cwd,
        env,
      }),
      materializeMcpSession({
        cwd: launchState.cwd,
        manifest: launchState.resolved.manifest,
        agentMcp: mcpSelections,
        env,
      }),
    ]);
    if (session.servers.length > 0) {
      void preloadMcpCatalogs({ env }).catch((error) => {
        console.warn(
          `Recipe MCP catalog preload failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      ctx.ui.notify(
        `Recipe MCP: ${session.servers.length} server(s) configured; runtime warming in background`,
        "info"
      );
      const detail = formatMcpConfigurationDiagnostics(session.diagnostics ?? []);
      if (detail) {
        ctx.ui.notify(
          [
            "Recipe MCP: some configured servers or tools were filtered.",
            "",
            detail,
          ].join("\n"),
          "warning"
        );
      }
    } else {
      const detail = formatMcpConfigurationDiagnostics(session.diagnostics ?? []);
      ctx.ui.notify(
        [
          "Recipe MCP: no servers are available to this agent. Check package policy and .pi/mcp.local.json.",
          ...(detail ? ["", detail] : []),
        ].join("\n"),
        "warning"
      );
    }
  }

  async function runChildAgent(
    launchState: RecipeLaunchState,
    agentName: string,
    prompt: string,
    label: string | undefined,
    ctx: ExtensionContext,
    onUpdate?: (summary: AgentRunSummary) => void | Promise<void>
  ): Promise<ChildRun> {
    const id = nextChildRunId();
    let run: ChildRun | undefined;
    const notifyUpdate = () => {
      if (!run || !onUpdate) return;
      try {
        void Promise.resolve(onUpdate(controllerSummary(run))).catch(() => {});
      } catch {
        // Detached runs can outlive the parent tool call. Late UI updates are
        // cosmetic and must not stop the child or completion delivery.
      }
    };
    const runner = createChildAgentRunner({
      recipeDir: launchState.resolved.recipeDir,
      workspaceDir: launchState.cwd,
      env,
      agentName,
      modelRegistry: ctx.modelRegistry,
      onAssistantMessage(text, stream) {
        if (!run) return;
        if (stream === "delta") {
          run.output = `${run.output ?? ""}${text}`;
        } else if (!run.output?.trim()) {
          run.output = text;
        }
        notifyUpdate();
      },
      onToolEvent(event) {
        if (!run) return;
        applyChildToolEvent(run, event);
        notifyUpdate();
      },
    });
    run = {
      id,
      agent: agentName,
      label,
      prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      toolCalls: [],
      runner,
      promise: Promise.resolve(undefined as never),
      notifyUpdate,
    };
    notifyUpdate();
    void persistRun(launchState.cwd, run);
    run.promise = executeChildPrompt(run, prompt, launchState.cwd);
    childRuns.set(id, run);
    return run;
  }

  function executeChildPrompt(
    run: ChildRun,
    prompt: string,
    cwd: string
  ): Promise<ChildRun> {
    return (async () => {
      try {
        await run.runner.start();
        const result = await run.runner.prompt(prompt);
        const finalOutput = promptResultText(result);
        if (finalOutput && finalOutput.length >= (run.output?.length ?? 0)) {
          run.output = finalOutput;
        } else if (!run.output?.trim()) {
          run.output = "(no final response)";
        }
        if (run.status === "running") run.status = "completed";
      } catch (err) {
        if (run.status !== "interrupted") run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        run.completedAt = new Date().toISOString();
        // Queue the parent wake-up BEFORE persisting. The deliverer reads the
        // in-memory queue (not disk), so enqueuing first makes a persisted
        // status.json imply the completion is already queued — closing a race
        // where the agent_end poke could observe the run's status.json but hit
        // an empty queue, deferring delivery to the full batch window. It also
        // still notifies if the disk write fails. Wait and terminal status
        // reads acknowledge it back out.
        const envelope = envelopeFromRun(run);
        if (envelope) completions.enqueue(envelope);
        run.notifyUpdate();
        await persistRun(cwd, run);
      }
      return run;
    })();
  }

  async function waitForRun(run: ChildRun, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await run.promise;
      return;
    }
    if (signal.aborted) return;
    let onAbort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([run.promise, aborted]);
    signal.removeEventListener("abort", onAbort);
  }

  return (pi) => {
    // Deliver queued background completions by waking the parent model with
    // a triggerTurn message. Delivery only happens when the session is
    // genuinely idle: a message queued while the parent turn is streaming
    // (or tearing down at the agent_end boundary) would be stranded in pi's
    // queues, and holding until idle also gives synchronous readers
    // (wait or terminal status) time to acknowledge results
    // the model already saw. While mid-turn, retry on a short timer armed by
    // the agent_end poke.
    let deliveryRetryTimer: NodeJS.Timeout | null = null;
    const deliverCompletions = () => {
      if (deliveryRetryTimer) {
        clearTimeout(deliveryRetryTimer);
        deliveryRetryTimer = null;
      }
      if (!completions.hasPending()) return;
      // The retry timer can outlive this extension instance across a reload,
      // where pi API calls throw as stale. Never crash the timer callback;
      // the reload rebuilds run state and drops the batch with it.
      try {
        if (!(sessionCtx?.isIdle?.() ?? true)) {
          deliveryRetryTimer = setTimeout(deliverCompletions, COMPLETION_DELIVERY_RETRY_MS);
          deliveryRetryTimer.unref?.();
          return;
        }
        const batch = completions.consumeBatch();
        if (batch.length === 0) return;
        pi.sendMessage(
          {
            customType: AGENT_COMPLETIONS_TYPE,
            content: renderCompletionNotice(batch),
            display: true,
            details: { completions: batch } satisfies AgentCompletionsDetails,
          },
          // followUp keeps a wake race-safe: if a user turn started between
          // the idle check and here, the notice queues behind it.
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } catch {
        // swallow — see above
      }
    };
    completions.setDeliverer(deliverCompletions);

    pi.on("agent_end", (_event, ctx) => {
      sessionCtx = ctx;
      completions.poke();
    });

    pi.registerMessageRenderer<AgentCompletionsDetails>(
      AGENT_COMPLETIONS_TYPE,
      (message, options, theme) => {
        const batch = (message.details as AgentCompletionsDetails | undefined)
          ?.completions;
        if (!batch?.length) return undefined;
        return new Text(formatCompletionMessage(batch, options, theme), 0, 0);
      }
    );

    pi.registerFlag("recipe", {
      description: "Recipe folder, installed recipe name, or installed recipe source to use for this Pi session",
      type: "string",
    });
    pi.registerFlag("agent", {
      description: "Agent to use",
      type: "string",
    });

    pi.registerCommand("recipe", {
      description: "Inspect or reload the active recipe",
      handler: async (args, ctx) => {
        const action = args.trim();
        if (action === "reload") {
          const launchState = safeLoadState(pi, ctx.cwd, ctx);
          if (!launchState) {
            if (!recipeFlag(pi)) {
              ctx.ui.notify("No recipe is active. Launch Pi with --recipe <recipe>.", "info");
            }
            return;
          }
          await closeAllChildRuns();
          state = null;
          archivedRuns.clear();
          completions.clear();
          await ctx.waitForIdle();
          await ctx.reload();
          ctx.ui.notify(`Recipe reload requested: ${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version}`, "info");
          return;
        }
        if (action) {
          ctx.ui.notify("Usage: /recipe [reload]", "info");
          return;
        }
        const launchState = safeLoadState(pi, ctx.cwd, ctx);
        if (!launchState) {
          if (!recipeFlag(pi)) {
            ctx.ui.notify("No recipe is active. Launch Pi with --recipe <recipe>.", "info");
          }
          return;
        }
        ctx.ui.notify(recipeSummary(launchState, pi.getActiveTools()), "info");
      },
    });

    const agentTool = createAgentTool(
      localRunController,
      visibleAgentDefinitions,
      {
        acknowledgeCompletions: (ids) => completions.acknowledge(ids),
      }
    );
    agentTool.label = "Agent";
    agentTool.renderCall = (params, theme, context) => {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatAgentCall(params as AgentCallParams, theme));
      return text;
    };
    pi.registerTool(agentTool);

    pi.on("session_start", async (_event, ctx) => {
      sessionCtx = ctx;
      localAgentContext = ctx;
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return;
      visibleAgentDefinitions.clear();
      for (const [name, definition] of launchState.resolved.subagents) {
        visibleAgentDefinitions.set(name, definition);
      }
      await loadRecipeExtensions(pi, ctx, launchState);
      try {
        await configureMcp(launchState, ctx);
      } catch (err) {
        ctx.ui.notify(
          `Recipe MCP failed to configure: ${err instanceof Error ? err.message : String(err)}`,
          "warning"
        );
        return;
      }
      try {
        await configureSession(pi, ctx, launchState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A recipe's declared model is part of its behavior contract. Continuing
        // with Pi's previously active model can produce plausible but invalid
        // results, so stop the session instead of silently falling back.
        sessionConfigurationError = message;
        pi.setActiveTools([]);
        ctx.ui.notify(`Recipe session cannot start: ${message}`, "warning");
        if (ctx.mode === "json" || ctx.mode === "print") {
          process.exitCode = 1;
        }
        return;
      }
      // Restore run snapshots persisted by a previous Pi process so run ids
      // referenced in a resumed conversation stay resolvable (read-only).
      try {
        const restored = await rehydrateChildRuns(launchState.cwd);
        if (restored > 0) {
          ctx.ui.notify(
            `Agents: rehydrated ${restored} previous run(s) (read-only)`,
            "info"
          );
        }
      } catch {
        // rehydration is best-effort
      }
      ctx.ui.notify(
        `Recipe: ${launchState.resolved.manifest.name}@${launchState.resolved.manifest.version} (${basename(launchState.resolved.recipeDir)})`,
        "info"
      );
    });

    pi.on("session_shutdown", async () => {
      await closeAllChildRuns();
      clearMcpCatalogPreload(env);
      await stopMcpDaemon(env);
    });

    pi.on("agent_start", (_event, ctx) => {
      if (!sessionConfigurationError) return;
      // setModel(false) leaves Pi's previously active model selected. Abort as
      // soon as the agent loop starts so that model can never receive a recipe
      // prompt after recipe configuration failed.
      ctx.abort();
    });

    pi.on("resources_discover", (event) => {
      const launchState = safeLoadState(pi, event.cwd);
      if (!launchState) return {};
      return {
        skillPaths: launchState.resolved.skillPaths,
        promptPaths: launchState.resolved.promptPaths,
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return {};
      return {
        systemPrompt: launchState.resolved.systemPromptOverride(
          event.systemPrompt
        ),
      };
    });
  };
}

export default createPiRecipesExtension();
