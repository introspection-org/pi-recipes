import type { McpManifest } from "./mcp.js";

export interface McpCliSessionPolicy {
  servers: Map<
    string,
    {
      tools: Map<string, Set<string>>;
    }
  >;
}

export interface ValidatedMcpCliCommand {
  args: string[];
  forceNoOAuth: boolean;
}

export type McpCliPolicyResult =
  | { command: ValidatedMcpCliCommand; error?: undefined }
  | { command?: undefined; error: string };

const LIST_BOOLEAN_FLAGS = new Set([
  "--brief",
  "--signatures",
  "--schema",
  "--all-parameters",
  "--json",
  "--status",
  "--exit-code",
  "--quiet",
  "--no-oauth",
]);
const LIST_VALUE_FLAGS = new Set(["--timeout"]);

const CALL_BOOLEAN_FLAGS = new Set([
  "--raw-strings",
  "--no-coerce",
  "--no-oauth",
]);
const CALL_VALUE_FLAGS = new Set([
  "--args",
  "--json",
  "--output",
  "--save-images",
  "--timeout",
  "--oauth-timeout",
]);

const FORBIDDEN_DELEGATED_FLAGS = new Set([
  "--config",
  "--root",
  "--log-level",
  "--http-url",
  "--sse",
  "--stdio",
  "--stdio-bin",
  "--stdio-arg",
  "--header",
  "--env",
  "--cwd",
  "--name",
  "--description",
  "--persist",
  "--allow-http",
  "--insecure",
  "--yes",
  "--server",
  "--tool",
  "--tail-log",
]);

function flagName(value: string): string {
  const equals = value.indexOf("=");
  return equals === -1 ? value : value.slice(0, equals);
}

function toolSelector(value: string): { server: string; tool: string } | null {
  const expression = value.indexOf("(");
  const ref = (expression === -1 ? value : value.slice(0, expression)).trim();
  const dot = ref.indexOf(".");
  if (dot < 1 || dot === ref.length - 1) return null;
  return { server: ref.slice(0, dot), tool: ref.slice(dot + 1) };
}

function hasNoOAuth(args: readonly string[]): boolean {
  const literalSeparator = args.indexOf("--");
  const options = literalSeparator === -1 ? args : args.slice(0, literalSeparator);
  return options.some((arg) => flagName(arg) === "--no-oauth");
}

function withNoOAuth(args: readonly string[]): string[] {
  const literalSeparator = args.indexOf("--");
  if (literalSeparator === -1) return [...args, "--no-oauth"];
  return [
    ...args.slice(0, literalSeparator),
    "--no-oauth",
    ...args.slice(literalSeparator),
  ];
}

function consumeFlagValue(
  args: readonly string[],
  index: number,
  flag: string
): { nextIndex: number; error?: string } {
  const value = args[index + 1];
  if (value === undefined || (value.startsWith("-") && value !== "-")) {
    return { nextIndex: index, error: `${flag} expects a value.` };
  }
  return { nextIndex: index + 1 };
}

function closestName(input: string, candidates: Iterable<string>): string | undefined {
  const normalize = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const source = normalize(input);
  const distance = (left: string, right: string): number => {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= right.length; j += 1) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[right.length];
  };
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateDistance = distance(source, normalize(candidate));
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  if (!best) return undefined;
  const baseline = Math.max(source.length, normalize(best).length, 1);
  return bestDistance <= Math.max(2, Math.floor(baseline / 3)) ? best : undefined;
}

function validateExactTarget(
  policy: McpCliSessionPolicy,
  server: string,
  tool?: string
): string | null {
  const configured = policy.servers.get(server);
  if (!configured) {
    const available = [...policy.servers.keys()];
    const suggestion = closestName(server, available);
    return available.length > 0
      ? `MCP server '${server}' is not available in this session.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Available servers: ${available.join(", ")}.`
      : `MCP server '${server}' is not available in this session. No MCP servers are configured.`;
  }
  if (tool !== undefined && !configured.tools.has(tool)) {
    const suggestion = closestName(tool, configured.tools.keys());
    return `Tool '${tool}' is not available on server '${server}' in this session.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Run \`mcp list ${server}\` to inspect the callable tools.`;
  }
  return null;
}

