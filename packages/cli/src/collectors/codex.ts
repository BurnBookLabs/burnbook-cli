import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { usageEvidenceV2Schema, type UsageEvidenceV2 } from "@burnbook/schema";
import {
  migrateJsonlLineCursor,
  readJsonlTail,
  withJsonlContext,
  type JsonlByteCursor,
} from "../core/jsonl-tail.js";
import { AGENT_SUPPORT } from "./support.js";
import type {
  AgentCollector,
  CollectionCursor,
  CollectionInput,
  CollectionLimits,
  CollectionResult,
} from "./types.js";

const MAX_BYTES_PER_COLLECT = 4 * 1024 * 1024;
const SUPPORT = codexSupport();

function codexSupport() {
  const support = AGENT_SUPPORT.find((entry) => entry.agent === "codex");
  if (
    !support ||
    support.supportTier !== "preview" ||
    support.rankEligible ||
    support.evidenceClass !== "agent-local"
  ) {
    throw new Error("Codex collector registration must remain local, preview-only, and rank-ineligible.");
  }
  return support;
}

interface CumulativeUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

interface CodexCursorContext {
  sessionId?: string;
  turnId: string;
  model: string;
  agentVersion?: string;
  epoch: number;
  previous?: CumulativeUsage;
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export async function discoverRollouts(root = codexHome()): Promise<string[]> {
  const roots = [path.join(root, "sessions"), path.join(root, "archived_sessions")];
  const output: string[] = [];
  for (const candidate of roots) await walkJsonl(candidate, output);
  return output.sort();
}

async function walkJsonl(directory: string, output: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonl(child, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(child);
  }
}

export async function parseCodexRollout(
  filePath: string,
  cursor: CollectionCursor = 0,
  limits?: CollectionLimits,
): Promise<CollectionResult> {
  const evidence: UsageEvidenceV2[] = [];
  const diagnostics: string[] = [];
  let context = initialContext();
  let byteCursor = typeof cursor === "number" ? undefined : asCodexCursor(cursor);
  if (typeof cursor === "number" && cursor > 0) {
    const migrated = await migrateJsonlLineCursor(filePath, cursor, (line) => {
      context = applyCodexRecord(context, line.value, false).context;
    });
    byteCursor = withJsonlContext(migrated, context);
  }

  const tail = await readJsonlTail<CodexCursorContext>(filePath, {
    ...(byteCursor ? { cursor: byteCursor } : {}),
    context: initialContext(),
    maxBytes: MAX_BYTES_PER_COLLECT,
  });
  context = tail.cursor.context ?? context;
  let processedLine = tail.lines[0]?.line ? tail.lines[0].line - 1 : tail.cursor.line;
  let processedLines = 0;

  for (const line of tail.lines) {
    if (limits && processedLines >= limits.maxLines) break;
    processedLines += 1;
    processedLine = line.line;
    const applied = applyCodexRecord(context, line.value, true);
    context = applied.context;
    if (applied.diagnostic) diagnostics.push(applied.diagnostic);
    if (applied.evidence) evidence.push(applied.evidence);
    if (limits && evidence.length >= limits.maxEvidence) break;
  }

  const stoppedEarly = processedLine < tail.cursor.line;
  const resultCursor = withJsonlContext(
    stoppedEarly
      ? await migrateJsonlLineCursor(filePath, processedLine, () => {})
      : tail.cursor,
    context,
  );
  return {
    evidence,
    diagnostics,
    lastLine: processedLine,
    cursor: resultCursor,
    byteCursor: resultCursor,
  };
}

function applyCodexRecord(
  context: CodexCursorContext,
  value: string,
  report: boolean,
): { context: CodexCursorContext; evidence?: UsageEvidenceV2; diagnostic?: string } {
  if (!value.trim()) return { context };
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { context };
  }
  const payload = objectValue(record.payload);
  if (record.type === "session_meta") {
    return {
      context: {
        ...context,
        sessionId: stringValue(payload?.id) ?? context.sessionId,
        agentVersion: stringValue(payload?.cli_version) ?? context.agentVersion,
      },
    };
  }
  if (record.type === "turn_context") {
    return {
      context: {
        ...context,
        turnId: stringValue(payload?.turn_id) ?? context.turnId,
        model: stringValue(payload?.model) ?? context.model,
      },
    };
  }
  if (record.type !== "event_msg" || payload?.type !== "token_count") return { context };

