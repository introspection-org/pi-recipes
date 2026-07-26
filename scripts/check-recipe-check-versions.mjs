import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    }
  )
);

const core = metadata.packages.find(
  (candidate) => candidate.name === "pi-recipe-check"
);
const binding = metadata.packages.find(
  (candidate) => candidate.name === "pi-recipe-check-python"
);

if (!core || !binding) {
  throw new Error("pi-recipe-check workspace packages are missing");
}
if (binding.version !== core.version) {
  throw new Error(
    `Python binding version ${binding.version} does not match pi-recipe-check ${core.version}`
  );
}

const coreDependency = binding.dependencies.find(
  (dependency) => dependency.name === core.name
);
const expectedRequirement = `^${core.version}`;
if (!coreDependency || coreDependency.req !== expectedRequirement) {
  throw new Error(
    `Python binding must require pi-recipe-check ${core.version}; found ${coreDependency?.req ?? "no dependency"}`
  );
}

console.log(`pi-recipe-check artifacts are locked at ${core.version}`);
