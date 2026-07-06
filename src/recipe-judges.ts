import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const JUDGE_CONTRACT_VERSION = "1.1";
const TOOL_RESULT_TRUNCATE_BYTES = 4096;
const DEFAULT_CLIP_CHARS = 4000;
const TOKEN_BUDGET = 200_000;
const REDACTION_RESERVE = 48;
const TURN_OVERHEAD = 6;
const ABSTAIN_VERDICT = "not_applicable";
const CANONICAL_VERDICTS = new Set(["pass", "fail", ABSTAIN_VERDICT]);

export type RecipeJudgeLabel = "pass" | "fail";
export type RecipeJudgeVerdict = "pass" | "fail" | "not_applicable" | "error";
export type RecipeJudgeMode = "verify" | "render" | "eval" | "run";
export type RecipeJudgeGateEvent = "message" | "tool" | "feedback";
export type RecipeJudgeToolStatus = "ok" | "error";
export type RecipeJudgeMessageRole = "system" | "user" | "assistant" | "tool";
export type RecipeJudgeFeedbackSentiment = "positive" | "negative" | "unknown";

export interface RecipeJudgeDefinition {
  judge: string;
  description?: string;
  on?: unknown;
  model?: {
    name?: string;
    temperature?: number;
  };
  instructions?: string;
  labels?: Record<string, string>;
  path?: string;
}

export interface RecipeJudgeToolCall {
  ordinal: number;
  agent: string;
  turn: number;
  name: string;
  status: RecipeJudgeToolStatus;
  ref: string;
  truncated: boolean;
  args?: unknown;
  result?: unknown;
}

export interface RecipeJudgeMessage {
  ordinal: number;
  agent: string;
  turn: number;
  role: RecipeJudgeMessageRole;
  text: string;
  ref: string;
}

export interface RecipeJudgeFeedbackEvent {
  id: string;
  timestamp?: string | null;
  service_name?: string | null;
  conversation_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  name?: string | null;
  sentiment: RecipeJudgeFeedbackSentiment;
  comments?: string | null;
  source?: string | null;
  channel?: string | null;
  surface?: string | null;
  message_id?: string | null;
  turn_id?: string | null;
  response_id?: string | null;
  user_id?: string | null;
  anonymous_id?: string | null;
  agent_name?: string | null;
  agent_id?: string | null;
  attributes?: Record<string, unknown> | null;
}

export interface RecipeJudgeConversation {
  conversation_id: string;
  contract_version: string;
  sequence_hash: string;
  model?: string | null;
  environment?: string | null;
  runtime_group?: string | null;
  status: RecipeJudgeToolStatus;
  tool_calls: RecipeJudgeToolCall[];
  messages: RecipeJudgeMessage[];
  feedback_events: RecipeJudgeFeedbackEvent[];
  tool_call_count: number;
  message_count: number;
  feedback_count: number;
}

export interface RecipeJudgeCalibrationRow {
  conversation_id: string;
  label: RecipeJudgeLabel;
  split?: string;
  conversation: RecipeJudgeConversation;
}

