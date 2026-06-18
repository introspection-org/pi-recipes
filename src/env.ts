import { resolve } from "node:path";
import type { RunnerLaunchContext, WorkspaceLayout } from "./types.js";

export interface PortableRunnerEnv {
  taskId: string;
  runId: string;
  conversationId: string;
  projectId: string;
  recipeDir: string;
  profileName: string;
  agentName: string;
  metadataJson: string;
  workspace: WorkspaceLayout;
}

function readEnv(source: NodeJS.ProcessEnv, key: string): string {
  return source[key]?.trim() ?? "";
}

function readJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function workspaceFromPortableEnv(
  source: NodeJS.ProcessEnv = process.env
): WorkspaceLayout {
  const workspaceDir = resolve(
    readEnv(source, "PI_WORKSPACE_DIR") || ".workspace"
  );
  return {
    workspaceDir,
    reposDir: resolve(
      readEnv(source, "PI_REPOS_DIR") || `${workspaceDir}/repos`
    ),
    uploadsDir: resolve(
      readEnv(source, "PI_UPLOADS_DIR") || `${workspaceDir}/uploads`
    ),
    outputsDir: resolve(
      readEnv(source, "PI_OUTPUTS_DIR") || `${workspaceDir}/outputs`
    ),
    memoriesDir: resolve(
      readEnv(source, "PI_MEMORIES_DIR") || `${workspaceDir}/memories`
    ),
    binDir: resolve(
      readEnv(source, "PI_AGENT_BIN_DIR") || `${workspaceDir}/.pi/bin`
    ),
    skillsDir: resolve(
      readEnv(source, "PI_AGENT_SKILLS_DIR") || `${workspaceDir}/.pi/skills`
    ),
  };
}

export function loadPortableRunnerEnv(
  source: NodeJS.ProcessEnv = process.env
): PortableRunnerEnv {
  const taskId = readEnv(source, "PI_TASK_ID");
  const runId = readEnv(source, "PI_RUN_ID") || taskId;
  const conversationId = readEnv(source, "PI_CONVERSATION_ID") || runId;
  return {
    taskId,
    runId,
    conversationId,
    projectId: readEnv(source, "PI_PROJECT_ID"),
    recipeDir: readEnv(source, "PI_RECIPE_DIR"),
    profileName: readEnv(source, "PI_PROFILE_NAME"),
    agentName: readEnv(source, "PI_AGENT_NAME"),
    metadataJson: readEnv(source, "PI_TASK_METADATA_JSON"),
    workspace: workspaceFromPortableEnv(source),
  };
}

export function launchContextFromPortableEnv(
  source: NodeJS.ProcessEnv = process.env
): RunnerLaunchContext {
  const env = loadPortableRunnerEnv(source);
  return {
    taskId: env.taskId || undefined,
    runId: env.runId,
    conversationId: env.conversationId || undefined,
    projectId: env.projectId || undefined,
    profileName: env.profileName || undefined,
    agentName: env.agentName || undefined,
    metadata: readJsonObject(env.metadataJson),
    workspace: env.workspace,
  };
}
