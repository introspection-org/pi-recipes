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

function descriptionText(value: unknown, verbose: boolean): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (verbose || normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 159).trimEnd()}…`;
}

function schemaLines(
  value: unknown,
  indent: string,
  options: { verboseDescriptions?: boolean } = {}
): string[] {
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
    const compactDescription = descriptionText(
      descriptor.description,
      options.verboseDescriptions === true
    );
    const description = compactDescription ? ` — ${compactDescription}` : "";
    const nested = record(descriptor.properties);
    if (nested) {
      lines.push(`${indent}${name}${optional}: {`);
      lines.push(...schemaLines(descriptor, `${indent}  `, options));
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function exampleValue(value: unknown, name: string): unknown {
  const schema = record(value) ?? {};
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union?.length) return exampleValue(union[0], name);
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "boolean") return true;
  if (schema.type === "number" || schema.type === "integer") {
    return number(schema.minimum) ?? 1;
  }
  if (schema.type === "array") {
    const count = Math.max(1, number(schema.minItems) ?? 1);
    return Array.from({ length: count }, () => exampleValue(schema.items, "value"));
  }
  if (schema.type === "object" || record(schema.properties)) {
    const properties = record(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    return Object.fromEntries(
      required.map((field) => [field, exampleValue(properties[field], field)])
    );
  }
  return `<${name}>`;
}

function callValue(value: unknown, name: string): string {
  const example = exampleValue(value, name);
  return typeof example === "string"
    ? shellQuote(example)
    : typeof example === "object"
      ? shellQuote(JSON.stringify(example))
      : String(example);
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

function structuredBranch(value: unknown, kind: "object" | "array"): Schema | undefined {
  const schema = record(value);
  if (!schema) return undefined;
  if (
    (kind === "array" && schema.type === "array") ||
    (kind === "object" && (schema.type === "object" || record(schema.properties)))
  ) {
    return schema;
  }
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  return union.map((branch) => structuredBranch(branch, kind)).find(Boolean);
}

function structuredCallExample(server: string, tool: ContractTool): string | undefined {
  const schema = record(tool.inputSchema);
  const properties = record(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  for (const kind of ["object", "array"] as const) {
    for (const [name, descriptor] of Object.entries(properties)) {
      if (required.has(name)) continue;
      const branch = structuredBranch(descriptor, kind);
      if (!branch) continue;
      const json = JSON.stringify({ [name]: exampleValue(branch, name) });
      return `mcp call ${server}.${tool.name} --json ${shellQuote(json)}`;
    }
  }
  return undefined;
}

export interface ContractTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export function renderToolContract(
  server: string,
  tool: ContractTool,
  options: { verboseDescriptions?: boolean } = {}
): string {
  const lines = [`${server}.${tool.name}`];
  const description = descriptionText(
    tool.description,
    options.verboseDescriptions === true
  );
  if (description) {
    lines.push(description);
  }
  lines.push("", "input", ...schemaLines(tool.inputSchema, "  ", options));
  lines.push(
    "",
    "output",
    ...(schemaObject(tool.outputSchema)
      ? schemaLines(tool.outputSchema, "  ", options)
      : ["  unspecified"])
  );
  lines.push("", "call", `  ${callExample(server, tool)}`);
  const structured = structuredCallExample(server, tool);
  if (structured) lines.push(`  structured: ${structured}`);
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