export interface RecipeJudgeOptions {
  mode: RecipeJudgeMode;
  judge?: string;
  datasetPath?: string;
  conversationPath?: string;
  split?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RecipeJudgeVerificationResult {
  mode: "verify";
  recipe: string;
  datasetPath: string;
  rows: number;
  errors: string[];
  labels: Record<string, number>;
  splits: Record<string, number>;
}

export interface RecipeJudgeRenderResult {
  mode: "render";
  recipe: string;
  judge: string;
  rows: Array<{
    conversationId: string;
    label: RecipeJudgeLabel;
    split?: string;
    transcript: string | null;
  }>;
}

export interface RecipeJudgeEvalMetrics {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  n: number;
  acc: number;
  tpr: number;
  tnr: number;
  kappa: number;
  abstain: number;
  error: number;
}

export interface RecipeJudgeEvalResult {
  mode: "eval";
  recipe: string;
  judge: string;
  datasetPath: string;
  split?: string;
  rows: Array<{
    conversationId: string;
    label: RecipeJudgeLabel;
    verdict: RecipeJudgeVerdict;
    reasoning?: string;
  }>;
  metrics: RecipeJudgeEvalMetrics;
}

export interface RecipeJudgeRunResult {
  mode: "run";
  recipe: string;
  conversationId: string;
  rows: Array<{
    judge: string;
    verdict: RecipeJudgeVerdict;
    reasoning?: string;
  }>;
}

export type RecipeJudgesResult =
  | RecipeJudgeVerificationResult
  | RecipeJudgeRenderResult
  | RecipeJudgeEvalResult
  | RecipeJudgeRunResult;

class MatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatcherError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellLabel(path: string): string {
  return basename(path).replace(/\.(ya?ml|jsonl?)$/i, "");
}

function normalizedJudgePath(recipeDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(recipeDir, path);
}

export function loadRecipeJudgeDefinitions(recipeDir: string): RecipeJudgeDefinition[] {
  const dir = join(recipeDir, "judges");
  if (!existsSync(dir)) return [];
  const out: RecipeJudgeDefinition[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const path = join(dir, file);
    const parsed = parseYaml(readFileSync(path, "utf8")) as RecipeJudgeDefinition | undefined;
    if (!parsed || typeof parsed !== "object" || !parsed.judge) continue;
    if (seen.has(parsed.judge)) {
      throw new Error(`duplicate judge name "${parsed.judge}" in ${dir}`);
    }
    seen.add(parsed.judge);
    out.push({ ...parsed, path });
  }
  return out;
}

function selectedJudges(recipeDir: string, selector?: string): RecipeJudgeDefinition[] {
  const judges = loadRecipeJudgeDefinitions(recipeDir);
  if (!selector) return judges;

  const maybePath = normalizedJudgePath(recipeDir, selector);
  if (existsSync(maybePath)) {
    const parsed = parseYaml(readFileSync(maybePath, "utf8")) as RecipeJudgeDefinition | undefined;
    if (!parsed || typeof parsed !== "object" || !parsed.judge) {
      throw new Error(`Judge file does not declare a judge name: ${selector}`);
    }
    return [{ ...parsed, path: maybePath }];
  }

  const selected = judges.filter(
    (judge) => judge.judge === selector || (judge.path && shellLabel(judge.path) === selector)
  );
  if (selected.length === 0) {
    throw new Error(`Recipe has no judge named ${selector}`);
  }
  return selected;
}

function parseCalibrationRows(path: string): { rows: RecipeJudgeCalibrationRow[]; errors: string[] } {
  const rows: RecipeJudgeCalibrationRow[] = [];
  const errors: string[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const lineNumber = index + 1;
    let parsed: RecipeJudgeCalibrationRow;
    try {
      parsed = JSON.parse(trimmed) as RecipeJudgeCalibrationRow;
    } catch {
      errors.push(`line ${lineNumber}: not valid JSON`);
      return;
    }
    if (parsed.label !== "pass" && parsed.label !== "fail") {
      errors.push(`line ${lineNumber}: label must be "pass" or "fail"`);
    }
    if (!parsed.conversation || typeof parsed.conversation !== "object") {
      errors.push(`line ${lineNumber}: missing conversation`);
    } else {
      const c = parsed.conversation;
      if (!c.conversation_id) errors.push(`line ${lineNumber}: conversation.conversation_id required`);
      if (!c.sequence_hash) errors.push(`line ${lineNumber}: conversation.sequence_hash required`);
      if (!Array.isArray(c.messages)) errors.push(`line ${lineNumber}: conversation.messages[] required`);
      if (!Array.isArray(c.tool_calls)) errors.push(`line ${lineNumber}: conversation.tool_calls[] required`);
      if (!Array.isArray(c.feedback_events)) errors.push(`line ${lineNumber}: conversation.feedback_events[] required`);
    }
    rows.push(parsed);
  });
  return { rows, errors };
}

