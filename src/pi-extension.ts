import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineTool,
  type AgentToolUpdateCallback,
  type AuthStorage,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  createRecipeChildAgentRunner,
  promptResultText,
  type RecipeChildToolEvent,
} from "./child-agent.js";
import {
  ChildAgentRunStore,
  type ChildRunSnapshot,
  type ChildRunStatus,
  type ChildToolActivity,
  type ChildToolStatus,
} from "./child-agent-store.js";
import {
  ChildCompletionQueue,
  envelopeFromRun,
  renderCompletionNotice,
  type ChildCompletionEnvelope,
} from "./child-agent-completions.js";
import {
  clearRecipeMcpManifest,
  configureMcpLocalConfigPath,
  executableRecipeToolNames,
  formatMcpDiscoveryDiagnostics,
  materializeSessionMcpCli,
  materializeRecipeMcpManifest,
  parseAgentMcpToolRef,
} from "./mcp.js";
import {
  loadRecipeAgentDefinitions,
  loadRecipeSystemPrompt,
  resolveRecipeAgentDefinition,
  validateRecipeAgentDefinitions,
  type RecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
  type PiPackageManifest,
} from "./recipe-package.js";
import { resolveRecipeDirectory } from "./recipe-store.js";

export interface PiRecipesExtensionOptions {
  env?: NodeJS.ProcessEnv;
  createChildAgentRunner?: CreateRecipeChildAgentRunner;
}

interface RecipeChildAgentRunner {
  start(): Promise<void>;
  prompt(task: string): Promise<unknown>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

type CreateRecipeChildAgentRunner = (opts: {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}) => RecipeChildAgentRunner;

const RunRecipeAgentParams = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("interrupt"),
      Type.Literal("close"),
    ])
  ),
  id: Type.Optional(Type.String()),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'action "wait" only. Run ids to join on; blocks until ALL are terminal. Omit ids (and id) to block until the first running run settles.',
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        'action "wait" only. Max time to block (default 60000, max 600000). On timeout the runs keep going and current statuses are returned.',
    })
  ),
  name: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
});

type RunRecipeAgentParams = Static<typeof RunRecipeAgentParams>;

/** Why a multi-run wait resolved. Timeout and abort detach; runs continue. */
type WaitEndReason = "settled" | "timeout" | "aborted";

const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
const WAIT_MIN_TIMEOUT_MS = 1_000;
const WAIT_MAX_TIMEOUT_MS = 600_000;

/** Mid-turn completion delivery retries on this cadence until the session idles. */
const COMPLETION_DELIVERY_RETRY_MS = 100;

interface RecipeAgentToolDetails {
  action: string;
  id?: string;
  agent?: string;
  label?: string;
  task?: string;
  status?: ChildRunStatus;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  tool_calls?: ChildToolActivity[];
  agent_runs?: Array<
    Pick<
      RecipeAgentToolDetails,
      "id" | "agent" | "label" | "task" | "status" | "startedAt" | "completedAt" | "output" | "error" | "tool_calls"
    >
  >;
  available_agents?: string[];
}

type RecipeAgentToolUpdate = AgentToolUpdateCallback<RecipeAgentToolDetails>;

interface ChildRun extends ChildRunSnapshot {
  runner: RecipeChildAgentRunner;
  promise: Promise<ChildRun>;
}

