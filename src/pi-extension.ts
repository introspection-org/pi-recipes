import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  defineTool,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { launchContextFromPortableEnv } from "./env.js";
import { createLocalRecipeRunner } from "./local.js";
import type { RecipeRunner } from "./runner.js";
import type { RunnerTranscriptEvent } from "./types.js";
import {
  loadRecipeAgentDefinitions,
  loadRecipeSystemPrompt,
  resolveRecipeAgentDefinition,
  type RecipeAgentDefinition,
  type RecipeProfileDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
  type PiPackageManifest,
} from "./recipe-package.js";
import { promptResultText } from "./session.js";

export interface PiRecipesExtensionOptions {
  env?: NodeJS.ProcessEnv;
  createRecipeRunner?: typeof createLocalRecipeRunner;
}

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
  agent_runs?: Array<
    Pick<
      RecipeAgentToolDetails,
      "id" | "agent" | "label" | "task" | "status" | "startedAt" | "completedAt" | "output" | "error"
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
  runner: RecipeRunner;
  promise: Promise<ChildRun>;
}

interface RecipeLaunchState {
  key: string;
  cwd: string;
  recipeDir: string;
  manifest: PiPackageManifest;
  profileName?: string;
  agentName: string;
  agent: RecipeAgentDefinition;
  profile: RecipeProfileDefinition | null;
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
  extensionPaths: string[];
  extensionsLoaded: boolean;
  configured: boolean;
}

const require = createRequire(import.meta.url);

function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const names = state.agent.subagents.length
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

function emitRunUpdate(run: ChildRun, onUpdate: RecipeAgentToolUpdate | undefined): void {
  onUpdate?.({
    content: [{ type: "text", text: runBlock(run) }],
    details: runDetails(run, "update"),
  });
}

