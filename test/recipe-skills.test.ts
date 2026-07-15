import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentSkillPaths } from "../src/recipe-skills.js";

describe("recipe agent skills", () => {
  it("exposes only skills selected by the active agent", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skills-"));
    try {
      const skillsDir = join(root, "skills");
      const parentSkill = join(skillsDir, "parent-only", "SKILL.md");
      const explorerSkill = join(skillsDir, "explorer-only", "SKILL.md");
      mkdirSync(join(skillsDir, "parent-only"), { recursive: true });
      mkdirSync(join(skillsDir, "explorer-only"), { recursive: true });
      writeFileSync(parentSkill, "---\ndescription: Parent guidance\n---\n");
      writeFileSync(explorerSkill, "---\ndescription: Explorer guidance\n---\n");

      expect(resolveAgentSkillPaths(root, [skillsDir], ["explorer-only"])).toEqual([
        explorerSkill,
      ]);
      expect(resolveAgentSkillPaths(root, [skillsDir], [])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects a skill by its frontmatter name", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-skill-name-"));
    try {
      const skillPath = join(root, "skills", "folder-name", "SKILL.md");
      mkdirSync(join(root, "skills", "folder-name"), { recursive: true });
      writeFileSync(
        skillPath,
        "---\nname: public-name\ndescription: Named guidance\n---\n"
      );

      expect(
        resolveAgentSkillPaths(root, [join(root, "skills")], ["public-name"])
      ).toEqual([skillPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