function validateList(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  let target: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      if (target !== undefined) {
        return { error: "mcp list accepts at most one session server or server.tool target." };
      }
      target = arg;
      continue;
    }
    const flag = flagName(arg);
    if (FORBIDDEN_DELEGATED_FLAGS.has(flag)) {
      return { error: `mcp list option '${flag}' is unavailable in recipe sessions.` };
    }
    if (LIST_BOOLEAN_FLAGS.has(flag)) {
      if (arg !== flag) return { error: `${flag} does not accept a value.` };
      continue;
    }
    if (LIST_VALUE_FLAGS.has(flag)) {
      if (arg !== flag) return { error: `${flag} expects its value as the next argument.` };
      const consumed = consumeFlagValue(args, index, flag);
      if (consumed.error) return { error: consumed.error };
      index = consumed.nextIndex;
      continue;
    }
    return { error: `Unknown or unavailable mcp list option '${flag}'.` };
  }

  if (target === undefined) {
    const unsupported = args
      .slice(1)
      .map(flagName)
      .find((flag) => flag !== "--json" && flag !== "--no-oauth");
    if (unsupported) {
      return {
        error: `${unsupported} requires an exact session server or server.tool target.`,
      };
    }
  } else {
    if (/^(?:https?:\/\/|[^/]+\/)/i.test(target)) {
      return { error: "mcp list accepts only servers materialized for this recipe session; URLs and ad-hoc servers are unavailable." };
    }
    const selector = toolSelector(target);
    const server = selector?.server ?? target;
    const error = validateExactTarget(policy, server, selector?.tool);
    if (error) return { error };
  }
  const forceNoOAuth = !hasNoOAuth(args);
  return {
    command: {
      args: forceNoOAuth ? withNoOAuth(args) : args,
      forceNoOAuth,
    },
  };
}

function validateCall(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  const rawSelector = args[1];
  const selector = rawSelector ? toolSelector(rawSelector) : null;
  if (!selector) {
    return {
      error:
        "mcp call requires an exact session tool selector: mcp call <server>.<tool> key=value ...",
    };
  }
  if (/^(?:https?:\/\/|[^/]+\/)/i.test(selector.server)) {
    return { error: "mcp call accepts only tools materialized for this recipe session; URLs and ad-hoc servers are unavailable." };
  }
  const targetError = validateExactTarget(policy, selector.server, selector.tool);
  if (targetError) return { error: targetError };

  const inputParameters = policy.servers
    .get(selector.server)
    ?.tools.get(selector.tool) ?? new Set<string>();
  const delegatedArgs = args.slice(0, 2);
  let literal = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      literal = true;
      delegatedArgs.push(...args.slice(index));
      break;
    }
    if (literal || !arg.startsWith("--")) {
      delegatedArgs.push(arg);
      continue;
    }
    const flag = flagName(arg);
    if (FORBIDDEN_DELEGATED_FLAGS.has(flag)) {
      return { error: `mcp call option '${flag}' is unavailable in recipe sessions.` };
    }
    if (CALL_BOOLEAN_FLAGS.has(flag)) {
      if (arg !== flag) return { error: `${flag} does not accept a value.` };
      delegatedArgs.push(arg);
      continue;
    }
    if (CALL_VALUE_FLAGS.has(flag)) {
      if (arg !== flag) return { error: `${flag} expects its value as the next argument.` };
      const consumed = consumeFlagValue(args, index, flag);
      if (consumed.error) return { error: consumed.error };
      delegatedArgs.push(arg, args[consumed.nextIndex]);
      index = consumed.nextIndex;
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const rawKey = equals === -1 ? body : body.slice(0, equals);
    const key = rawKey.replace(/-([a-zA-Z0-9])/g, (_match, char: string) =>
      char.toUpperCase()
    );
    if (key && inputParameters.has(key)) {
      const value =
        equals === -1 ? args[index + 1] : body.slice(equals + 1);
      if (value === undefined) return { error: `Tool argument '--${rawKey}' expects a value.` };
      delegatedArgs.push(`${key}=${value}`);
      if (equals === -1) index += 1;
      continue;
    }
    return { error: `Unknown or unavailable mcp call option '${flag}'.` };
  }

  const forceNoOAuth = !hasNoOAuth(args);
  return {
    command: {
      args: forceNoOAuth ? withNoOAuth(delegatedArgs) : delegatedArgs,
      forceNoOAuth,
    },
  };
}

export function createMcpCliSessionPolicy(
  manifest: McpManifest
): McpCliSessionPolicy {
  return {
    servers: new Map(
      (manifest.servers ?? []).map((server) => [
        server.id,
        {
          tools: new Map(
            (server.tools ?? []).map((tool) => {
              const properties = tool.input_schema?.properties;
              return [
                tool.name,
                new Set(
                  properties && typeof properties === "object"
                    ? Object.keys(properties)
                    : []
                ),
              ];
            })
          ),
        },
      ])
    ),
  };
}

export function validateDelegatedMcpCommand(
  args: string[],
  policy: McpCliSessionPolicy
): McpCliPolicyResult {
  if (args[0] === "list") return validateList(args, policy);
  if (args[0] === "call") return validateCall(args, policy);
  return {
    error:
      args[0] === "auth"
        ? "Interactive authentication is unavailable in the agent MCP CLI. Ask the user to authenticate this MCP connection outside the agent session, then retry."
        : `mcp command '${args[0] ?? ""}' is unavailable in recipe sessions. Use mcp search, list, call, or run.`,
  };
}
