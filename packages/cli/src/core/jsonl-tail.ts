import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const PREFIX_BYTES = 4096;

export interface JsonlFileIdentity {
  dev: string;
  ino: string;
  birthtimeMs: number;
  prefixLength: number;
  prefixSha256: string;
}

export interface JsonlByteCursor<Context = unknown> {
  version: 1;
  byteOffset: number;
  line: number;
  file: JsonlFileIdentity;
  discardingOversize?: boolean;
  context?: Context;
}

export interface JsonlLine {
  line: number;
  value: string;
}

export interface JsonlTail<Context = unknown> {
  lines: JsonlLine[];
  cursor: JsonlByteCursor<Context>;
  reset: boolean;
  bytesRead: number;
  reachedEof: boolean;
  discardedOversizeRecords: number;
}

export interface JsonlTailOptions<Context = unknown> {
  cursor?: JsonlByteCursor<Context>;
  context?: Context;
  maxBytes?: number;
}

export async function readJsonlTail<Context = unknown>(
  filePath: string,
  options: JsonlTailOptions<Context> = {},
): Promise<JsonlTail<Context>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");

  const handle = await openJsonlFile(filePath);
  try {
    const stat = await handle.stat();
    const reset = await shouldReset(handle, stat, options.cursor);
    const startOffset = reset ? 0 : options.cursor?.byteOffset ?? 0;
    const startLine = reset ? 0 : options.cursor?.line ?? 0;
    const context = reset ? options.context : options.cursor?.context ?? options.context;
    const available = Math.max(0, Math.min(maxBytes, stat.size - startOffset));
    const buffer = Buffer.allocUnsafe(available);
    const bytesRead = await readAt(handle, buffer, startOffset);
    const chunk = buffer.subarray(0, bytesRead);
    const decoded = decodeChunk(chunk, startLine, options.cursor?.discardingOversize ?? false, stat.size > startOffset + bytesRead);
    const identity = await fileIdentity(handle, stat, reset ? undefined : options.cursor?.file);
    return {
      lines: decoded.lines,
      cursor: {
        version: 1,
        byteOffset: startOffset + decoded.committedLength,
        line: decoded.line,
        file: identity,
        ...(decoded.discardingOversize ? { discardingOversize: true } : {}),
        ...(context === undefined ? {} : { context }),
      },
      reset,
      bytesRead,
      reachedEof: startOffset + bytesRead >= stat.size,
      discardedOversizeRecords: decoded.discardedOversizeRecords,
    };
  } finally {
    await handle.close();
  }
}

export async function migrateJsonlLineCursor(
  filePath: string,
  afterLine: number,
  visit: (line: JsonlLine) => void,
): Promise<JsonlByteCursor> {
  if (!Number.isSafeInteger(afterLine) || afterLine < 0) throw new Error("afterLine must be a non-negative integer");
  const handle = await openJsonlFile(filePath);
  try {
    const stat = await handle.stat();
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let committedOffset = 0;
    let line = 0;
    let pieces: Buffer[] = [];
    let pieceBytes = 0;
    let discarding = false;
    while (line < afterLine && position < stat.size) {
      const result = await handle.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) break;
      let start = 0;
      for (let index = 0; index < result.bytesRead && line < afterLine; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        if (!discarding) {
          const part = Buffer.from(chunk.subarray(start, index));
          pieces.push(part);
          pieceBytes += part.length;
          const value = Buffer.concat(pieces, pieceBytes).toString("utf8").replace(/\r$/, "");
          visit({ line: line + 1, value });
        }
        line += 1;
        committedOffset = position + index + 1;
        start = index + 1;
        pieces = [];
        pieceBytes = 0;
        discarding = false;
      }
      if (line >= afterLine) break;
      if (start < result.bytesRead && !discarding) {
        const part = Buffer.from(chunk.subarray(start, result.bytesRead));
        pieces.push(part);
        pieceBytes += part.length;
        if (pieceBytes > DEFAULT_MAX_BYTES) {
          pieces = [];
          pieceBytes = 0;
          discarding = true;
        }
      }
      position += result.bytesRead;
    }
    return {
      version: 1,
      byteOffset: committedOffset,
      line,
      file: await fileIdentity(handle, stat),
      ...(discarding ? { discardingOversize: true } : {}),
    };
  } finally {
    await handle.close();
  }
}