interface RecipeLaunchState {
  key: string;
  cwd: string;
  recipeDir: string;
  manifest: PiPackageManifest;
  agentName: string;
  agent: RecipeAgentDefinition;
  skillPaths: string[];
  promptPaths: string[];
  extensionPaths: string[];
  mcpServerCount: number;
  mcpToolCount: number;
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

function applySystemInstructions(
  base: string,
  instructions: RecipeSystemInstructions | undefined
): string {
  if (!instructions) return base;
  if (instructions.mode === "replace") return instructions.content;
  return [base, instructions.content].filter(Boolean).join("\n\n");
}

function runtimeContextPrompt(
  base: string,
  state: RecipeLaunchState
): string {
  const mcpRefs = state.agent.tools
    .map((tool) => parseAgentMcpToolRef(tool))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
  const mcpLines = mcpRefs.length > 0
    ? [
        "",
        "## Recipe MCP CLI",
        "- MCP tool policy refs are not directly callable tool names.",
        "- Use the session-local `mcp` command through `bash` for MCP endpoint tools.",
        "- The extension puts `mcp` on PATH; if lookup fails, use `$PI_RECIPES_MCP_BIN_DIR/mcp`.",
        "- Inspect configured sources with `mcp tools sources`.",
        "- Search tools with `mcp tools search \"query\"`.",
        "- Describe a tool with `mcp tools describe <server> <tool>`.",
        "- Call a tool with `mcp call <server> <tool> '<json-args>'`.",
        "- Configured MCP policy refs: " + mcpRefs.map((tool) => `${tool.serverId}/${tool.toolName}`).join(", "),
      ]
    : [];
  return [
    base,
    [
      "## Recipe Runtime Context",
      "- Current workspace: " + state.cwd,
      "- Recipe directory: " + state.recipeDir,
      ...mcpLines,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

function visibleSubagents(state: RecipeLaunchState): RecipeAgentDefinition[] {
  const definitions = loadRecipeAgentDefinitions(state.recipeDir);
  const names = state.agent.subagentsDeclared
    ? state.agent.subagents
    : [...new Set([...definitions.values()].map((agent) => agent.name))]
        .filter((name) => name !== state.agentName);
  return names
    .map((name) => definitions.get(name))
    .filter((agent): agent is RecipeAgentDefinition => Boolean(agent));
}

function scopedMcpToolRefs(state: RecipeLaunchState): string[] {
  return [state.agent, ...visibleSubagents(state)].flatMap((agent) =>
    agent.tools.filter((tool) => parseAgentMcpToolRef(tool))
  );
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

function toolArgText(args: unknown, keys: string[]): string | undefined {
  const record = asRecord(args);
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function describeChildToolCall(call: ChildToolActivity): string {
  const target =
    toolArgText(call.args, ["path", "file_path"]) ??
    toolArgText(call.args, ["command"]) ??
    toolArgText(call.args, ["pattern", "query"]);
  return target ? `${call.name} ${truncateLine(target, 80)}` : call.name;
}

function childToolStatusText(status: ChildToolStatus): string {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "done";
}

function formatRecipeAgentCall(
  args: RunRecipeAgentParams,
  theme: { fg?: (name: any, text: string) => string; bold?: (text: string) => string } | undefined
): string {
  const action = args.action ?? "start";
  const agent = args.name ?? args.id ?? "agent";
  const label = args.label ? ` ${themeFg(theme, "muted", `(${args.label})`)}` : "";
  return `${themeFg(theme, "toolTitle", themeBold(theme, `agent ${action}`))} ${themeFg(theme, "accent", agent)}${label}`;
}

function formatRecipeAgentResult(
  details: RecipeAgentToolDetails | undefined,
  text: string,
  options: { expanded: boolean; isPartial: boolean },
  theme: { fg?: (name: any, text: string) => string } | undefined
): string {
  if (!details?.id) return text;

  const lines: string[] = [
    themeFg(theme, details.error ? "warning" : "muted", `Status: ${details.status ?? (options.isPartial ? "running" : "completed")}`),
  ];

  if (details.tool_calls?.length) {
    lines.push("", themeFg(theme, "muted", "Tool calls:"));
    for (const call of details.tool_calls) {
      const label = describeChildToolCall(call);
      const status = childToolStatusText(call.status);
      lines.push(`  - ${themeFg(theme, call.status === "failed" ? "warning" : "toolOutput", label)} ${themeFg(theme, "muted", `[${status}]`)}`);
      if (options.expanded && call.output) {
        lines.push(`    ${themeFg(theme, "toolOutput", truncateLine(call.output))}`);
      }
      if (call.error) {
        lines.push(`    ${themeFg(theme, "warning", truncateLine(call.error))}`);
      }
    }
  }

  if (details.error) {
    lines.push("", themeFg(theme, "warning", `Error: ${details.error}`));
  } else if (details.output?.trim()) {
    lines.push("", themeFg(theme, "muted", "Output:"), themeFg(theme, "toolOutput", details.output.trim()));
  } else if (!options.isPartial && text.trim()) {
    lines.push("", themeFg(theme, "toolOutput", text.trim()));
  }

  return lines.join("\n");
}

const RECIPE_AGENT_COMPLETIONS_TYPE = "recipe-agent-completions";

interface RecipeAgentCompletionsDetails {
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

function describeRun(run: ChildRunSnapshot): string {
  const suffix = run.error ? `: ${run.error}` : run.output ? `: ${run.output}` : "";
  return `${run.id} ${run.agent}: ${run.status}${suffix}`;
}

function runDetails(run: ChildRunSnapshot, action = "status"): RecipeAgentToolDetails {
  return {
    action,
    id: run.id,
    agent: run.agent,
    label: run.label,
    task: run.task,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    tool_calls: run.toolCalls,
  };
}

function snapshotOf(run: ChildRunSnapshot): ChildRunSnapshot {
  return {
    id: run.id,
    agent: run.agent,
    label: run.label,
    task: run.task,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    toolCalls: run.toolCalls.map((call) => ({ ...call })),
  };
}

function runBlock(run: ChildRunSnapshot): string {
  const lines = [
    `Recipe agent: ${run.agent}`,
    `Run: ${run.id}`,
    run.label ? `Label: ${run.label}` : undefined,
    `Status: ${run.status}`,
    "",
    "Prompt:",
    run.task,
    "",
    "Output:",
    run.error ? `Error: ${run.error}` : run.output?.trim() || "(waiting for output...)",
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
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
  const recipeTools = new Set(executableRecipeToolNames(state.agent.tools));
  if (visibleSubagents(state).length > 0) recipeTools.add("agent");
  return [...recipeTools]
    .filter((tool) => active.has(tool))
    .sort();
}

function normalizeSelector(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.[^/.]+$/, "");
}

function extensionSelectorSet(recipeDir: string, extensionPath: string): Set<string> {
  const relativePath = relative(recipeDir, extensionPath).replace(/\\/g, "/");
  const withoutExtension = normalizeSelector(relativePath);
  const base = basename(extensionPath, extname(extensionPath));
  const parts = withoutExtension.split("/");
  const parent = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return new Set(
    [
      relativePath,
      withoutExtension,
      base,
      parent && base === "index" ? parent : undefined,
    ].filter((value): value is string => Boolean(value))
  );
}

function extensionSelectorMatches(
  recipeDir: string,
  extensionPath: string,
  selector: string
): boolean {
  const normalized = normalizeSelector(selector.trim());
  if (!normalized) return false;
  if (normalized === "*") return true;
  return extensionSelectorSet(recipeDir, extensionPath).has(normalized);
}

function filterExtensionPaths(
  recipeDir: string,
  extensionPaths: string[],
  agent: RecipeAgentDefinition
): string[] {
  const include = agent.extensions?.include;
  const exclude = agent.extensions?.exclude ?? [];
  return extensionPaths.filter((extensionPath) => {
    const included =
      include === undefined
        ? true
        : include.some((selector) =>
            extensionSelectorMatches(recipeDir, extensionPath, selector)
          );
    if (!included) return false;
    return !exclude.some((selector) =>
      extensionSelectorMatches(recipeDir, extensionPath, selector)
    );
  });
}

function recipeSummary(state: RecipeLaunchState, activeTools: string[]): string {
  const subagents = visibleSubagents(state).map((agent) => agent.name);
  return [
    "Active Recipe",
    `Name: ${state.manifest.name}@${state.manifest.version}`,
    state.manifest.description ? `Description: ${state.manifest.description}` : undefined,
    `Agent: ${state.agentName}`,
    `Model: ${state.agent.model?.name ?? "(session default)"}`,
    `Thinking level: ${state.agent.model?.thinkingLevel ?? "(session default)"}`,
    `Subagents: ${nameList(subagents)}`,
    "",
    "Active recipe tools:",
    ...bulletList(activeRecipeTools(state, activeTools)),
    "",
    `Directory: ${state.recipeDir}`,
    `Workspace: ${state.cwd}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function emitRunUpdate(run: ChildRun, onUpdate: RecipeAgentToolUpdate | undefined): void {
  try {
    onUpdate?.({
      content: [{ type: "text", text: runBlock(run) }],
      details: runDetails(run, "update"),
    });
  } catch {
    // A detached run outlives the parent turn that started it; pi rejects
    // tool updates once that turn has settled ("Agent listener invoked
    // outside active run"). Late updates are cosmetic — swallow them so the
    // background child keeps executing and completion delivery still fires.
  }
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

function recipeExtensionAliases(): Record<string, string> {
  return Object.fromEntries(
    [
      ["@earendil-works/pi-coding-agent", resolvePackage("@earendil-works/pi-coding-agent")],
      ["@earendil-works/pi-agent-core", resolvePackage("@earendil-works/pi-agent-core")],
      ["@earendil-works/pi-ai", resolvePackage("@earendil-works/pi-ai")],
      ["@earendil-works/pi-ai/oauth", resolvePackage("@earendil-works/pi-ai/oauth")],
      ["typebox", resolvePackage("typebox")],
      ["typebox/compile", resolvePackage("typebox/compile")],
      ["typebox/value", resolvePackage("typebox/value")],
      ["@sinclair/typebox", resolvePackage("typebox")],
      ["@sinclair/typebox/compile", resolvePackage("typebox/compile")],
      ["@sinclair/typebox/value", resolvePackage("typebox/value")],
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
    return `recipe-agent-${++childRunIndex}`;
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
      const indexMatch = /^recipe-agent-(\d+)$/.exec(snapshot.id);
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

  function archivedControlError(id: string) {
    return {
      ...textResult(
        `Recipe agent run ${id} belongs to a previous Pi session and cannot be controlled; only status and wait are available.`,
        { id }
      ),
      isError: true,
    };
  }

  function recipeFlag(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe")) ?? stringFlag(env.PI_RECIPE_DIR);
  }

  function selectedAgentName(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("agent")) ?? stringFlag(env.PI_AGENT_NAME);
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

    let manifest: PiPackageManifest;
    try {
      manifest = readPiPackageManifest(recipeDir);
    } catch (err) {
      throw new RecipeLaunchError(
        recipeLoadErrorMessage(flag, err instanceof Error ? err.message : String(err))
      );
    }
    const validation = validatePiPackageManifest(manifest);
    const errors = validation.findings.filter((finding) => finding.severity === "error");
    if (errors.length > 0) {
      throw new RecipeLaunchError(
        recipeLoadErrorMessage(flag, errors.map((finding) => finding.message).join("\n"))
      );
    }

    const agentFindings = validateRecipeAgentDefinitions(recipeDir);
    if (agentFindings.length > 0) {
      throw new RecipeLaunchError(
        [
          `Recipe "${manifest.name}" has invalid agents.`,
          ...agentFindings.map((finding) => `- ${finding.message}`),
          "Add the missing fields to each agent, even if empty.",
        ].join("\n")
      );
    }

    const resolved = resolveRecipeAgentDefinition({
      recipeDir,
      agentName: requestedAgentName,
    });
    if (!resolved.agent) {
      const availableAgents = [...loadRecipeAgentDefinitions(recipeDir).keys()].sort();
      throw new RecipeLaunchError(
        [
          `Recipe "${manifest.name}" loaded, but agent "${resolved.agentName}" was not found.`,
          availableAgents.length > 0
            ? `Available agents: ${availableAgents.join(", ")}`
            : "No recipe agents were found.",
          "Launch with `pi --recipe <recipe> --agent <agent>` or update the recipe agents.",
        ].join("\n")
      );
    }

    const extensionPaths = filterExtensionPaths(
      recipeDir,
      packageResourcePaths(manifest, "extensions"),
      resolved.agent
    );

    state = {
      key,
      cwd,
      recipeDir,
      manifest,
      agentName: resolved.agentName,
      agent: resolved.agent,
      skillPaths: packageResourcePaths(manifest, "skills"),
      promptPaths: packageResourcePaths(manifest, "prompts"),
      extensionPaths,
      mcpServerCount: 0,
      mcpToolCount: 0,
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
    for (const extensionPath of launchState.extensionPaths) {
      try {
        const factory = await loadRecipeExtensionFactory(launchState.recipeDir, extensionPath);
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
    if (launchState.extensionPaths.length > 0) {
      ctx.ui.notify(
        `Recipe extensions: ${loadedCount}/${launchState.extensionPaths.length} loaded`,
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
      `${launchState.manifest.name}@${launchState.manifest.version}`,
      `agent:${launchState.agentName}`,
    ].filter(Boolean);
    pi.setSessionName(labelParts.join(" "));

    const modelSpec = launchState.agent.model?.name;
    if (modelSpec) {
      const { provider, model } = modelParts(modelSpec);
      const lookupProvider = provider === "gemini" ? "google" : provider;
      const resolvedModel = ctx.modelRegistry.find(lookupProvider, model);
      if (!resolvedModel) {
        throw new Error(`Recipe model is not available: ${modelSpec}`);
      }
      const ok = await pi.setModel(resolvedModel);
      if (!ok) {
        throw new Error(`Recipe model has no configured API key: ${modelSpec}`);
      }
    }

    const thinkingLevel = launchState.agent.model?.thinkingLevel;
    if (thinkingLevel) {
      pi.setThinkingLevel(thinkingLevel as ThinkingLevel);
    }

    const activeTools = new Set(executableRecipeToolNames(launchState.agent.tools));
    if (visibleSubagents(launchState).length > 0) activeTools.add("agent");
    pi.setActiveTools([...activeTools]);
    launchState.configured = true;
  }

  async function configureMcp(
    launchState: RecipeLaunchState,
    ctx: Pick<ExtensionContext, "ui">
  ): Promise<void> {
    const mcpToolRefs = scopedMcpToolRefs(launchState);
    if (mcpToolRefs.length === 0) {
      launchState.mcpServerCount = 0;
      launchState.mcpToolCount = 0;
      await clearRecipeMcpManifest(env, launchState.cwd);
      return;
    }

    configureMcpLocalConfigPath({
      cwd: launchState.cwd,
      recipeDir: launchState.recipeDir,
      env,
    });
    await materializeSessionMcpCli({
      cwd: launchState.cwd,
      env,
    });

    const manifest = await materializeRecipeMcpManifest({
      cwd: launchState.cwd,
      recipeDir: launchState.recipeDir,
      manifest: launchState.manifest,
      agentTools: mcpToolRefs,
      env,
      fetch: globalThis.fetch,
    });
    launchState.mcpServerCount = manifest.servers?.length ?? 0;
    launchState.mcpToolCount = (manifest.servers ?? []).reduce(
      (count, server) => count + (server.tools?.length ?? 0),
      0
    );
    if (launchState.mcpToolCount > 0) {
      ctx.ui.notify(
        `Recipe MCP: ${launchState.mcpToolCount} tool(s) from ${launchState.mcpServerCount} server(s)`,
        "info"
      );
      const detail = formatMcpDiscoveryDiagnostics(manifest.diagnostics ?? []);
      if (detail) {
        ctx.ui.notify(
          [
            "Recipe MCP: some configured endpoints or tools were not available.",
            "",
            detail,
          ].join("\n"),
          "warning"
        );
      }
    } else {
      const detail = formatMcpDiscoveryDiagnostics(manifest.diagnostics ?? []);
      ctx.ui.notify(
        [
          "Recipe MCP: no tools discovered. Check .pi/mcp.local.json, endpoint auth, and whether the MCP server supports tools/list.",
          ...(detail ? ["", detail] : []),
        ].join("\n"),
        "warning"
      );
    }
  }

  async function runChildAgent(
    launchState: RecipeLaunchState,
    agentName: string,
    task: string,
    label: string | undefined,
    ctx: ExtensionContext,
    onUpdate?: RecipeAgentToolUpdate
  ): Promise<ChildRun> {
    const id = nextChildRunId();
    let run: ChildRun | undefined;
    const runner = createChildAgentRunner({
      recipeDir: launchState.recipeDir,
      workspaceDir: launchState.cwd,
      env,
      agentName,
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      onAssistantMessage(text, stream) {
        if (!run) return;
        if (stream === "delta") {
          run.output = `${run.output ?? ""}${text}`;
        } else if (!run.output?.trim()) {
          run.output = text;
        }
        emitRunUpdate(run, onUpdate);
      },
      onToolEvent(event) {
        if (!run) return;
        applyChildToolEvent(run, event);
        emitRunUpdate(run, onUpdate);
      },
    });
    run = {
      id,
      agent: agentName,
      label,
      task,
      status: "running",
      startedAt: new Date().toISOString(),
      toolCalls: [],
      runner,
      promise: Promise.resolve(undefined as never),
    };
    emitRunUpdate(run, onUpdate);
    void persistRun(launchState.cwd, run);
    run.promise = (async () => {
      try {
        await runner.start();
        const result = await runner.prompt(task);
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
        await persistRun(launchState.cwd, run);
        emitRunUpdate(run, onUpdate);
        // Queue a wake-up notice for the parent model. Synchronous readers
        // (blocking start, wait, terminal status) acknowledge it back out.
        const envelope = envelopeFromRun(run);
        if (envelope) completions.enqueue(envelope);
        await runner.shutdown();
      }
      return run;
    })();
    childRuns.set(id, run);
    return run;
  }

  /**
   * Block until the run settles or `signal` aborts. An abort DETACHES from
   * the run — the child keeps executing in the background and the caller gets
   * the live (non-terminal) state — it never interrupts the child. Stopping
   * the parent must not stop delegated work; killing a child is only ever the
   * explicit `interrupt`/`close` actions.
   */
  async function waitForRun(
    run: ChildRun,
    signal: AbortSignal | undefined
  ): Promise<ChildRun> {
    if (!signal) return await run.promise;
    if (signal.aborted) return run;
    let resolveAbort: (() => void) | null = null;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = () => resolveAbort?.();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([run.promise, abortPromise]);
      return run;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Join primitive over existing runs. `mode: "all"` resolves when every
   * listed run is terminal; `mode: "first"` resolves as soon as any listed
   * run is terminal (immediately if one already is). Resolves early on
   * timeout or signal abort — both DETACH, returning current snapshots with
   * the reason; they never interrupt the children.
   */
  async function waitForRuns(
    ids: readonly string[],
    opts: { mode: "all" | "first"; timeoutMs: number; signal?: AbortSignal }
  ): Promise<{ runs: ChildRunSnapshot[]; reason: WaitEndReason }> {
    const snapshots = () =>
      ids
        .map((id) => findRunSnapshot(id))
        .filter((run): run is ChildRunSnapshot => run !== undefined)
        .map(snapshotOf);

    const inFlight = ids
      .map((id) => childRuns.get(id))
      .filter((run): run is ChildRun => !!run && run.status === "running");
    const alreadySettled =
      inFlight.length === 0 ||
      (opts.mode === "first" && inFlight.length < ids.length);
    if (alreadySettled) return { runs: snapshots(), reason: "settled" };
    if (opts.signal?.aborted) return { runs: snapshots(), reason: "aborted" };

    const runPromises = inFlight.map((run) => run.promise);
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const settled = (
      opts.mode === "all" ? Promise.all(runPromises) : Promise.race(runPromises)
    ).then(() => "settled" as const);
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
      timer.unref?.();
    });
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const reason = await Promise.race([settled, timedOut, aborted]);
      return { runs: snapshots(), reason };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function handleAgentTool(
    params: RunRecipeAgentParams,
    signal: AbortSignal | undefined,
    onUpdate: RecipeAgentToolUpdate | undefined,
    ctx: ExtensionContext
  ) {
    if (!state) {
      return {
        ...textResult("No recipe is active. Launch Pi with --recipe <dir> to use recipe agents.", {
          error: "recipe_not_active",
        }),
        isError: true,
      };
    }

    const action = params.action ?? "start";
    if (action === "status") {
      const runs = params.id
        ? [findRunSnapshot(params.id)].filter(
            (run): run is ChildRunSnapshot => Boolean(run)
          )
        : [
            ...childRuns.values(),
            ...[...archivedRuns.values()].filter(
              (snapshot) => !childRuns.has(snapshot.id)
            ),
          ];
      if (params.id && runs.length === 0) {
        return { ...textResult(`Unknown recipe agent run: ${params.id}`, { id: params.id }), isError: true };
      }
      // Terminal outputs shown here are delivered — drop queued notices.
      completions.acknowledge(
        runs.filter((run) => run.status !== "running").map((run) => run.id)
      );
      return textResult(
        runs.length > 0 ? runs.map(describeRun).join("\n") : "No recipe agent runs have been started yet.",
        { action, agent_runs: runs.map((run) => runDetails(run)) }
      );
    }

    if (action === "wait") {
      const explicitIds = params.ids?.length
        ? params.ids
        : params.id
          ? [params.id]
          : null;
      if (explicitIds) {
        const unknown = explicitIds.filter((id) => !findRunSnapshot(id));
        if (unknown.length > 0) {
          return {
            ...textResult(`Unknown recipe agent run(s): ${unknown.join(", ")}`, {
              action,
            }),
            isError: true,
          };
        }
      }
      const targets =
        explicitIds ??
        [...childRuns.values()]
          .filter((run) => run.status === "running")
          .map((run) => run.id);
      if (targets.length === 0) {
        return textResult("No running recipe agent runs to wait for.", {
          action,
          agent_runs: [...childRuns.values()].map((run) => runDetails(run)),
        });
      }
      const timeoutMs = Math.min(
        WAIT_MAX_TIMEOUT_MS,
        Math.max(WAIT_MIN_TIMEOUT_MS, params.timeout_ms ?? WAIT_DEFAULT_TIMEOUT_MS)
      );
      const { runs, reason } = await waitForRuns(targets, {
        mode: explicitIds ? "all" : "first",
        timeoutMs,
        signal,
      });
      // Terminal outputs shown here are delivered — drop queued notices.
      completions.acknowledge(
        runs.filter((run) => run.status !== "running").map((run) => run.id)
      );
      const header =
        reason === "settled"
          ? explicitIds
            ? "All waited recipe agent runs settled."
            : "A recipe agent run settled."
          : reason === "timeout"
            ? `Wait timed out after ${Math.round(timeoutMs / 1000)}s; runs continue in the background.`
            : "Wait cancelled — runs continue in the background.";
      return textResult(
        [header, runs.map(runBlock).join("\n\n")].filter(Boolean).join("\n\n"),
        { action, agent_runs: runs.map((run) => runDetails(run)) }
      );
    }

    if (action === "interrupt") {
      if (params.id && archivedRuns.has(params.id) && !childRuns.has(params.id)) {
        return archivedControlError(params.id);
      }
      const run = params.id ? childRuns.get(params.id) : undefined;
      if (!run) return { ...textResult(params.id ? `Unknown recipe agent run: ${params.id}` : "Interrupt requires a recipe agent run id.", {}), isError: true };
      // Interrupt targets in-flight work only; a settled run keeps its status.
      if (run.status !== "running") {
        return textResult(runBlock(run), runDetails(run, action));
      }
      run.status = "interrupted";
      await run.runner.cancel();
      void persistRun(state.cwd, run);
      emitRunUpdate(run, onUpdate);
      return textResult(runBlock(run), runDetails(run, action));
    }

    if (action === "close") {
      if (params.id && archivedRuns.has(params.id) && !childRuns.has(params.id)) {
        return archivedControlError(params.id);
      }
      const run = params.id ? childRuns.get(params.id) : undefined;
      if (!run) return { ...textResult(params.id ? `Unknown recipe agent run: ${params.id}` : "Close requires a recipe agent run id.", {}), isError: true };
      // Close stops in-flight work; detached background runs don't outlive it.
      if (run.status === "running") {
        run.status = "interrupted";
        await run.runner.cancel();
        void persistRun(state.cwd, run);
      }
      childRuns.delete(run.id);
      return textResult(`Closed recipe agent run ${run.id} (${run.agent}).`, { id: run.id });
    }

    if (!params.name || !params.task) {
      return {
        ...textResult("Starting a recipe agent requires both name and task.", {
          available_agents: visibleSubagents(state).map((agent) => agent.name),
        }),
        isError: true,
      };
    }

    const visible = visibleSubagents(state);
    const agent = visible.find((item) => item.name === params.name);
    if (!agent) {
      return {
        ...textResult(
          `Unknown or unavailable recipe agent: ${params.name}. Available agents: ${visible.map((item) => item.name).join(", ")}`,
          { action, agent: params.name, available_agents: visible.map((item) => item.name) }
        ),
        isError: true,
      };
    }

    const run = await runChildAgent(state, agent.name, params.task, params.label, ctx, onUpdate);
    if (params.wait !== false) {
      await waitForRun(run, signal);
      // An aborted wait detaches: the child keeps running in the background.
      if (run.status === "running") {
        return textResult(
          `Wait cancelled — recipe agent run ${run.id} (${run.agent}) is still running in the background. Use the agent tool with action "status" to check on it.`,
          runDetails(run, action)
        );
      }
      // The model saw this result synchronously — drop any queued notice.
      completions.acknowledge([run.id]);
      return textResult(runBlock(run), runDetails(run, action));
    }
    return textResult(
      runBlock(run),
      runDetails(run, action)
    );
  }

  return (pi) => {
    // Deliver queued background completions by waking the parent model with
    // a triggerTurn message. Delivery only happens when the session is
    // genuinely idle: a message queued while the parent turn is streaming
    // (or tearing down at the agent_end boundary) would be stranded in pi's
    // queues, and holding until idle also gives synchronous readers
    // (blocking start, wait, terminal status) time to acknowledge results
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
            customType: RECIPE_AGENT_COMPLETIONS_TYPE,
            content: renderCompletionNotice(batch),
            display: true,
            details: { completions: batch } satisfies RecipeAgentCompletionsDetails,
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

    pi.registerMessageRenderer<RecipeAgentCompletionsDetails>(
      RECIPE_AGENT_COMPLETIONS_TYPE,
      (message, options, theme) => {
        const batch = (message.details as RecipeAgentCompletionsDetails | undefined)
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
      description: "Recipe agent to use",
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
          state = null;
          childRuns.clear();
          archivedRuns.clear();
          completions.clear();
          await ctx.waitForIdle();
          await ctx.reload();
          ctx.ui.notify(`Recipe reload requested: ${launchState.manifest.name}@${launchState.manifest.version}`, "info");
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

    pi.registerTool(
      defineTool({
        name: "agent",
        label: "Recipe agent",
        description: [
          "Start or manage another agent from the active recipe.",
          "Start calls stream the prompted task and subagent assistant output in one tool block.",
          "By default start waits for completion; pass wait=false only when a background run is desired.",
          "When a background run finishes you are notified automatically with its result — do not poll status in a loop while waiting.",
          'Use action "wait" to join on existing runs: with ids it blocks until ALL listed runs settle, without ids until the FIRST running run settles.',
          "Cancelling a wait detaches from the runs — they keep executing in the background; only interrupt/close stop a run.",
          "This tool is active only when the selected recipe agent has available subagents.",
        ].join("\n"),
        parameters: RunRecipeAgentParams,
        renderCall(params: RunRecipeAgentParams, theme, context) {
          const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          text.setText(formatRecipeAgentCall(params, theme));
          return text;
        },
        renderResult(result, options, theme, context) {
          const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          const details = result.details as RecipeAgentToolDetails | undefined;
          const fallbackText = contentText(result.content);
          text.setText(formatRecipeAgentResult(details, fallbackText, options, theme));
          return text;
        },
        async execute(_runId, params: RunRecipeAgentParams, signal, onUpdate, ctx) {
          return await handleAgentTool(params, signal, onUpdate, ctx);
        },
      })
    );

    pi.on("session_start", async (_event, ctx) => {
      sessionCtx = ctx;
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return;
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
      await configureSession(pi, ctx, launchState);
      // Restore run snapshots persisted by a previous Pi process so run ids
      // referenced in a resumed conversation stay resolvable (read-only).
      try {
        const restored = await rehydrateChildRuns(launchState.cwd);
        if (restored > 0) {
          ctx.ui.notify(
            `Recipe agents: rehydrated ${restored} previous run(s) (read-only)`,
            "info"
          );
        }
      } catch {
        // rehydration is best-effort
      }
      ctx.ui.notify(
        `Recipe: ${launchState.manifest.name}@${launchState.manifest.version} (${basename(launchState.recipeDir)})`,
        "info"
      );
    });

    pi.on("resources_discover", (event) => {
      const launchState = safeLoadState(pi, event.cwd);
      if (!launchState) return {};
      return {
        skillPaths: launchState.skillPaths,
        promptPaths: launchState.promptPaths,
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return {};
      const base = loadRecipeSystemPrompt(launchState.recipeDir) ?? event.systemPrompt;
      const recipePrompt = applySystemInstructions(base, launchState.agent.systemInstructions);
      const systemPrompt = runtimeContextPrompt(recipePrompt, launchState);
      return { systemPrompt };
    });
  };
}

export default createPiRecipesExtension();
