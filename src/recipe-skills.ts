import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";

function skillName(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (match) {
      const frontmatter = parse(match[1] ?? "");
      if (
        frontmatter &&
        typeof frontmatter === "object" &&
        typeof frontmatter.name === "string" &&
        frontmatter.name.trim()
      ) {
        return frontmatter.name.trim();
      }
    }
  } catch {
    // Pi's resource loader reports content and schema diagnostics later.
  }
  return basename(dirname(filePath));
}

function discoverSkillFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return basename(path) === "SKILL.md" ? [path] : [];
  if (!stat.isDirectory()) return [];

  const direct = join(path, "SKILL.md");
  if (existsSync(direct) && statSync(direct).isFile()) return [direct];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => discoverSkillFiles(join(path, entry.name)));
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
  void recipeDir;
  return [
    ...new Set(
      resourcePaths
        .flatMap(discoverSkillFiles)
        .filter((path) => selected.has(skillName(path)))
    ),
  ].sort();
}
