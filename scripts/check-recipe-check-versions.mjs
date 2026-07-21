import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ),
);

const core = metadata.packages.find(
  (candidate) => candidate.name === "pi-recipe-check",
);
const binding = metadata.packages.find(
  (candidate) => candidate.name === "pi-recipe-check-python",
);

if (!core || !binding) {
  throw new Error("pi-recipe-check workspace packages are missing");
}

if (binding.version !== core.version) {
  throw new Error(
    `Python binding version ${binding.version} does not match pi-recipe-check ${core.version}`,
  );
}

const coreDependency = binding.dependencies.find(
  (dependency) => dependency.name === core.name,
);
const expectedRequirement = `^${core.version}`;

if (!coreDependency || coreDependency.req !== expectedRequirement) {
  throw new Error(
    `Python binding must require pi-recipe-check ${core.version}; found ${coreDependency?.req ?? "no dependency"}`,
  );
}

console.log(`pi-recipe-check artifacts are locked at ${core.version}`);

// The per-platform binary packages are optionalDependencies pinned to this
// package's exact version. release-please links their versions, and this guard
// catches any future configuration drift before a release can silently pin a
// version that was never published. A missing optional dependency does not fail
// installation; recipe-check would simply be absent at runtime.
const rootManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const optional = rootManifest.optionalDependencies ?? {};
const platformPackages = Object.keys(optional).filter((name) =>
  name.startsWith("@introspection-ai/recipe-check-"),
);
if (platformPackages.length === 0) {
  throw new Error(
    "No @introspection-ai/recipe-check-* optionalDependencies found; the binary would ship nowhere.",
  );
}
for (const name of platformPackages) {
  if (optional[name] !== rootManifest.version) {
    throw new Error(
      `${name} is pinned to ${optional[name]}, but this package is ${rootManifest.version}; they must match exactly.`,
    );
  }
  const dir = name.replace("@introspection-ai/", "");
  const own = JSON.parse(
    readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), "utf8"),
  );
  if (own.version !== rootManifest.version) {
    throw new Error(
      `packages/${dir} is at ${own.version}, but this package is ${rootManifest.version}; they must match exactly.`,
    );
  }
}
console.log(
  `recipe-check binary packages locked at ${rootManifest.version} (${platformPackages.length} platforms)`,
);
