import * as path from "node:path";
import type { JsonlByteCursor } from "./jsonl-tail.js";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

export type StoredCursor = number | JsonlByteCursor;

/** Local collection watermarks. These values never enter an evidence envelope. */
export interface CursorState {
  cursors: Record<string, StoredCursor>;
  sourceCursors?: Record<string, StoredCursor>;
  files?: Record<string, FileStamp>;
  evidenceReplayVersion?: number;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export function sourceCursorKey(
  agent: string,
  surface: string,
  source: string,
  resource: string,
): string {
  return `${agent}:${surface}:${source}:${resource}`;
}

function statePath(): string {
  return path.join(configDir(), "state.json");
}

export async function loadState(): Promise<CursorState> {
  const raw = await readPrivateFile(statePath(), 16 * 1024 * 1024);
  if (raw === undefined) return { cursors: {} };

  try {
    return parseCursorState(JSON.parse(raw)) ?? { cursors: {} };
  } catch {
    return { cursors: {} };
  }
}

export async function saveState(state: CursorState): Promise<void> {
  const validated = parseCursorState(state);
  if (!validated) throw new Error("Invalid Burnbook cursor state.");
  await writePrivateFile(statePath(), `${JSON.stringify(validated, null, 2)}\n`);
}

function parseCursorState(value: unknown): CursorState | undefined {
  if (!isRecord(value) || !isRecord(value.cursors)) return undefined;
  const cursors = parseCursorMap(value.cursors);
  if (!cursors) return undefined;

  let sourceCursors: Record<string, StoredCursor> | undefined;
  if (value.sourceCursors !== undefined) {
    if (!isRecord(value.sourceCursors)) return undefined;
    sourceCursors = parseCursorMap(value.sourceCursors);
    if (!sourceCursors) return undefined;
  }

  let files: Record<string, FileStamp> | undefined;
  if (value.files !== undefined) {
    if (!isRecord(value.files)) return undefined;
    files = {};
    for (const [key, stamp] of Object.entries(value.files)) {
      if (!isRecord(stamp) || !isNonNegativeFinite(stamp.size) || !isNonNegativeFinite(stamp.mtimeMs)) {
        return undefined;
      }
      files[key] = { size: Number(stamp.size), mtimeMs: Number(stamp.mtimeMs) };
    }
  }

  const replayVersion = value.evidenceReplayVersion;
  if (replayVersion !== undefined && (!Number.isSafeInteger(replayVersion) || Number(replayVersion) <= 0)) {
    return undefined;
  }

  return {
    cursors,
    ...(sourceCursors ? { sourceCursors } : {}),
    ...(files ? { files } : {}),
    ...(replayVersion !== undefined ? { evidenceReplayVersion: Number(replayVersion) } : {}),
  };
}

function parseCursorMap(value: Record<string, unknown>): Record<string, StoredCursor> | undefined {
  const cursors: Record<string, StoredCursor> = {};
  for (const [key, cursor] of Object.entries(value)) {
    const parsed = parseCursor(cursor);
    if (parsed === undefined) return undefined;
    cursors[key] = parsed;
  }
  return cursors;
}

function parseCursor(value: unknown): StoredCursor | undefined {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.file)) return undefined;
  if (!isSafeNonNegativeInteger(value.byteOffset) || !isSafeNonNegativeInteger(value.line)) return undefined;
  const file = value.file;
  if (typeof file.dev !== "string" || typeof file.ino !== "string") return undefined;
  if (!isNonNegativeFinite(file.birthtimeMs) || !isSafeNonNegativeInteger(file.prefixLength)) return undefined;
  if (typeof file.prefixSha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.prefixSha256)) return undefined;
  return {
    version: 1,
    byteOffset: Number(value.byteOffset),
    line: Number(value.line),
    file: {
      dev: file.dev,
      ino: file.ino,
      birthtimeMs: Number(file.birthtimeMs),
      prefixLength: Number(file.prefixLength),
      prefixSha256: file.prefixSha256,
    },
    ...(value.discardingOversize === true ? { discardingOversize: true } : {}),
    ...(value.context === undefined ? {} : { context: value.context }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
