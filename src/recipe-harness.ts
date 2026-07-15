import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createDefaultRecipeHostAdapter,
  createRecipeAgentSessionPlan,
  createRecipeChildAgentRunner,
  type RecipeAgentSessionPlan,
  type RecipeChildAgentRunner,
  type RecipeChildToolEvent,
  type RecipeHostAdapter,
} from "./child-agent.js";
import {
  assertCompiledRecipeArtifact,
  compileRecipe,
  type CompiledRecipeArtifact,
} from "./recipe-compile.js";

export type {
  RecipeAgentSessionPlan,
  RecipeChildAgentRunner,
  RecipeChildToolEvent,
  RecipeHostAdapter,
} from "./child-agent.js";

export interface CreateRecipeHarnessOptions {
  recipeDir: string;
  workspaceDir: string;
  artifact?: CompiledRecipeArtifact;
  hostAdapter?: RecipeHostAdapter;
  env?: NodeJS.ProcessEnv;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
}

export interface CreateRecipeHarnessRunnerOptions {
  agentName?: string;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}

export interface RecipeHarness {
  readonly artifact: CompiledRecipeArtifact;
  readonly hostAdapter: RecipeHostAdapter;
  plan(agentName?: string): RecipeAgentSessionPlan;
  createAgentRunner(opts?: CreateRecipeHarnessRunnerOptions): RecipeChildAgentRunner;
}

/**
 * Compile a recipe once and expose the same resolved session plan to local Pi,
 * managed hosts, eval runners, and tests. The host adapter owns infrastructure;
 * the harness owns recipe selection and portable agent semantics.
 */
export function createRecipeHarness(
  opts: CreateRecipeHarnessOptions
): RecipeHarness {
  const artifact =
    opts.artifact ?? compileRecipe({ recipeDir: opts.recipeDir });
  assertCompiledRecipeArtifact(artifact);
  const hostAdapter =
    opts.hostAdapter ?? createDefaultRecipeHostAdapter(opts);

  function plan(agentName?: string): RecipeAgentSessionPlan {
    return createRecipeAgentSessionPlan({
      recipeDir: opts.recipeDir,
      workspaceDir: opts.workspaceDir,
      artifact,
      agentName,
    });
  }

  return {
    artifact,
    hostAdapter,
    plan,
    createAgentRunner(runnerOpts = {}) {
      const selected = plan(runnerOpts.agentName);
      return createRecipeChildAgentRunner({
        recipeDir: opts.recipeDir,
        workspaceDir: opts.workspaceDir,
        agentName: selected.agentName,
        compiledRecipe: artifact,
        hostAdapter,
        env: opts.env,
        authStorage: opts.authStorage,
        modelRegistry: opts.modelRegistry,
        onAssistantMessage: runnerOpts.onAssistantMessage,
        onToolEvent: runnerOpts.onToolEvent,
      });
    },
  };
}