function distribution(rows: RecipeJudgeCalibrationRow[], key: (row: RecipeJudgeCalibrationRow) => string): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = key(row);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fmt(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function clip(text: string): string {
  if (text.length <= DEFAULT_CLIP_CHARS) return text;
  return `${text.slice(0, DEFAULT_CLIP_CHARS)}...`;
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderMessage(message: RecipeJudgeMessage): string {
  const tag = message.role === "tool" ? "TOOL MESSAGE" : message.role.toUpperCase();
  return `${tag}:\n${indent(clip(message.text))}`.replace(/\s+$/, "");
}

function renderToolCall(call: RecipeJudgeToolCall): string {
  const status = call.status === "error" ? "ERROR" : "ok";
  const lines = [`TOOL ${call.name} (${status})`];
  if (call.args !== null && call.args !== undefined) {
    lines.push(`  in  ${clip(fmt(call.args))}`);
  }
  if (call.result !== null && call.result !== undefined) {
    const label = call.status === "error" ? "err" : "out";
    lines.push(`  ${label} ${clip(fmt(call.result))}`);
  } else if (call.truncated) {
    const label = call.status === "error" ? "err" : "out";
    lines.push(`  ${label} [truncated before capture]`);
  }
  return lines.join("\n");
}

function renderFeedback(event: RecipeJudgeFeedbackEvent): string {
  const name = event.name ? ` ${event.name}` : "";
  const lines = [`FEEDBACK ${event.sentiment}${name}`];
  if (event.comments) lines.push(`  comments ${clip(event.comments)}`);
  if (event.source) lines.push(`  source ${event.source}`);
  if (event.channel) lines.push(`  channel ${event.channel}`);
  if (event.surface) lines.push(`  surface ${event.surface}`);
  if (event.agent_name) lines.push(`  agent ${event.agent_name}`);
  if (event.message_id) lines.push(`  message_id ${event.message_id}`);
  if (event.turn_id) lines.push(`  turn_id ${event.turn_id}`);
  if (event.response_id) lines.push(`  response_id ${event.response_id}`);
  return lines.join("\n");
}

interface RenderEntry {
  ordinal: number;
  turn: number;
  text: string;
}

function turnHeader(turn: number): string {
  return turn <= 0 ? "SETUP" : `TURN ${turn}`;
}

function walkTurns(entries: RenderEntry[]): string[] {
  const lines: string[] = [];
  let current: number | null = null;
  for (const entry of entries) {
    if (entry.turn !== current) {
      current = entry.turn;
      lines.push("", turnHeader(current));
    }
    lines.push(entry.text);
  }
  return lines;
}

function fitEntries(entries: RenderEntry[], budget: number): { head: RenderEntry[]; tail: RenderEntry[]; dropped: number } {
  const cost = (entry: RenderEntry) => estimateTokens(entry.text) + TURN_OVERHEAD;
  const total = entries.reduce((sum, entry) => sum + cost(entry), 0);
  if (total <= budget) return { head: entries, tail: [], dropped: 0 };

  const head: RenderEntry[] = [];
  const tail: RenderEntry[] = [];
  let used = 0;
  let lo = 0;
  let hi = entries.length - 1;
  let takeHead = true;
  while (lo <= hi) {
    const entry = takeHead ? entries[lo]! : entries[hi]!;
    if (used + cost(entry) > budget) break;
    used += cost(entry);
    if (takeHead) {
      head.push(entry);
      lo++;
    } else {
      tail.unshift(entry);
      hi--;
    }
    takeHead = !takeHead;
  }
  return { head, tail, dropped: entries.length - head.length - tail.length };
}

export function renderJudgeConversation(conversation: RecipeJudgeConversation): string | null {
  const systemMessages = conversation.messages.filter((message) => message.role === "system");
  const entries: RenderEntry[] = [];
  for (const message of conversation.messages) {
    if (message.role === "system") continue;
    entries.push({
      ordinal: message.ordinal,
      turn: message.turn,
      text: renderMessage(message),
    });
  }
  for (const call of conversation.tool_calls) {
    entries.push({
      ordinal: call.ordinal,
      turn: call.turn,
      text: renderToolCall(call),
    });
  }
  entries.sort((a, b) => a.ordinal - b.ordinal);

  if (entries.length === 0 && conversation.feedback_events.length === 0) return null;

  const status = conversation.status === "error" ? "ERROR" : "ok";
  const header =
    `model=${conversation.model ?? "?"} - ` +
    `env=${conversation.environment ?? "?"} - status=${status}\n` +
    `${conversation.message_count} message(s) - ` +
    `${conversation.tool_call_count} tool call(s) - ` +
    `${conversation.feedback_count} feedback event(s)`;

  const systemBlock = systemMessages.length
    ? ["", "SYSTEM", ...systemMessages.map((message) => renderMessage(message))]
        .join("\n")
        .replace(/\nSYSTEM:\n/g, "\n")
    : "";
  const feedbackBlock = conversation.feedback_events.length
    ? ["", "FEEDBACK", ...conversation.feedback_events.map(renderFeedback)].join("\n")
    : "";
  const budgetForEntries = Math.max(
    0,
    TOKEN_BUDGET -
      estimateTokens(header) -
      estimateTokens(systemBlock) -
      estimateTokens(feedbackBlock) -
      REDACTION_RESERVE
  );
  const { head, tail, dropped } = fitEntries(entries, budgetForEntries);

  const parts = [header];
  if (systemBlock) parts.push(systemBlock);
  parts.push(...walkTurns(head));
  if (dropped > 0) {
    parts.push("", `... ${dropped} item(s) redacted to fit the ${Math.round(TOKEN_BUDGET / 1000)}k-token budget ...`);
  }
  parts.push(...walkTurns(tail));
  if (feedbackBlock) parts.push(feedbackBlock);
  return parts.join("\n");
}

const VALID_GATE_EVENTS = new Set<RecipeJudgeGateEvent>(["message", "tool", "feedback"]);
const EXACT_FIELDS = new Set([
  "name",
  "role",
  "status",
  "sentiment",
  "source",
  "channel",
  "surface",
  "message_id",
  "turn_id",
  "response_id",
  "user_id",
  "anonymous_id",
  "agent_name",
  "agent_id",
  "service_name",
]);

type MatchableEvent = RecipeJudgeMessage | RecipeJudgeToolCall | RecipeJudgeFeedbackEvent;

function eventItems(event: RecipeJudgeGateEvent, conversation: RecipeJudgeConversation): MatchableEvent[] {
  if (event === "message") return conversation.messages;
  if (event === "tool") return conversation.tool_calls;
  return conversation.feedback_events;
}

function regexFromLiteral(value: string): RegExp | null {
  if (!value.startsWith("/")) return null;
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const pattern = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new MatcherError(`invalid regex ${JSON.stringify(value)}: ${(err as Error).message}`);
  }
}

function readPathParts(value: unknown, head: string, rest: string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => readPathParts(item, head, rest));
  if (!isRecord(value) || !(head in value)) return [];
  const next = value[head];
  if (rest.length === 0) return [next];
  const nextPath = rest.join(".");
  if (isRecord(next) && nextPath in next) return [next[nextPath]];
  const [nextHead, ...nextRest] = rest;
  return readPathParts(next, nextHead!, nextRest);
}

