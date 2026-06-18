import type {
  ConversationItem,
  MaterializedRecipe,
  ModelCredential,
  ModelCredentialRequest,
  RunnerLaunchContext,
  RunnerLifecycleEvent,
  RunnerResourceBundle,
} from "./types.js";

export interface RecipeProvider<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
> {
  materializeRecipe(context: TContext): Promise<TRecipe>;
}

export interface ResourceProvider<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> {
  resolveResources(context: TContext, recipe: TRecipe): Promise<TResources>;
}

export interface ResourceSync<TResources = RunnerResourceBundle> {
  syncDown(resources: TResources): Promise<void>;
  syncUp(resources: TResources): Promise<void>;
}

export interface LifecycleSink {
  emit(event: RunnerLifecycleEvent): Promise<void>;
}

export interface ConversationHistoryProvider {
  getConversationItemByResponseId(
    conversationId: string,
    responseId: string
  ): Promise<ConversationItem | null>;
}

export interface TelemetryAdapter {
  init(context: RunnerLaunchContext): void | Promise<void>;
  shutdown(): void | Promise<void>;
}

export interface ModelCredentialProvider {
  resolveCredential(
    request: ModelCredentialRequest
  ): Promise<ModelCredential | null>;
}

export interface RunnerSessionDriver {
  start(): Promise<void>;
  prompt(input: unknown): Promise<unknown>;
  cancel(runId?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export type RunnerSessionFactory<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> = (
  context: TContext,
  recipe: TRecipe,
  resources: TResources
) => RunnerSessionDriver | Promise<RunnerSessionDriver>;

export interface RunnerPlatformAdapter<
  TContext extends RunnerLaunchContext = RunnerLaunchContext,
  TRecipe extends MaterializedRecipe = MaterializedRecipe,
  TResources = RunnerResourceBundle,
> {
  recipes: RecipeProvider<TContext, TRecipe>;
  resources: ResourceProvider<TContext, TRecipe, TResources>;
  resourceSync?: ResourceSync<TResources>;
  lifecycle?: LifecycleSink;
  conversationHistory?: ConversationHistoryProvider;
  telemetry?: TelemetryAdapter;
  modelCredentials?: ModelCredentialProvider;
  session?: RunnerSessionDriver;
  createSession?: RunnerSessionFactory<TContext, TRecipe, TResources>;
}

export class NoopLifecycleSink implements LifecycleSink {
  async emit(): Promise<void> {}
}

export class NoopResourceSync implements ResourceSync {
  async syncDown(): Promise<void> {}
  async syncUp(): Promise<void> {}
}