function assistantTranscriptText(event: RunnerTranscriptEvent): { text: string; stream: string | undefined } | null {
  if (event.type !== "assistant_message") return null;
  const text = typeof event.data.text === "string" ? event.data.text : "";
  if (!text) return null;
  const stream = typeof event.data.stream === "string" ? event.data.stream : undefined;
  return { text, stream };
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

async function loadRecipeExtensionFactory(extensionPath: string): Promise<ExtensionFactory> {
  const { createJiti } = loadJiti();
  const jiti = createJiti(import.meta.url, {
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
  const createRecipeRunner = opts.createRecipeRunner ?? createLocalRecipeRunner;
  let state: RecipeLaunchState | null = null;
  let childRunIndex = 0;
  const childRuns = new Map<string, ChildRun>();

  function recipeFlag(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe")) ?? stringFlag(env.PI_RECIPE_DIR);
  }

  function selectedProfileName(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe-profile")) ?? stringFlag(env.PI_PROFILE_NAME);
  }

  function selectedAgentName(pi: Parameters<ExtensionFactory>[0]): string | undefined {
    return stringFlag(pi.getFlag("recipe-agent")) ?? stringFlag(env.PI_AGENT_NAME);
  }

  function loadState(pi: Parameters<ExtensionFactory>[0], cwd: string): RecipeLaunchState | null {
    const flag = recipeFlag(pi);
    if (!flag) return null;

    const recipeDir = resolve(cwd, flag);
    const profileName = selectedProfileName(pi);
    const requestedAgentName = selectedAgentName(pi);
    const key = [cwd, recipeDir, profileName ?? "", requestedAgentName ?? ""].join("\0");
    if (state?.key === key) return state;

    const manifest = readPiPackageManifest(recipeDir);
    const validation = validatePiPackageManifest(manifest);
    const errors = validation.findings.filter((finding) => finding.severity === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((finding) => finding.message).join("\n"));
    }

    const resolved = resolveRecipeAgentDefinition({
      recipeDir,
      profileName,
      agentName: requestedAgentName,
    });
    if (profileName && !resolved.profile) {
      throw new Error(`Recipe profile not found: ${profileName}`);
    }
    if (!resolved.agent) {
      throw new Error(`Recipe agent not found: ${resolved.agentName}`);
    }

    state = {
      key,
      cwd,
      recipeDir,
      manifest,
      profileName,
      agentName: resolved.agentName,
      agent: resolved.agent,
      profile: resolved.profile,
      skillPaths: packageResourcePaths(manifest, "skills"),
      promptPaths: packageResourcePaths(manifest, "prompts"),
      themePaths: packageResourcePaths(manifest, "themes"),
      extensionPaths: packageResourcePaths(manifest, "extensions"),
      extensionsLoaded: false,
      configured: false,
    };
    return state;
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
        const factory = await loadRecipeExtensionFactory(extensionPath);
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
      launchState.profile ? `profile:${launchState.profile.name}` : undefined,
      `agent:${launchState.agentName}`,
    ].filter(Boolean);
    pi.setSessionName(labelParts.join(" "));

    const modelSpec = launchState.profile?.model?.name ?? launchState.agent.model?.name;
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

    const thinkingLevel =
      launchState.profile?.model?.thinkingLevel ?? launchState.agent.model?.thinkingLevel;
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
    onUpdate?: RecipeAgentToolUpdate
  ): Promise<ChildRun> {
    const id = `recipe-agent-${++childRunIndex}`;
    const runRoot = join(tmpdir(), "pi-recipe-agent-runs", id);
    mkdirSync(runRoot, { recursive: true });
    let run: ChildRun | undefined;
    const runner = createRecipeRunner({
      recipeDir: launchState.recipeDir,
      env,
      agentName,
      adapter: {
        transcriptSink: {
          emit(event) {
            if (!run) return;
            const assistant = assistantTranscriptText(event);
            if (!assistant) return;
            if (assistant.stream === "delta") {
              run.output = `${run.output ?? ""}${assistant.text}`;
            } else if (!run.output?.trim()) {
              run.output = assistant.text;
            }
            emitRunUpdate(run, onUpdate);
          },
        },
      },
      context: launchContextFromPortableEnv({
        ...env,
        PI_TASK_ID: id,
        PI_RUN_ID: id,
        PI_RECIPE_DIR: launchState.recipeDir,
        PI_WORKSPACE_DIR: launchState.cwd,
        PI_REPOS_DIR: launchState.cwd,
        PI_OUTPUTS_DIR: join(runRoot, "outputs"),
        PI_UPLOADS_DIR: join(runRoot, "uploads"),
        PI_MEMORIES_DIR: join(runRoot, "memories"),
      }),
    });
    run = {
      id,
      agent: agentName,
      task,
      status: "running",
      startedAt: new Date().toISOString(),
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
    onUpdate?: RecipeAgentToolUpdate
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

    const run = await runChildAgent(state, agent.name, params.task, onUpdate);
    run.label = params.label;
    emitRunUpdate(run, onUpdate);
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
      description: "Recipe folder to use for this Pi session",
      type: "string",
    });
    pi.registerFlag("recipe-profile", {
      description: "Recipe profile to use",
      type: "string",
    });
    pi.registerFlag("recipe-agent", {
      description: "Recipe agent to use",
      type: "string",
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
        async execute(_runId, params: RunRecipeAgentParams, signal, onUpdate) {
          return await handleAgentTool(params, signal, onUpdate);
        },
      })
    );

    pi.on("session_start", async (_event, ctx) => {
      const launchState = loadState(pi, ctx.cwd);
      if (!launchState) return;
      await loadRecipeExtensions(pi, ctx, launchState);
      await configureSession(pi, ctx, launchState);
      ctx.ui.notify(
        `Recipe: ${launchState.manifest.name}@${launchState.manifest.version} (${basename(launchState.recipeDir)})`,
        "info"
      );
    });

    pi.on("resources_discover", (event) => {
      const launchState = loadState(pi, event.cwd);
      if (!launchState) return {};
      return {
        skillPaths: launchState.skillPaths,
        promptPaths: launchState.promptPaths,
        themePaths: launchState.themePaths,
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      const launchState = loadState(pi, ctx.cwd);
      if (!launchState) return {};
      const base = loadRecipeSystemPrompt(launchState.recipeDir) ?? event.systemPrompt;
      const recipePrompt = applySystemInstructions(
        applySystemInstructions(
          base,
          launchState.profile?.systemInstructions
        ),
        launchState.agent.systemInstructions
      );
      const systemPrompt = runtimeContextPrompt(recipePrompt, launchState);
      return { systemPrompt };
    });
  };
}

export default createPiRecipesExtension();
