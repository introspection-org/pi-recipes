import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/index.js";

describe("recipe package manifest", () => {
  it("reads pi package resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "recipe-package",
          version: "0.1.0",
          pi: {
            agents: ["./agents/*.yaml"],
            profiles: ["profiles/*.yaml"],
            extensions: ["extensions/*.ts"],
            skills: ["skills/**/SKILL.md"],
            themes: ["themes/*.json"],
          },
        })
      );

      const manifest = readPiPackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
      expect(manifest.resources.skills).toEqual(["skills/**/SKILL.md"]);
      expect(manifest.resources.themes).toEqual(["themes/*.json"]);
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands declared package resource globs and tolerates empty optional globs", async () => {
    const {
      packageResourcePaths,
      resolvePiPackageResourcePaths,
      RecipePackageError,
    } = await import("../src/index.js");
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      mkdirSync(join(root, "skills", "repo-index"), { recursive: true });
      writeFileSync(join(root, "skills", "repo-index", "SKILL.md"), "Index repos\n");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "recipe-package",
          version: "0.1.0",
          pi: {
            agents: ["agents/*.yaml"],
            skills: ["skills/**/SKILL.md"],
            themes: ["themes/*.json"],
          },
        })
      );

      const manifest = readPiPackageManifest(root);

      expect(packageResourcePaths(manifest, "skills")).toEqual([
        join(root, "skills", "repo-index", "SKILL.md"),
      ]);
      expect(packageResourcePaths(manifest, "themes")).toEqual([]);
      expect(() => resolvePiPackageResourcePaths(manifest, "agents")).toThrow(
        RecipePackageError
      );
      expect(() => resolvePiPackageResourcePaths(manifest, "agents")).toThrow(
        /glob with no matches/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports packages with no declared/default agents", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "recipe-package", version: "0.1.0" })
      );

      const report = validatePiPackageManifest(readPiPackageManifest(root));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([
        {
          severity: "warning",
          code: "package.no_agents",
          message: "Package declares no agents and has no agents directory",
          packageName: "recipe-package",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("package boundary", () => {
  it("keeps the package free of Introspection runtime dependencies", async () => {
    const root = join(import.meta.dirname, "..", "src");
    const files = await collectFiles(root);
    const forbidden = [
      "@introspection-sdk/",
      "INTROSPECTION_",
      "/v1/",
      "/internal/",
      "DPClient",
    ];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const token of forbidden) {
        expect(content, `${file} contains ${token}`).not.toContain(token);
      }
    }
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}
