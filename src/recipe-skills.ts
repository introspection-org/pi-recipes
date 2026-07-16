import {
  loadSkills,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

function diagnosticSkillName(filePath: string): string {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
    if (typeof frontmatter.name === "string" && frontmatter.name.trim()) {
      return frontmatter.name.trim();
    }
  } catch {
    // Pi's resource loader will report the underlying read or parse failure.
  }
  return basename(dirname(filePath));
}

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
  const { skills, diagnostics } = loadSkills({
    cwd: recipeDir,
    agentDir: recipeDir,
    skillPaths: resourcePaths,
    includeDefaults: false,
  });
  const selectedPaths = new Set(
    skills
      .filter((skill) => selected.has(skill.name))
      .map((skill) => skill.filePath)
  );

  // Keep selected files that Pi could discover but could not load. Passing the
  // physical file to Pi's resource loader preserves its validation diagnostic
  // instead of silently dropping a configured skill. Diagnostics from
  // unselected skills remain outside the active agent's resource scope.
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.path &&
      selected.has(diagnosticSkillName(diagnostic.path))
    ) {
      selectedPaths.add(diagnostic.path);
    }
  }

  return [...selectedPaths];
}