  const info = objectValue(payload.info);
  const totalUsage = objectValue(info?.total_token_usage);
  const current = totalUsage ? readCumulative(totalUsage) : undefined;
  if (!current || !isValidCumulative(current)) {
    return {
      context,
      ...(report ? { diagnostic: "Ignored a Codex token_count record whose counters do not reconcile." } : {}),
    };
  }

  const reset = context.previous !== undefined && decreased(current, context.previous);
  const epoch = reset ? context.epoch + 1 : context.epoch;
  const delta = subtract(current, reset ? undefined : context.previous);
  const nextContext = { ...context, epoch, previous: current };
  if (delta.total === 0) return { context: nextContext };
  if (!isValidCumulative(delta)) {
    return {
      context,
      ...(report ? { diagnostic: "Ignored a Codex usage delta whose counters do not reconcile." } : {}),
    };
  }
  if (!context.sessionId) {
    return {
      context: nextContext,
      ...(report ? { diagnostic: "Ignored a Codex token_count record without valid cumulative usage identity." } : {}),
    };
  }
  const timestamp = stringValue(record.timestamp);
  if (!timestamp) {
    return {
      context: nextContext,
      ...(report ? { diagnostic: "Ignored a Codex token_count record without a provider timestamp." } : {}),
    };
  }

  const candidate = {
    schemaVersion: 2,
    agent: "codex",
    surface: "cli",
    source: "transcript",
    sourceVersion: SUPPORT.sourceVersion,
    collectorVersion: SUPPORT.collectorVersion,
    normalizerVersion: SUPPORT.normalizerVersion,
    evidenceClass: SUPPORT.evidenceClass,
    supportTier: SUPPORT.supportTier,
    eventId: eventId(context.sessionId, context.turnId, timestamp, epoch, current),
    sessionId: context.sessionId,
    occurredAt: timestamp,
    timeBasis: "provider",
    model: context.model,
    ...(context.agentVersion ? { agentVersion: context.agentVersion } : {}),
    inputTokens: delta.input - delta.cachedInput - delta.cacheWriteInput,
    cacheReadTokens: delta.cachedInput,
    cacheWriteTokens: delta.cacheWriteInput,
    outputTokens: delta.output - delta.reasoningOutput,
    reasoningTokens: delta.reasoningOutput,
    toolInputTokens: 0,
    totalTokens: delta.total,
  };
  const parsed = usageEvidenceV2Schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      context: nextContext,
      ...(report ? { diagnostic: "Ignored a Codex usage delta that failed the content-free evidence schema." } : {}),
    };
  }
  return { context: nextContext, evidence: parsed.data };
}

function initialContext(): CodexCursorContext {
  return { turnId: "turn", model: "unknown", epoch: 0 };
}

function asCodexCursor(cursor: JsonlByteCursor): JsonlByteCursor<CodexCursorContext> {
  const value = objectValue(cursor.context);
  const previousValue = objectValue(value?.previous);
  const previous = previousValue ? storedCumulative(previousValue) : undefined;
  return {
    ...cursor,
    context: {
      sessionId: stringValue(value?.sessionId),
      turnId: stringValue(value?.turnId) ?? "turn",
      model: stringValue(value?.model) ?? "unknown",
      agentVersion: stringValue(value?.agentVersion),
      epoch: integer(value?.epoch) ?? 0,
      ...(previous && isValidCumulative(previous) ? { previous } : {}),
    },
  };
}

