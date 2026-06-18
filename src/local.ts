import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  ModelCredentialProvider,
  RecipeProvider,
  ResourceProvider,
  ResourceSync,
  RunnerPlatformAdapter,
} from "./adapter.js";
import { launchContextFromPortableEnv } from "./env.js";
import { createRecipeRunner, type RecipeRunner } from "./runner.js";
import {
  PiAgentSessionDriver,
  type PiAgentSessionTool,
  type RecipeAgentRunSink,
} from "./session.js";
import type {
  MaterializedRecipe,
  ModelCredential,
  ModelCredentialRequest,
  RunnerLaunchContext,
  RunnerResourceBundle,
  RunnerTranscriptSink,
} from "./types.js";
import { readPiPackageManifest } from "./recipe-package.js";

export class LocalRecipeProvider implements RecipeProvider {
  constructor(
    private readonly recipeDir?: string,
    private readonly source: NodeJS.ProcessEnv = process.env
  ) {}

  async materializeRecipe(
    context: RunnerLaunchContext
  ): Promise<MaterializedRecipe> {
    const agentDir = resolve(this.recipeDir || this.source.PI_RECIPE_DIR || "");
    if (!agentDir || !existsSync(agentDir)) {
      throw new Error(`Local recipe directory does not exist: ${agentDir}`);
    }
    const pkg = readPiPackageManifest(agentDir);
    return {
      source: "local_path",
      agentDir,
      packageName: pkg.name,
      packageVersion: pkg.version,
      packagePath: context.workspace.workspaceDir,
    };
  }
}

export class LocalResourceProvider implements ResourceProvider {
  async resolveResources(
    context: RunnerLaunchContext,
    recipe: MaterializedRecipe
  ): Promise<RunnerResourceBundle> {
    const workspaceDir = context.workspace.workspaceDir;
    const repositories = existsSync(workspaceDir)
      ? [
          {
            type: "repository" as const,
            name: basename(workspaceDir) || "workspace",
            repositoryPath: workspaceDir,
            mountPath: workspaceDir,
            access: "read_write" as const,
          },
        ]
      : [];
    return {
      recipe,
      repositories,
      files: [],
      memories: [],
      skills: [],
      secrets: [],
      tools: [],
      connectors: [],
      outputMounts: [
        {
          type: "output_mount",
          mountPath: context.workspace.outputsDir,
          persistPrefix: "outputs",
          persistAs: "local",
        },
      ],
    };
  }
}

export class LocalResourceSync implements ResourceSync {
  async syncDown(resources: RunnerResourceBundle): Promise<void> {
    mkdirSync(resources.recipe.packagePath || ".", { recursive: true });
    for (const output of resources.outputMounts) {
      mkdirSync(output.mountPath, { recursive: true });
    }
  }

  async syncUp(_resources: RunnerResourceBundle): Promise<void> {}
}

export class LocalModelCredentialProvider implements ModelCredentialProvider {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  async resolveCredential(
    request: ModelCredentialRequest
  ): Promise<ModelCredential | null> {
    const provider = request.provider.toLowerCase();
    const key =
      provider === "openai"
        ? this.source.OPENAI_API_KEY
        : provider === "anthropic"
          ? this.source.ANTHROPIC_API_KEY
          : provider === "google" || provider === "gemini"
            ? this.source.GOOGLE_API_KEY
            : undefined;
    if (!key) return null;
    return { apiKey: key };
  }
}

export interface LocalRecipeAdapterOptions {
  session?: boolean;
  tools?: PiAgentSessionTool[];
  defaultModel?: string;
  enableRecipeAgents?: boolean;
  recipeAgentRunSink?: RecipeAgentRunSink;
  transcriptSink?: RunnerTranscriptSink;
}

export function createLocalRecipeAdapter(
  recipeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LocalRecipeAdapterOptions = {}
): RunnerPlatformAdapter {
  const modelCredentials = new LocalModelCredentialProvider(env);
  return {
    recipes: new LocalRecipeProvider(recipeDir, env),
    resources: new LocalResourceProvider(),
    resourceSync: new LocalResourceSync(),
    modelCredentials,
    transcript: opts.transcriptSink,
    createSession:
      opts.session === false
        ? undefined
        : (context, recipe) =>
            new PiAgentSessionDriver({
              context,
              recipe,
              modelCredentials,
              tools: opts.tools,
              defaultModel: opts.defaultModel,
              enableRecipeAgents: opts.enableRecipeAgents,
              recipeAgentRunSink: opts.recipeAgentRunSink,
              transcriptSink: opts.transcriptSink,
            }),
  };
}

export function createLocalRecipeRunner(
  opts: {
    recipeDir?: string;
    env?: NodeJS.ProcessEnv;
    context?: RunnerLaunchContext;
    profileName?: string;
    agentName?: string;
    adapter?: LocalRecipeAdapterOptions;
  } = {}
): RecipeRunner {
  const env = opts.env ?? process.env;
  return createRecipeRunner({
    adapter: createLocalRecipeAdapter(opts.recipeDir, env, opts.adapter),
    context: opts.context ?? launchContextFromPortableEnv(env),
    profileName: opts.profileName,
    agentName: opts.agentName,
  });
}
