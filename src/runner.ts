import type { RunnerPlatformAdapter, RunnerSessionDriver } from "./adapter.js";
import type {
  MaterializedRecipe,
  RunnerLaunchContext,
  RunnerLifecycleEvent,
  RunnerResourceBundle,
} from "./types.js";

export interface RecipeRunnerOptions<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> {
  adapter: RunnerPlatformAdapter<TContext, TRecipe, TResources>;
  context: TContext;
  profileName?: string;
  agentName?: string;
}

export interface RecipeRunnerState<
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> {
  recipe: TRecipe | null;
  resources: TResources | null;
  started: boolean;
}

export interface RecipeRunner<
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> {
  readonly state: RecipeRunnerState<TRecipe, TResources>;
  start(): Promise<RecipeRunnerState<TRecipe, TResources>>;
  prompt(input: unknown): Promise<unknown>;
  cancel(runId?: string): Promise<void>;
  shutdown(): Promise<void>;
}

function event(
  type: RunnerLifecycleEvent["type"],
  data: Record<string, unknown> = {},
  runId?: string
): RunnerLifecycleEvent {
  return {
    type,
    runId,
    occurredAt: new Date(),
    data,
  };
}

class RecipeRunnerImpl<
  TContext extends RunnerLaunchContext,
  TRecipe extends MaterializedRecipe,
  TResources,
> implements RecipeRunner<TRecipe, TResources> {
  readonly state: RecipeRunnerState<TRecipe, TResources> = {
    recipe: null,
    resources: null,
    started: false,
  };

  private session?: RunnerSessionDriver;

  constructor(
    private readonly opts: RecipeRunnerOptions<TContext, TRecipe, TResources>
  ) {}

  async start(): Promise<RecipeRunnerState<TRecipe, TResources>> {
    if (this.state.started) return this.state;

    const context = {
      ...this.opts.context,
      profileName:
        this.opts.profileName ?? this.opts.context.profileName ?? undefined,
      agentName:
        this.opts.agentName ?? this.opts.context.agentName ?? undefined,
    } as TContext;

    await this.opts.adapter.telemetry?.init(context);
    await this.opts.adapter.lifecycle?.emit(
      event(
        "started",
        {
          profile_name: context.profileName,
          agent_name: context.agentName,
        },
        context.runId
      )
    );

    const recipe = await this.opts.adapter.recipes.materializeRecipe(context);
    const resources = await this.opts.adapter.resources.resolveResources(
      context,
      recipe
    );
    await this.opts.adapter.resourceSync?.syncDown(resources);
    this.session =
      this.opts.adapter.session ??
      (await this.opts.adapter.createSession?.(context, recipe, resources));
    await this.session?.start();

    this.state.recipe = recipe;
    this.state.resources = resources;
    this.state.started = true;
    await this.opts.adapter.lifecycle?.emit(
      event("running", {}, context.runId)
    );
    return this.state;
  }

  async prompt(input: unknown): Promise<unknown> {
    if (!this.state.started) {
      await this.start();
    }
    if (!this.session) {
      throw new Error(
        "Recipe runner adapter does not provide a session driver"
      );
    }
    return await this.session.prompt(input);
  }

  async cancel(runId?: string): Promise<void> {
    await this.session?.cancel(runId);
    await this.opts.adapter.lifecycle?.emit(
      event("idle", { cancelled: true }, runId ?? this.opts.context.runId)
    );
  }

  async shutdown(): Promise<void> {
    if (this.state.resources) {
      await this.opts.adapter.resourceSync?.syncUp(this.state.resources);
    }
    await this.session?.shutdown();
    await this.opts.adapter.telemetry?.shutdown();
    await this.opts.adapter.lifecycle?.emit(
      event("completed", {}, this.opts.context.runId)
    );
  }
}

export function createRecipeRunner<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
>(
  opts: RecipeRunnerOptions<TContext, TRecipe, TResources>
): RecipeRunner<TRecipe, TResources> {
  return new RecipeRunnerImpl(opts);
}
