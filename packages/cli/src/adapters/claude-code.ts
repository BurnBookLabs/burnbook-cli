import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { usageTupleSchema, type UsageTuple } from "@burnbook/schema";
import { claudeDir } from "../core/paths.js";
import {
  migrateJsonlLineCursor,
  readJsonlTail,
  withJsonlContext,
  type JsonlByteCursor,
} from "../core/jsonl-tail.js";

const MAX_BYTES_PER_COLLECT = 4 * 1024 * 1024;

export async function discoverTranscripts(root?: string): Promise<string[]> {
  const base = root ?? path.join(claudeDir(), "projects");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(base, entry.name);
    let files: Dirent[];
    try {
      files = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        results.push(path.join(directory, file.name));
      }
    }
  }
  return results.sort();
}

interface ClaudeCursorContext {
  sessionId: string | null;
}

export interface ParseTranscriptResult {
  tuples: UsageTuple[];
  sessionId: string | null;
  lastLine: number;
  cursor: JsonlByteCursor<ClaudeCursorContext>;
  byteCursor: JsonlByteCursor<ClaudeCursorContext>;
}

export interface ParseTranscriptLimits {
  maxTuples: number;
  maxLines: number;
  maxBytes?: number;
}

export async function parseTranscript(
  filePath: string,
  cursor: number | JsonlByteCursor = 0,
  limits?: ParseTranscriptLimits,
): Promise<ParseTranscriptResult> {
  const tuples: UsageTuple[] = [];
  const seen = new Set<string>();
  let sessionId: string | null = null;
  let byteCursor = typeof cursor === "number" ? undefined : asClaudeCursor(cursor);
  if (typeof cursor === "number" && cursor > 0) {
    const migrated = await migrateJsonlLineCursor(filePath, cursor, (line) => {
      const discovered = sessionIdFromLine(line.value);
      if (discovered) sessionId = discovered;
    });
    byteCursor = withJsonlContext(migrated, { sessionId });
  }

  const tail = await readJsonlTail<ClaudeCursorContext>(filePath, {
    ...(byteCursor ? { cursor: byteCursor } : {}),
    context: { sessionId: null },
    maxBytes: limits?.maxBytes ?? MAX_BYTES_PER_COLLECT,
  });
  sessionId = tail.cursor.context?.sessionId ?? sessionId;
  let processedLine = tail.lines[0]?.line ? tail.lines[0].line - 1 : tail.cursor.line;
  let processedLines = 0;

  for (const line of tail.lines) {
    if (limits && processedLines >= limits.maxLines) break;
    processedLines += 1;
    processedLine = line.line;
    if (line.value.trim().length === 0) continue;

    let record: unknown;
    try {
      record = JSON.parse(line.value);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
      sessionId = record.sessionId;
    }
    if (record.type !== "assistant") continue;

    const message = isRecord(record.message) ? record.message : undefined;
    const usage = message && isRecord(message.usage) ? message.usage : undefined;
    if (!message || !usage) continue;
    const messageId = message.id;
    const requestId = record.requestId;
    if (typeof messageId !== "string" || typeof requestId !== "string") continue;
    const dedupeKey = JSON.stringify([sessionId, messageId, requestId]);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const inputTokens = counter(usage, "input_tokens", false);
    const outputTokens = counter(usage, "output_tokens", false);
    const cacheReadTokens = counter(usage, "cache_read_input_tokens", true);
    const cacheCreationTokens = counter(usage, "cache_creation_input_tokens", true);
    if ([inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens].some((value) => value === undefined)) {
      continue;
    }
    const parsed = usageTupleSchema.safeParse({
      messageId,
      requestId,
      ts: record.timestamp,
      model: message.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });
    if (!parsed.success) continue;
    tuples.push(parsed.data);
    if (limits && tuples.length >= limits.maxTuples) break;
  }

  const stoppedEarly = processedLine < tail.cursor.line;
  const resultCursor = stoppedEarly
    ? await migrateJsonlLineCursor(filePath, processedLine, () => {})
    : tail.cursor;
  return {
    tuples,
    sessionId,
    lastLine: processedLine,
    cursor: withJsonlContext(resultCursor, { sessionId }),
    byteCursor: withJsonlContext(resultCursor, { sessionId }),
  };
}

function sessionIdFromLine(value: string): string | undefined {
  try {
    const record = JSON.parse(value) as Record<string, unknown>;
    return typeof record.sessionId === "string" && record.sessionId ? record.sessionId : undefined;
  } catch {
    return undefined;
  }
}

function counter(
  usage: Record<string, unknown>,
  key: string,
  optional: boolean,
): number | undefined {
  if (!(key in usage)) return optional ? 0 : undefined;
  const value = usage[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asClaudeCursor(cursor: JsonlByteCursor): JsonlByteCursor<ClaudeCursorContext> {
  const context = cursor.context;
  if (!isRecord(context) || !("sessionId" in context)) {
    return { ...cursor, context: { sessionId: null } };
  }
  const sessionId = context.sessionId;
  return {
    ...cursor,
    context: { sessionId: typeof sessionId === "string" && sessionId ? sessionId : null },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