export function withJsonlContext<Context>(
  cursor: JsonlByteCursor<unknown>,
  context: Context,
): JsonlByteCursor<Context> {
  return { ...cursor, context };
}

async function openJsonlFile(filePath: string): Promise<FileHandle> {
  const lexical = await fs.lstat(filePath);
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw invalidJsonlFile();

  const flags = constants.O_RDONLY | noFollowFlag() | constants.O_NONBLOCK;
  const handle = await fs.open(filePath, flags);
  try {
    if (!(await handle.stat()).isFile()) throw invalidJsonlFile();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function invalidJsonlFile(): Error {
  return new Error("Burnbook transcript input must be a regular file, not a symlink or special file.");
}

async function shouldReset(
  handle: FileHandle,
  stat: Stats,
  cursor?: JsonlByteCursor<unknown>,
): Promise<boolean> {
  if (!cursor) return false;
  if (cursor.byteOffset > stat.size) return true;
  if (cursor.file.dev !== String(stat.dev) || cursor.file.ino !== String(stat.ino)) return true;
  if (cursor.file.birthtimeMs !== stat.birthtimeMs) return true;
  if (cursor.file.prefixLength > stat.size) return true;
  const fingerprint = await hashPrefix(handle, cursor.file.prefixLength);
  return fingerprint !== cursor.file.prefixSha256;
}

async function fileIdentity(
  handle: FileHandle,
  stat: Stats,
  previous?: JsonlFileIdentity,
): Promise<JsonlFileIdentity> {
  const prefixLength = previous && previous.prefixLength > 0
    ? previous.prefixLength
    : Math.min(stat.size, PREFIX_BYTES);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: stat.birthtimeMs,
    prefixLength,
    prefixSha256: await hashPrefix(handle, prefixLength),
  };
}

async function hashPrefix(handle: FileHandle, length: number): Promise<string> {
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = await readAt(handle, buffer, 0);
  return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
}

async function readAt(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset;
}

function decodeLines(buffer: Buffer, startLine: number): JsonlLine[] {
  const lines: JsonlLine[] = [];
  let start = 0;
  let line = startLine;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    line += 1;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0d) end -= 1;
    lines.push({ line, value: buffer.toString("utf8", start, end) });
    start = index + 1;
  }
  return lines;
}

function decodeChunk(
  chunk: Buffer,
  startLine: number,
  wasDiscarding: boolean,
  hasMoreBytes: boolean,
): {
  lines: JsonlLine[];
  committedLength: number;
  line: number;
  discardingOversize: boolean;
  discardedOversizeRecords: number;
} {
  let start = 0;
  let line = startLine;
  let discardedOversizeRecords = 0;
  if (wasDiscarding) {
    const newline = chunk.indexOf(0x0a);
    if (newline < 0) {
      return {
        lines: [],
        committedLength: chunk.length,
        line,
        discardingOversize: true,
        discardedOversizeRecords: 0,
      };
    }
    start = newline + 1;
    line += 1;
    discardedOversizeRecords = 1;
  }

  const finalNewline = chunk.lastIndexOf(0x0a);
  if (finalNewline < start) {
    if (start === 0 && hasMoreBytes && chunk.length > 0) {
      return {
        lines: [],
        committedLength: chunk.length,
        line,
        discardingOversize: true,
        discardedOversizeRecords,
      };
    }
    return {
      lines: [],
      committedLength: start,
      line,
      discardingOversize: false,
      discardedOversizeRecords,
    };
  }
  const committedLength = finalNewline + 1;
  const lines = decodeLines(chunk.subarray(start, committedLength), line);
  return {
    lines,
    committedLength,
    line: line + lines.length,
    discardingOversize: false,
    discardedOversizeRecords,
  };
}
