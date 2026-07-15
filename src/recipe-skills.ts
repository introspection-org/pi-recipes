import { loadSkills } from "@earendil-works/pi-coding-agent";

/**
 * Resolve the package's physical skill resources to the subset selected by an
 * agent definition. Selection controls Pi discovery and prompt exposure; it
 * does not remove the remaining recipe files from the shared sandbox.
 */
export function resolveAgentSkillPaths(
  recipeDir: string,
  resourcePaths: string[],
  selectedNames: readonly string[]
): string[] {
  if (selectedNames.length === 0 || resourcePaths.length === 0) return [];

  const selected = new Set(selectedNames);
  const { skills } = loadSkills({
    cwd: recipeDir,
    agentDir: recipeDir,
    skillPaths: resourcePaths,
    includeDefaults: false,
  });
  return skills
    .filter((skill) => selected.has(skill.name))
    .map((skill) => skill.filePath);
}
