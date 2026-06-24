import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ORG = "introspection-recipes";
const ROOT = process.cwd();
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const RECIPES_EXTENSION = join(ROOT, "dist", "pi-extension.js");
const TURN_PROMPT = "This is a system test. Do not use tools. Reply with exactly: RECIPE_OK";
const SKILL_PROMPT = "Reply exactly: SKILL_OK";
const TOOL_OK = "RECIPE_TOOL_OK";

function loadDotEnv(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return env;
}

const env = {
  ...process.env,
  ...loadDotEnv(),
  PI_OFFLINE: "1",
};
const SYSTEM_MODEL = env.RECIPE_SYSTEM_MODEL ?? "openai/gpt-5.4";

async function run(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 180_000;
  const maxBuffer = 1024 * 1024 * 20;
  return await new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        killed = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        killed = true;
        child.kill("SIGTERM");
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      reject(new Error([
        `Command failed: ${cmd} ${args.join(" ")}`,
        `code: ${code ?? "<unknown>"}`,
        `signal: ${signal ?? "<none>"}`,
        `killed: ${killed}`,
        "--- stdout ---",
        stdout,
        "--- stderr ---",
        stderr,
      ].join("\n")));
    });
  });
}

function readJson(text) {
  return JSON.parse(text);
}

function readYamlFile(path) {
  return parseYaml(readFileSync(path, "utf8")) ?? {};
}

function hasPiManifest(dir) {
  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const manifest = readJson(readFileSync(packagePath, "utf8"));
    return Boolean(
      manifest.pi &&
        typeof manifest.pi === "object" &&
        !Array.isArray(manifest.pi) &&
        Object.keys(manifest.pi).length > 0
    );
  } catch {
    return false;
  }
}

function findRecipeDirs(repoDir) {
  const dirs = new Set();
  function visit(dir) {
    const parts = relative(repoDir, dir).split("/");
    if (parts.includes(".git") || parts.includes("node_modules") || parts.includes("dist")) return;
    if (hasPiManifest(dir)) dirs.add(dir);
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
    }
  }
  visit(repoDir);
  return [...dirs].sort();
}

function readManifest(recipeDir) {
  return readJson(readFileSync(join(recipeDir, "package.json"), "utf8"));
}

function recipeConfig(recipeDir) {
  const manifest = readManifest(recipeDir);
  return manifest.pi ?? {};
}

function manifestName(recipeDir) {
  return readManifest(recipeDir).name ?? basename(recipeDir);
}

function normalizeResourcePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasGlob(value) {
  return /[*?[\]{}]/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  const normalized = normalizeResourcePath(glob);
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function listFiles(root) {
  const files = [];
  function visit(dir, relativeDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  }
  visit(root);
  return files;
}

function resourceGlobs(recipeDir, key) {
  const config = recipeConfig(recipeDir);
  if (Array.isArray(config[key]) && config[key].length > 0) return config[key];
  const defaults = {
    agents: ["agents/*.yaml", "agents/*.yml"],
    skills: ["skills/**/SKILL.md"],
  };
  return defaults[key] ?? [];
}

function resourceFiles(recipeDir, key) {
  const globs = resourceGlobs(recipeDir, key);
  const allFiles = globs.some(hasGlob) ? listFiles(recipeDir) : [];
  const matches = new Set();
  for (const glob of globs) {
    const normalized = normalizeResourcePath(glob);
    if (!hasGlob(normalized)) {
      const full = join(recipeDir, normalized);
      if (existsSync(full) && statSync(full).isFile()) matches.add(resolve(full));
      continue;
    }
    const matcher = globToRegExp(normalized);
    for (const file of allFiles) {
      if (matcher.test(normalizeResourcePath(file))) matches.add(resolve(recipeDir, file));
    }
  }
  return [...matches].sort();
}

function readAgents(recipeDir) {
  return resourceFiles(recipeDir, "agents").map((path) => {
    const data = readYamlFile(path);
    return {
      name: data.name ?? basename(path).replace(/\.ya?ml$/i, ""),
      model: data.model?.name,
      tools: Array.isArray(data.tools) ? data.tools : [],
    };
  });
}

function readSkills(recipeDir) {
  return resourceFiles(recipeDir, "skills").map((path) => {
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter = match ? parseYaml(match[1]) ?? {} : {};
    return {
      name: frontmatter.name ?? basename(join(path, "..")),
      path,
    };
  });
}

function patchAgentModels(recipeDir, modelName) {
  for (const path of resourceFiles(recipeDir, "agents")) {
    const data = readYamlFile(path);
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const model = data.model && typeof data.model === "object" && !Array.isArray(data.model)
      ? data.model
      : {};
    model.name = modelName;
    data.model = model;
    writeFileSync(path, stringifyYaml(data));
  }
}

function defaultAgent(recipeDir) {
  const agents = readAgents(recipeDir);
  return (
    agents.find((agent) => agent.name === "agent") ??
    (agents.length === 1 ? agents[0] : undefined)
  );
}

function sourceSlug(source) {
  return basename((source.split("#")[0] ?? source).replace(/\/+$/g, ""));
}

async function discoverRecipes(root) {
  const repos = readJson((await run("gh", [
    "repo",
    "list",
    ORG,
    "--limit",
    "200",
    "--json",
    "nameWithOwner,isArchived",
  ])).stdout).filter((repo) => !repo.isArchived);

  const cloneRoot = join(root, "repos");
  const recipes = [];
  for (const repo of repos) {
    const repoName = basename(repo.nameWithOwner);
    const repoDir = join(cloneRoot, repoName);
    await run("gh", ["repo", "clone", repo.nameWithOwner, repoDir, "--", "--depth", "1"], { timeout: 180_000 });
    for (const recipeDir of findRecipeDirs(repoDir)) {
      const rel = relative(repoDir, recipeDir);
      const source = rel ? `github:${repo.nameWithOwner}/${rel}` : `github:${repo.nameWithOwner}`;
      recipes.push({
        source,
        slug: sourceSlug(source),
        recipeDir,
        name: manifestName(recipeDir),
      });
    }
  }
  return recipes.sort((a, b) => a.source.localeCompare(b.source));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireOpenAIKey() {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Cannot run recipe work prompts: OPENAI_API_KEY is not set.");
  }
}

function parseJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function sessionFiles(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .sort();
}

function newSessionFile(sessionDir, before) {
  const previous = new Set(before);
  const created = sessionFiles(sessionDir).filter((path) => !previous.has(path));
  assert(created.length === 1, `Expected exactly one new session file, found ${created.length}`);
  return created[0];
}

function textBlocks(message) {
  return (message.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

function toolCallNames(entries) {
  const names = [];
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "toolResult" && message.toolName) names.push(message.toolName);
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "toolCall" && block.name) names.push(block.name);
      }
    }
  }
  return [...new Set(names)];
}

function assertSession(entries, expected) {
  const sessionInfo = entries.filter((entry) => entry.type === "session_info").at(-1);
  assert(sessionInfo?.name === expected.sessionName, [
    `Expected session name "${expected.sessionName}"`,
    `Actual: ${sessionInfo?.name ?? "<missing>"}`,
  ].join("\n"));

  const modelChange = entries.find(
    (entry) =>
      entry.type === "model_change" &&
      entry.provider === "openai" &&
      entry.modelId === "gpt-5.4"
  );
  assert(Boolean(modelChange), `Session did not record model_change to ${SYSTEM_MODEL}`);

  const assistant = entries
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => entry.message)
    .at(-1);
  assert(Boolean(assistant), "Session did not record an assistant message");
  assert(assistant.provider === "openai", `Assistant provider was ${assistant.provider}`);
  assert(assistant.model === "gpt-5.4", `Assistant model was ${assistant.model}`);
}

async function runPiTurn({ recipe, agentName, prompt, sessionDir, label, expectText }) {
  const before = sessionFiles(sessionDir);
  const args = [
    "--extension",
    RECIPES_EXTENSION,
    "--recipe",
    recipe.slug,
    "--session-dir",
    sessionDir,
    "--mode",
    "text",
    "-p",
    prompt,
  ];
  if (agentName) args.splice(4, 0, "--agent", agentName);

  const result = await run(PI_BIN, args, { timeout: 240_000 });
  assert(!/Recipe extension failed to load|Extension error|declares extensions glob with no matches/.test(result.stderr), [
    `Pi reported an extension/runtime loading problem during ${label}:`,
    result.stderr,
  ].join("\n"));
  if (expectText) {
    assert(result.stdout.includes(expectText), [
      `${label} did not include ${expectText}`,
      "--- stdout ---",
      result.stdout,
      "--- stderr ---",
      result.stderr,
    ].join("\n"));
  }

  const sessionPath = newSessionFile(sessionDir, before);
  const entries = parseJsonl(sessionPath);
  return { ...result, sessionPath, entries };
}