function readPath(value: unknown, path: string): unknown[] {
  if (!path) return [value];
  if (isRecord(value) && path in value) return [value[path]];
  const [head, ...rest] = path.split(".");
  return readPathParts(value, head!, rest);
}

function valuesForPath(item: MatchableEvent, path: string): unknown[] {
  return readPath(item, path).filter((value) => value !== undefined);
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function textLikeField(path: string): boolean {
  return (
    path === "text" ||
    path === "comments" ||
    path.startsWith("args.") ||
    path.startsWith("result.") ||
    path.startsWith("attributes.")
  );
}

function scalarMatches(path: string, value: unknown, target: unknown): boolean {
  if (Array.isArray(target)) return target.some((item) => scalarMatches(path, value, item));
  if (typeof target === "string") {
    const re = regexFromLiteral(target);
    const text = scalarString(value);
    if (re) return text !== null && re.test(text);
    if (typeof value !== "string") return value === target;
    if (EXACT_FIELDS.has(path) || !textLikeField(path)) return value === target;
    return value.toLowerCase().includes(target.toLowerCase());
  }
  return value === target;
}

function eventMatches(item: MatchableEvent, match: Record<string, unknown> | undefined): boolean {
  if (!match || Object.keys(match).length === 0) return true;
  for (const [path, target] of Object.entries(match)) {
    if (path === "event") throw new MatcherError("`event` belongs beside `match`, not inside it");
    const values = valuesForPath(item, path);
    if (values.length === 0) return false;
    if (!values.some((value) => scalarMatches(path, value, target))) return false;
  }
  return true;
}

export function evaluateJudgeGate(on: unknown, conversation: RecipeJudgeConversation): boolean {
  if (on === null || on === undefined || on === "") return true;
  if (isRecord(on) && Object.keys(on).length === 0) return true;
  if (!Array.isArray(on)) throw new MatcherError("judge `on` must be a list of event matchers");
  if (on.length === 0) return true;

  for (const rawMatcher of on) {
    if (!isRecord(rawMatcher) || typeof rawMatcher.event !== "string") {
      throw new MatcherError("each `on` entry must be `{ event, match? }`");
    }
    if (!VALID_GATE_EVENTS.has(rawMatcher.event as RecipeJudgeGateEvent)) {
      throw new MatcherError(`unknown judge gate event ${JSON.stringify(rawMatcher.event)}`);
    }
    for (const key of Object.keys(rawMatcher)) {
      if (key !== "event" && key !== "match") {
        throw new MatcherError(`unknown key ${JSON.stringify(key)} in judge gate event matcher`);
      }
    }
    if (rawMatcher.match !== undefined && !isRecord(rawMatcher.match)) {
      throw new MatcherError("`match` must be a mapping of field paths to values");
    }
    const items = eventItems(rawMatcher.event as RecipeJudgeGateEvent, conversation);
    if (items.some((item) => eventMatches(item, rawMatcher.match as Record<string, unknown> | undefined))) {
      return true;
    }
  }
  return false;
}

function normalizeText(text: string): string {
  return text.trim().split(/\s+/).join(" ").toLowerCase();
}

function iterStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(iterStrings);
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(iterStrings);
  return [];
}

