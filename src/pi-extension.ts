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
  name: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
});

type RunRecipeAgentParams = Static<typeof RunRecipeAgentParams>;
type ChildRunStatus = "running" | "completed" | "failed" | "interrupted";
type ChildToolStatus = "running" | "completed" | "failed";

interface ChildToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: ChildToolStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

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

interface ChildRun {
  id: string;
  agent: string;
  label?: string;
  task: string;
  status: ChildRunStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  toolCalls: ChildToolActivity[];
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
  themePaths: string[];
  extensionPaths: string[];
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
    "Run `recipes doctor <recipe>` for a validation report.",
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
  return [
    base,
    [
      "## Recipe Runtime Context",
      "- Current workspace: " + state.cwd,
      "- Recipe directory: " + state.recipeDir,
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

function describeRun(run: ChildRun): string {
  const suffix = run.error ? `: ${run.error}` : run.output ? `: ${run.output}` : "";
  return `${run.id} ${run.agent}: ${run.status}${suffix}`;
}

function runDetails(run: ChildRun, action = "status"): RecipeAgentToolDetails {
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

function runBlock(run: ChildRun): string {
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
  const recipeTools = new Set(state.agent.tools);
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
  onUpdate?.({
    content: [{ type: "text", text: runBlock(run) }],
    details: runDetails(run, "update"),
  });
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
      themePaths: packageResourcePaths(manifest, "themes"),
      extensionPaths,
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

    const activeTools = new Set(launchState.agent.tools);
    if (visibleSubagents(launchState).length > 0) activeTools.add("agent");
    pi.setActiveTools([...activeTools]);
    launchState.configured = true;
  }

  async function runChildAgent(
    launchState: RecipeLaunchState,
    agentName: string,
    task: string,
    label: string | undefined,
    ctx: ExtensionContext,
    onUpdate?: RecipeAgentToolUpdate
  ): Promise<ChildRun> {
    const id = `recipe-agent-${++childRunIndex}`;
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
        run.status = "completed";
      } catch (err) {
        if (run.status !== "interrupted") run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        run.completedAt = new Date().toISOString();
        emitRunUpdate(run, onUpdate);
        await runner.shutdown();
      }
      return run;
    })();
    childRuns.set(id, run);
    return run;
  }

  async function waitForRun(
    run: ChildRun,
    signal: AbortSignal | undefined,
    onUpdate?: RecipeAgentToolUpdate
  ): Promise<ChildRun> {
    if (!signal) return await run.promise;
    const interrupt = () => {
      run.status = "interrupted";
      void run.runner.cancel();
      emitRunUpdate(run, onUpdate);
    };
    if (signal.aborted) interrupt();
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      return await run.promise;
    } finally {
      signal.removeEventListener("abort", interrupt);
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
        ? [childRuns.get(params.id)].filter((run): run is ChildRun => Boolean(run))
        : [...childRuns.values()];
      if (params.id && runs.length === 0) {
        return { ...textResult(`Unknown recipe agent run: ${params.id}`, { id: params.id }), isError: true };
      }
      return textResult(
        runs.length > 0 ? runs.map(describeRun).join("\n") : "No recipe agent runs have been started yet.",
        { action, agent_runs: runs.map((run) => runDetails(run)) }
      );
    }

    if (action === "wait") {
      const run = params.id ? childRuns.get(params.id) : [...childRuns.values()].at(-1);
      if (!run) {
        return { ...textResult(params.id ? `Unknown recipe agent run: ${params.id}` : "No recipe agent runs have been started yet.", {}), isError: true };
      }
      emitRunUpdate(run, onUpdate);
      await waitForRun(run, signal, onUpdate);
      emitRunUpdate(run, onUpdate);
      return textResult(runBlock(run), runDetails(run, action));
    }

    if (action === "interrupt") {
      const run = params.id ? childRuns.get(params.id) : undefined;
      if (!run) return { ...textResult(params.id ? `Unknown recipe agent run: ${params.id}` : "Interrupt requires a recipe agent run id.", {}), isError: true };
      run.status = "interrupted";
      await run.runner.cancel();
      emitRunUpdate(run, onUpdate);
      return textResult(runBlock(run), runDetails(run, action));
    }

    if (action === "close") {
      const run = params.id ? childRuns.get(params.id) : undefined;
      if (!run) return { ...textResult(params.id ? `Unknown recipe agent run: ${params.id}` : "Close requires a recipe agent run id.", {}), isError: true };
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
      await waitForRun(run, signal, onUpdate);
      return textResult(runBlock(run), runDetails(run, action));
    }
    return textResult(
      runBlock(run),
      runDetails(run, action)
    );
  }

  return (pi) => {
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
      const launchState = safeLoadState(pi, ctx.cwd, ctx);
      if (!launchState) return;
      await loadRecipeExtensions(pi, ctx, launchState);
      await configureSession(pi, ctx, launchState);
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
        themePaths: launchState.themePaths,
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