async function getRecipeCommands(recipe, sessionDir) {
  const child = spawn(PI_BIN, [
    "--extension",
    RECIPES_EXTENSION,
    "--recipe",
    recipe.slug,
    "--session-dir",
    sessionDir,
    "--mode",
    "rpc",
  ], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let buffer = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "response" && message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  function send(command) {
    return new Promise((resolveSend, reject) => {
      const id = `req_${pending.size + 1}_${Date.now()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for RPC ${command.type}. Stderr:\n${stderr}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveSend(message);
      });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  try {
    await new Promise((resolveStart) => setTimeout(resolveStart, 500));
    const state = await send({ type: "get_state" });
    assert(state.success, `RPC get_state failed for ${recipe.source}`);
    assert(state.data?.sessionName, `RPC state did not expose a recipe session for ${recipe.source}`);
    const response = await send({ type: "get_commands" });
    assert(response.success, `RPC get_commands failed for ${recipe.source}`);
    assert(!/Recipe extension failed to load|Extension error|declares extensions glob with no matches/.test(stderr), [
      `Pi reported an extension/runtime loading problem while listing commands for ${recipe.source}:`,
      stderr,
    ].join("\n"));
    return response.data.commands;
  } finally {
    child.kill("SIGTERM");
  }
}

function chooseToolExercise(agent) {
  const tools = new Set(agent?.tools ?? []);
  if (tools.has("shell_command")) {
    return {
      name: "shell_command",
      prompt: [
        "Use the shell_command tool exactly once to run this command in the current workspace:",
        "printf RECIPE_TOOL_OK",
        "After the tool returns, reply exactly: RECIPE_TOOL_OK",
      ].join("\n"),
    };
  }
  if (tools.has("todo_write")) {
    return {
      name: "todo_write",
      prompt: [
        "Use the todo_write tool exactly once with one completed todo.",
        "Use id 'system-test', content 'system test', activeForm 'testing', and status 'completed'.",
        "After the tool returns, reply exactly: RECIPE_TOOL_OK",
      ].join("\n"),
    };
  }
  return undefined;
}

async function main() {
  requireOpenAIKey();

  const root = mkdtempSync(join(tmpdir(), "pi-recipes-system-"));
  const storeDir = join(root, "store");
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  env.PI_RECIPES_HOME = storeDir;
  env.GITHUB_TOKEN = env.GITHUB_TOKEN || env.GH_TOKEN || (await run("gh", ["auth", "token"])).stdout.trim();
  env.GH_TOKEN = env.GH_TOKEN || env.GITHUB_TOKEN;

  try {
    console.log("Building pi-recipes...");
    await run("pnpm", ["build"], { timeout: 120_000 });

    console.log(`Discovering recipes in ${ORG}...`);
    const recipes = await discoverRecipes(root);
    const sources = recipes.map((recipe) => recipe.source);
    console.log(sources.map((source) => `- ${source}`).join("\n"));
    assert(sources.length > 0, "No recipes discovered");

    for (const recipe of recipes) {
      console.log(`\n=== ${recipe.source}`);
      console.log(`Installing ${recipe.source}`);
      const installed = readJson((await run("node", ["dist/cli.js", "install", recipe.source, "--store", storeDir, "--json"], {
        timeout: 180_000,
      })).stdout);
      assert(existsSync(installed.path), `Installed path does not exist: ${installed.path}`);
      patchAgentModels(installed.path, SYSTEM_MODEL);
      const installedDefaultAgent = defaultAgent(installed.path);
      const installedAgents = readAgents(installed.path);
      const installedSkills = readSkills(installed.path);

      assert(installedDefaultAgent, `Recipe has no default agent: ${recipe.source}`);
      assert(installedAgents.length > 0, `Recipe has no agents: ${recipe.source}`);

      console.log("Validating path resolution");
      const byName = (await run("node", ["dist/cli.js", "path", installed.name, "--store", storeDir])).stdout.trim();
      const bySlug = (await run("node", ["dist/cli.js", "path", recipe.slug, "--store", storeDir])).stdout.trim();
      assert(byName === installed.path, `Name resolution failed for ${installed.name}`);
      assert(bySlug === installed.path, `Slug resolution failed for ${recipe.slug}`);

      console.log("Running doctor");
      const doctor = (await run("node", ["dist/cli.js", "doctor", recipe.slug, "--store", storeDir])).stdout;
      assert(doctor.includes("ok"), `Doctor failed for ${recipe.source}:\n${doctor}`);

      console.log("Checking command and skill registration via Pi RPC");
      const commands = await getRecipeCommands(recipe, sessionDir);
      const commandNames = new Set(commands.map((command) => command.name));
      assert(commandNames.has("recipe"), `Missing /recipe command for ${recipe.source}`);
      for (const skill of installedSkills) {
        assert(commandNames.has(`skill:${skill.name}`), `Missing /skill:${skill.name} for ${recipe.source}`);
      }

      const expectedDefaultSessionName = `${installed.name}@${installed.version} agent:${installedDefaultAgent.name}`;
      console.log(`Running default agent ${installedDefaultAgent.name} on ${SYSTEM_MODEL}`);
      const defaultRun = await runPiTurn({
        recipe,
        prompt: TURN_PROMPT,
        sessionDir,
        label: `${recipe.source} default agent`,
        expectText: "RECIPE_OK",
      });
      assertSession(defaultRun.entries, { sessionName: expectedDefaultSessionName });

      for (const agent of installedAgents.filter((agent) => agent.name !== installedDefaultAgent.name)) {
        console.log(`Running explicit agent ${agent.name} on ${SYSTEM_MODEL}`);
        const agentRun = await runPiTurn({
          recipe,
          agentName: agent.name,
          prompt: TURN_PROMPT,
          sessionDir,
          label: `${recipe.source} agent ${agent.name}`,
          expectText: "RECIPE_OK",
        });
        assertSession(agentRun.entries, {
          sessionName: `${installed.name}@${installed.version} agent:${agent.name}`,
        });
      }

      for (const skill of installedSkills) {
        console.log(`Invoking /skill:${skill.name}`);
        const skillRun = await runPiTurn({
          recipe,
          prompt: `/skill:${skill.name} ${SKILL_PROMPT}`,
          sessionDir,
          label: `${recipe.source} skill ${skill.name}`,
          expectText: "SKILL_OK",
        });
        assertSession(skillRun.entries, { sessionName: expectedDefaultSessionName });
        const userText = skillRun.entries
          .filter((entry) => entry.type === "message" && entry.message.role === "user")
          .flatMap((entry) => textBlocks(entry.message))
          .join("\n");
        assert(userText.includes(`<skill name="${skill.name}"`), `/skill:${skill.name} was not expanded in the session JSONL`);
      }

      const toolExercise = chooseToolExercise(installedDefaultAgent);
      if (toolExercise) {
        console.log(`Exercising custom tool ${toolExercise.name}`);
        const toolRun = await runPiTurn({
          recipe,
          prompt: toolExercise.prompt,
          sessionDir,
          label: `${recipe.source} tool ${toolExercise.name}`,
          expectText: TOOL_OK,
        });
        assertSession(toolRun.entries, { sessionName: expectedDefaultSessionName });
        const tools = toolCallNames(toolRun.entries);
        assert(tools.includes(toolExercise.name), [
          `Expected ${toolExercise.name} tool call for ${recipe.source}`,
          `Actual tool calls: ${tools.join(", ") || "(none)"}`,
          `Session: ${toolRun.sessionPath}`,
        ].join("\n"));
      } else {
        console.log("No recipe-specific safe custom tool exercise for default agent");
      }

      console.log("PASS");
    }

    console.log("\nVERDICT: PASS");
  } finally {
    if (env.KEEP_RECIPE_SYSTEM_TEST_ARTIFACTS === "1") {
      console.log(`Kept system test artifacts at ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("\nVERDICT: FAIL");
  process.exitCode = 1;
});