function guardNoTranscriptSpans(output: unknown, transcript: string): void {
  const haystack = normalizeText(transcript);
  for (const value of iterStrings(output)) {
    const needle = normalizeText(value);
    if (needle.length < 60) continue;
    for (let start = 0; start <= needle.length - 60; start++) {
      if (haystack.includes(needle.slice(start, start + 60))) {
        throw new Error("judge output echoed a transcript span");
      }
    }
  }
}

function extractVerdict(output: Record<string, unknown>): RecipeJudgeVerdict {
  const raw = output.verdict;
  if (raw === null || raw === undefined || raw === "") {
    throw new Error("judge output missing verdict");
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!CANONICAL_VERDICTS.has(normalized)) {
    throw new Error(`judge output verdict ${JSON.stringify(raw)} is outside pass/fail/not_applicable`);
  }
  return normalized as RecipeJudgeVerdict;
}

function outboundModelName(model: string): string {
  if (model.startsWith("openai/")) return model.slice("openai/".length);
  if (model.startsWith("openai:")) return model.slice("openai:".length);
  return model;
}

function gatewayConfig(opts: RecipeJudgeOptions): { baseUrl: string; apiKey: string; user?: string } {
  const env = opts.env ?? process.env;
  const apiKey =
    opts.apiKey ??
    env.RECIPES_JUDGE_API_KEY ??
    env.OTARI_PROXY_KEY ??
    env.OPENAI_API_KEY;
  const baseUrl =
    opts.baseUrl ??
    env.RECIPES_JUDGE_BASE_URL ??
    env.OTARI_PROXY_URL ??
    (env.OPENAI_API_KEY ? ["https://api.openai.com", "v1"].join("/") : undefined);
  if (!apiKey || !baseUrl) {
    throw new Error(
      "Judge eval requires RECIPES_JUDGE_API_KEY and RECIPES_JUDGE_BASE_URL, or OPENAI_API_KEY for OpenAI."
    );
  }
  return {
    baseUrl,
    apiKey,
    user: env.RECIPES_JUDGE_USER,
  };
}