function storedCumulative(value: Record<string, unknown>): CumulativeUsage | undefined {
  const input = integer(value.input);
  const cachedInput = integer(value.cachedInput);
  const cacheWriteInput = integer(value.cacheWriteInput);
  const output = integer(value.output);
  const reasoningOutput = integer(value.reasoningOutput);
  const total = integer(value.total);
  if (
    input === undefined || cachedInput === undefined || cacheWriteInput === undefined ||
    output === undefined || reasoningOutput === undefined || total === undefined ||
    cacheWriteInput !== 0
  ) return undefined;
  return { input, cachedInput, cacheWriteInput, output, reasoningOutput, total };
}

function readCumulative(value: Record<string, unknown>): CumulativeUsage | undefined {
  const input = integer(value.input_tokens);
  const cachedInput = optionalInteger(value, "cached_input_tokens");
  const cacheWriteInput = optionalInteger(value, "cache_write_input_tokens");
  const output = integer(value.output_tokens);
  const reasoningOutput = optionalInteger(value, "reasoning_output_tokens");
  const total = integer(value.total_tokens);
  if (
    input === undefined || cachedInput === undefined || cacheWriteInput === undefined ||
    output === undefined || reasoningOutput === undefined || total === undefined ||
    cacheWriteInput !== 0
  ) return undefined;
  return { input, cachedInput, cacheWriteInput, output, reasoningOutput, total };
}

function optionalInteger(value: Record<string, unknown>, key: string): number | undefined {
  return key in value ? integer(value[key]) : 0;
}

function isValidCumulative(value: CumulativeUsage): boolean {
  return (
    Object.values(value).every((counter) => Number.isSafeInteger(counter) && counter >= 0) &&
    value.cachedInput + value.cacheWriteInput <= value.input &&
    value.reasoningOutput <= value.output &&
    value.total === value.input + value.output
  );
}

function decreased(current: CumulativeUsage, previous: CumulativeUsage): boolean {
  return (Object.keys(current) as Array<keyof CumulativeUsage>)
    .some((key) => current[key] < previous[key]);
}

function subtract(current: CumulativeUsage, previous?: CumulativeUsage): CumulativeUsage {
  if (!previous) return current;
  return {
    input: current.input - previous.input,
    cachedInput: current.cachedInput - previous.cachedInput,
    cacheWriteInput: current.cacheWriteInput - previous.cacheWriteInput,
    output: current.output - previous.output,
    reasoningOutput: current.reasoningOutput - previous.reasoningOutput,
    total: current.total - previous.total,
  };
}

function eventId(
  sessionId: string,
  turnId: string,
  timestamp: string,
  epoch: number,
  usage: CumulativeUsage,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, turnId, timestamp, epoch, usage]))
    .digest("hex");
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export const codexCollector: AgentCollector = {
  agent: "codex",
  surface: "cli",
  source: "transcript",

  async detect(input?: CollectionInput) {
    const files = await discoverRollouts(input?.root);
    return files.length > 0
      ? { status: "available", detail: `${files.length} persisted rollout file(s) found; preview evidence only` }
      : { status: "unavailable", detail: SUPPORT.coverage };
  },

  async collect(input?: CollectionInput): Promise<CollectionResult> {
    const files = await discoverRollouts(input?.root);
    const evidence: UsageEvidenceV2[] = [];
    const diagnostics: string[] = [];
    let lastLine = 0;
    for (const filePath of files) {
      const result = await parseCodexRollout(filePath, input?.afterLine ?? 0);
      evidence.push(...result.evidence);
      diagnostics.push(...result.diagnostics);
      lastLine = Math.max(lastLine, result.lastLine);
    }
    return { evidence, diagnostics, lastLine };
  },

  discoverResources(input?: CollectionInput) {
    return discoverRollouts(input?.root);
  },

  collectResource(resource: string, cursor: CollectionCursor, limits) {
    return parseCodexRollout(resource, cursor, limits);
  },
};
