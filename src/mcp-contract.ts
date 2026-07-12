import type { McpManifestTool } from "./mcp.js";

type Schema = Record<string, unknown>;

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quoted(value: unknown): string {
  return JSON.stringify(value);
}

function constraintSuffix(schema: Schema): string {
  const constraints: string[] = [];
  const minimum = number(schema.minimum);
  const maximum = number(schema.maximum);
  if (minimum !== undefined || maximum !== undefined) {
    constraints.push(`${minimum ?? ""}..${maximum ?? ""}`);
  }
  const minLength = number(schema.minLength);
  const maxLength = number(schema.maxLength);
  if (minLength !== undefined) constraints.push(`minLength=${minLength}`);
  if (maxLength !== undefined) constraints.push(`maxLength=${maxLength}`);
  const minItems = number(schema.minItems);
  const maxItems = number(schema.maxItems);
  if (minItems !== undefined) constraints.push(`minItems=${minItems}`);
  if (maxItems !== undefined) constraints.push(`maxItems=${maxItems}`);
  if (schema.default !== undefined) constraints.push(`default=${quoted(schema.default)}`);
  return constraints.length > 0 ? ` [${constraints.join(", ")}]` : "";
}

export function compactSchemaType(value: unknown): string {
  const schema = record(value);
  if (!schema) return "unknown";
  if (schema.const !== undefined) return quoted(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(quoted).join(" | ");
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union) return union.map(compactSchemaType).join(" | ");
  if (schema.type === "array") {
    return `${compactSchemaType(schema.items)}[]${constraintSuffix(schema)}`;
  }
  if (schema.type === "object" || record(schema.properties)) {
    const properties = record(schema.properties);
    if (!properties || Object.keys(properties).length === 0) return "object";
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : []
    );
    const fields = Object.entries(properties).map(
      ([name, descriptor]) =>
        `${name}${required.has(name) ? "" : "?"}: ${compactSchemaType(descriptor)}`
    );
    return `{${fields.join(", ")}}`;
  }
  const type = schema.type === "number" ? "number" : schema.type;
  return `${typeof type === "string" ? type : "unknown"}${constraintSuffix(schema)}`;
}

function schemaLines(value: unknown, indent: string): string[] {
  const schema = record(value);
  if (!schema) return [`${indent}unknown`];
  const properties = record(schema.properties);
  if (!properties) return [`${indent}${compactSchemaType(schema)}`];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const lines: string[] = [];
  for (const [name, descriptorValue] of Object.entries(properties)) {
    const descriptor = record(descriptorValue) ?? {};
    const optional = required.has(name) ? "" : "?";
    const description =
      typeof descriptor.description === "string" && descriptor.description.trim()
        ? ` — ${descriptor.description.trim().replace(/\s+/g, " ")}`
        : "";
    const nested = record(descriptor.properties);
    if (nested) {
      lines.push(`${indent}${name}${optional}: {`);
      lines.push(...schemaLines(descriptor, `${indent}  `));
      lines.push(`${indent}}${description}`);
    } else {
      lines.push(`${indent}${name}${optional}: ${compactSchemaType(descriptor)}${description}`);
    }
  }
  return lines.length > 0 ? lines : [`${indent}{}`];
}

function schemaObject(value: unknown): Schema | undefined {
  return record(value);
}

function callValue(value: unknown, name: string): string {
  const schema = record(value) ?? {};
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union?.length) return callValue(union[0], name);
  if (schema.const !== undefined) return quoted(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return quoted(schema.enum[0]);
  if (schema.type === "boolean") return "true";
  if (schema.type === "number" || schema.type === "integer") {
    return String(number(schema.minimum) ?? 1);
  }
  if (schema.type === "array") {
    const count = Math.max(1, number(schema.minItems) ?? 1);
    const item = callValue(schema.items, "value");
    return `'[${Array.from({ length: count }, () => item).join(",")}]'`;
  }
  if (schema.type === "object" || record(schema.properties)) return "'{}'";
  return `"<${name}>"`;
}

function callExample(server: string, tool: ContractTool): string {
  const schema = record(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const args = required.map((name) => {
    const descriptor = record(properties[name]) ?? {};
    return `${name}=${callValue(descriptor, name)}`;
  });
  return `mcp call ${server}.${tool.name}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

export interface ContractTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export function renderToolContract(server: string, tool: ContractTool): string {
  const lines = [`${server}.${tool.name}`];
  if (tool.description?.trim()) {
    lines.push(tool.description.trim().replace(/\s+/g, " "));
  }
  lines.push("", "input", ...schemaLines(tool.inputSchema, "  "));
  lines.push(
    "",
    "output",
    ...(schemaObject(tool.outputSchema) ? schemaLines(tool.outputSchema, "  ") : ["  unspecified"])
  );
  lines.push("", "call", `  ${callExample(server, tool)}`);
  return `${lines.join("\n")}\n`;
}

export function renderToolSignature(
  server: string,
  tool: ContractTool,
  options: { allParameters?: boolean } = {}
): string {
  const schema = record(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const entries = Object.entries(properties);
  const included = new Set(
    entries.filter(([name]) => required.has(name)).map(([name]) => name)
  );
  if (!options.allParameters) {
    for (const [name] of entries) {
      if (included.size >= 5) break;
      included.add(name);
    }
  }
  const visible = options.allParameters
    ? entries
    : entries.filter(([name]) => included.has(name));
  const parameters = visible.map(([name, descriptor]) => {
    const optional = required.has(name) ? "" : "?";
    return `${name}${optional}: ${compactSchemaType(descriptor)}`;
  });
  const hidden = entries.length - visible.length;
  if (hidden > 0) parameters.push(`… +${hidden} optional`);
  return `${server}.${tool.name}(${parameters.join(", ")})`;
}

export function manifestOutputSchema(tool: McpManifestTool | undefined): unknown {
  return tool?.output_schema;
}
