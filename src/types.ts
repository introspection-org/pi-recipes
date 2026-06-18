export type RecipeSource = "local_path" | "git_checkout" | "baked";

export interface MaterializedRecipe {
  source: RecipeSource;
  agentDir: string;
  packageName?: string;
  packageVersion?: string;
  expectedCommit?: string;
  resolvedCommit?: string;
  repositoryId?: string;
  repositoryPath?: string;
  packagePath?: string | null;
}

export interface WorkspaceLayout {
  workspaceDir: string;
  reposDir: string;
  uploadsDir: string;
  outputsDir: string;
  memoriesDir: string;
  binDir?: string;
  skillsDir?: string;
}

export interface RepositoryResource {
  type: "repository";
  id?: string;
  name: string;
  repositoryPath?: string;
  mountPath: string;
  access: "read_only" | "read_write";
  gitRef?: string | null;
  gitCommitSha?: string | null;
}

export interface FileResource {
  type: "file";
  id?: string;
  name: string;
  mountPath: string;
  access: "read_only" | "read_write";
  checksum?: string;
}

export interface MemoryResource {
  type: "memory";
  mountPath: string;
  access: "read_only" | "read_write" | "proposed_write";
}

export interface SkillResource {
  type: "skill";
  name: string;
  versionRef?: string;
  mountPath?: string;
  visibility: "visible" | "hidden" | "metadata_only";
}

export interface SecretResource {
  type: "secret";
  name: string;
  access: "brokered" | "env" | "file";
}

export interface ToolCapabilityResource {
  type: "tool_capability";
  name: string;
  policy: "allowed" | "ask" | "denied";
}

export interface ConnectorResource {
  type: "connector";
  name: string;
  source: "builtin" | "byok" | "mcp" | "native";
}

export interface OutputMountResource {
  type: "output_mount";
  mountPath: string;
  persistPrefix: string;
  persistAs: "artifact" | "local";
}

export interface RunnerResourceBundle {
  recipe: MaterializedRecipe;
  repositories: RepositoryResource[];
  files: FileResource[];
  memories: MemoryResource[];
  skills: SkillResource[];
  secrets: SecretResource[];
  tools: ToolCapabilityResource[];
  connectors: ConnectorResource[];
  outputMounts: OutputMountResource[];
}

export interface RunnerLaunchContext {
  runId: string;
  taskId?: string;
  conversationId?: string;
  projectId?: string;
  profileName?: string;
  agentName?: string;
  metadata: Record<string, unknown>;
  workspace: WorkspaceLayout;
}

export type RunnerLifecycleEventType =
  | "started"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "metadata";

export interface RunnerLifecycleEvent {
  type: RunnerLifecycleEventType;
  runId?: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export type RunnerTranscriptEventType =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "session_started"
  | "session_completed"
  | "user_prompt"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "skill_loaded"
  | "skill_used"
  | "agent_run_started"
  | "agent_run_completed";

export interface RunnerTranscriptEvent {
  type: RunnerTranscriptEventType;
  runId: string;
  occurredAt: Date;
  agentName?: string;
  data: Record<string, unknown>;
}

export interface RunnerTranscriptSink {
  emit(event: RunnerTranscriptEvent): void | Promise<void>;
}

export interface ConversationItem {
  id: string;
  inputMessages?: unknown[];
  outputMessage?: unknown;
}

export interface ModelCredentialRequest {
  provider: string;
  model?: string;
}

export interface ModelCredential {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}