function parseModelOutput(content: string): Record<string, unknown> {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(stripped) as Record<string, unknown>;
}

const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail", "not_applicable"] },
  },
  required: ["reasoning", "verdict"],
  additionalProperties: false,
} as const;

async function gradeWithModel(
  judge: RecipeJudgeDefinition,
  conversation: RecipeJudgeConversation,
  opts: RecipeJudgeOptions
): Promise<{ verdict: RecipeJudgeVerdict; reasoning?: string }> {
  if (!evaluateJudgeGate(judge.on, conversation)) return { verdict: ABSTAIN_VERDICT };
  const transcript = renderJudgeConversation(conversation);
  if (transcript === null) return { verdict: ABSTAIN_VERDICT };

  const model = opts.model ?? judge.model?.name;
  if (!model) throw new Error(`Judge "${judge.judge}" must declare model.name or use --model`);
  const gw = gatewayConfig(opts);
  const base = gw.baseUrl.replace(/\/+$/, "");
  const versionSegment = "v1";
  const url = /\/v\d+$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/${versionSegment}/chat/completions`;
  const body: Record<string, unknown> = {
    model: outboundModelName(model),
    temperature: judge.model?.temperature ?? 0,
    messages: [
      { role: "system", content: judge.instructions ?? "" },
      { role: "user", content: transcript },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "JudgeVerdict",
        strict: true,
        schema: JUDGE_OUTPUT_SCHEMA,
      },
    },
  };
  if (gw.user) body.user = gw.user;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gw.apiKey}`,
      "Otari-Key": `Bearer ${gw.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`gateway returned ${res.status}`);
  const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error("gateway returned no content");
  const output = parseModelOutput(content);
  guardNoTranscriptSpans(output, transcript);
  const verdict = extractVerdict(output);
  return {
    verdict,
    ...(typeof output.reasoning === "string" ? { reasoning: output.reasoning } : {}),
  };
}

function metrics(pairs: Array<{ label: RecipeJudgeLabel; verdict: RecipeJudgeVerdict }>): RecipeJudgeEvalMetrics {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let abstain = 0;
  let error = 0;
  for (const { label, verdict } of pairs) {
    if (verdict === ABSTAIN_VERDICT) {
      abstain++;
      continue;
    }
    if (verdict === "error") {
      error++;
      continue;
    }
    if (label === "fail" && verdict === "fail") tp++;
    else if (label === "pass" && verdict === "pass") tn++;
    else if (label === "pass" && verdict === "fail") fp++;
    else fn++;
  }
  const n = tp + tn + fp + fn;
  const acc = n ? (tp + tn) / n : 0;
  const tpr = tp + fn ? tp / (tp + fn) : NaN;
  const tnr = tn + fp ? tn / (tn + fp) : NaN;
  const pe = n
    ? ((tp + fp) / n) * ((tp + fn) / n) + ((tn + fn) / n) * ((tn + fp) / n)
    : 0;
  const kappa = pe < 1 ? (acc - pe) / (1 - pe) : NaN;
  return { tp, tn, fp, fn, n, acc, tpr, tnr, kappa, abstain, error };
}

function loadConversation(path: string): RecipeJudgeConversation {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (isRecord(parsed) && isRecord(parsed.conversation)) {
    return parsed.conversation as unknown as RecipeJudgeConversation;
  }
  return parsed as RecipeJudgeConversation;
}

export function judgeConversationFromMessages(opts: {
  conversationId: string;
  messages: Array<{ role: RecipeJudgeMessageRole; text: string; agent?: string }>;
  model?: string | null;
  environment?: string | null;
}): RecipeJudgeConversation {
  let turn = 0;
  const messages = opts.messages.map((message, ordinal): RecipeJudgeMessage => {
    if (message.role === "user") turn += 1;
    return {
      ordinal,
      agent: message.agent ?? "agent",
      turn,
      role: message.role,
      text: message.text,
      ref: `${opts.conversationId}:message:${ordinal}`,
    };
  });
  const seqInput = messages.map((message) => `${message.ordinal}:${message.agent}:${message.ref}`).join("|");
  return {
    conversation_id: opts.conversationId,
    contract_version: JUDGE_CONTRACT_VERSION,
    sequence_hash: createHash("sha256").update(seqInput).digest("hex"),
    model: opts.model ?? null,
    environment: opts.environment ?? null,
    runtime_group: null,
    status: "ok",
    tool_calls: [],
    messages,
    feedback_events: [],
    tool_call_count: 0,
    message_count: messages.length,
    feedback_count: 0,
  };
}

export async function runRecipeJudges(
  recipeDir: string,
  recipeName: string,
  opts: RecipeJudgeOptions
): Promise<RecipeJudgesResult> {
  if (opts.mode === "verify") {
    if (!opts.datasetPath) throw new Error("recipes judges verify requires --dataset <jsonl>");
    const datasetPath = resolve(opts.datasetPath);
    const { rows, errors } = parseCalibrationRows(datasetPath);
    return {
      mode: "verify",
      recipe: recipeName,
      datasetPath,
      rows: rows.length,
      errors,
      labels: distribution(rows, (row) => row.label),
      splits: distribution(rows, (row) => row.split ?? "(none)"),
    };
  }

  const judges = selectedJudges(recipeDir, opts.judge);
  if (judges.length === 0) throw new Error(`Recipe ${recipeName} declares no judges in judges/*.yaml`);

  if (opts.mode === "render") {
    if (!opts.datasetPath) throw new Error("recipes judges render requires --dataset <jsonl>");
    if (judges.length !== 1) throw new Error("recipes judges render requires --judge when a recipe has multiple judges");
    const datasetPath = resolve(opts.datasetPath);
    const { rows, errors } = parseCalibrationRows(datasetPath);
    if (errors.length) throw new Error(`Calibration dataset has ${errors.length} invalid row(s); run verify first`);
    const selected = opts.split ? rows.filter((row) => row.split === opts.split) : rows;
    const judge = judges[0]!;
    return {
      mode: "render",
      recipe: recipeName,
      judge: judge.judge,
      rows: selected.map((row) => ({
        conversationId: row.conversation_id,
        label: row.label,
        ...(row.split ? { split: row.split } : {}),
        transcript: renderJudgeConversation(row.conversation),
      })),
    };
  }

  if (opts.mode === "eval") {
    if (!opts.datasetPath) throw new Error("recipes judges eval requires --dataset <jsonl>");
    if (judges.length !== 1) throw new Error("recipes judges eval requires --judge when a recipe has multiple judges");
    const datasetPath = resolve(opts.datasetPath);
    const { rows, errors } = parseCalibrationRows(datasetPath);
    if (errors.length) throw new Error(`Calibration dataset has ${errors.length} invalid row(s); run verify first`);
    const selected = opts.split ? rows.filter((row) => row.split === opts.split) : rows;
    const judge = judges[0]!;
    const results: RecipeJudgeEvalResult["rows"] = [];
    for (const row of selected) {
      try {
        const result = await gradeWithModel(judge, row.conversation, opts);
        results.push({
          conversationId: row.conversation_id,
          label: row.label,
          verdict: result.verdict,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        });
      } catch {
        results.push({
          conversationId: row.conversation_id,
          label: row.label,
          verdict: "error",
        });
      }
    }
    return {
      mode: "eval",
      recipe: recipeName,
      judge: judge.judge,
      datasetPath,
      ...(opts.split ? { split: opts.split } : {}),
      rows: results,
      metrics: metrics(results),
    };
  }

  if (!opts.conversationPath) throw new Error("recipes judges run requires --conversation <json>");
  const conversation = loadConversation(resolve(opts.conversationPath));
  const rows: RecipeJudgeRunResult["rows"] = [];
  for (const judge of judges) {
    try {
      const result = await gradeWithModel(judge, conversation, opts);
      rows.push({
        judge: judge.judge,
        verdict: result.verdict,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      });
    } catch {
      rows.push({ judge: judge.judge, verdict: "error" });
    }
  }
  return {
    mode: "run",
    recipe: recipeName,
    conversationId: conversation.conversation_id,
    rows,
  };
}
