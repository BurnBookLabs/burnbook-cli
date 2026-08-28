import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { createInterface } from "node:readline";
import {
  agentIdSchema,
  agentSurfaceSchema,
  evidenceIdentifierSchema,
  usageEvidenceV2Schema,
  type UsageEvidenceV2,
} from "@burnbook/schema";
import { configDir } from "./paths.js";

const MAX_RECORDS_PER_READ = 5000;

function spoolDir(): string {
  return path.join(configDir(), "spool");
}

function evidencePath(): string {
  return path.join(spoolDir(), "evidence-v2.jsonl");
}

function acknowledgementsPath(): string {
  return path.join(spoolDir(), "acknowledged-v2.jsonl");
}

function quarantinePath(): string {
  return path.join(spoolDir(), "quarantine-v2.jsonl");
}

function retryStatePath(): string {
  return path.join(spoolDir(), "retry-state-v2.json");
}

export interface SpoolRetryEntry {
  batchDigest: string;
  attempts: number;
  nextAttemptAt: string;
}

async function ensurePrivateDirectory(): Promise<void> {
  const root = configDir();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await requireRealDirectory(root);
  await fs.mkdir(spoolDir(), { recursive: false, mode: 0o700 }).catch((error) => {
    if (!(isErrnoException(error) && error.code === "EEXIST")) throw error;
  });
  await requireRealDirectory(spoolDir());
  await fs.chmod(root, 0o700);
  await fs.chmod(spoolDir(), 0o700);
}

async function appendPrivate(filePath: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await ensurePrivateDirectory();
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | noFollowFlag();
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Burnbook spool entries must be regular files.");
    const separator = stat.size > 0 && !(await fileEndsWithNewline(handle, stat.size)) ? "\n" : "";
    const body = `${separator}${lines.join("\n")}\n`;
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
}

async function readLines(filePath: string): Promise<string[]> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Burnbook spool entries must be regular files.");
    return (await handle.readFile("utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Append only strict, content-free V2 records. Duplicate event IDs are skipped. */
export async function appendEvidence(
  records: readonly UsageEvidenceV2[],
): Promise<{ appended: number; duplicates: number }> {
  const existing = new Set<string>();
  for await (const line of streamLines(evidencePath())) {
    try {
      const parsed = usageEvidenceV2Schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        existing.add(identityKey(parsed.data.agent, parsed.data.surface, parsed.data.eventId));
      }
    } catch {
      // Corrupt existing lines are ignored here and reported by doctor.
    }
  }

  const lines: string[] = [];
  let duplicates = 0;
  for (const record of records) {
    const parsed = usageEvidenceV2Schema.parse(record);
    const key = identityKey(parsed.agent, parsed.surface, parsed.eventId);
    if (existing.has(key)) {
      duplicates += 1;
      continue;
    }
    existing.add(key);
    lines.push(JSON.stringify(parsed));
  }
  await appendPrivate(evidencePath(), lines);
  return { appended: lines.length, duplicates };
}

async function* streamLines(filePath: string): AsyncGenerator<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Burnbook spool entries must be regular files.");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    await handle?.close();
    throw error;
  }
  const input = handle.createReadStream({
    encoding: "utf8",
  });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.length > 0) yield line;
    }
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
  } finally {
    reader.close();
    input.destroy();
  }
}

/** Return unacknowledged records; malformed lines never leave the device. */
export async function readPendingEvidence(limit = MAX_RECORDS_PER_READ): Promise<{
  evidence: UsageEvidenceV2[];
  malformed: number;
}> {
  const { evidence, malformed } = await readPendingEvidenceWindow(limit);
  return { evidence, malformed };
}

export async function readPendingEvidenceWindow(limit = MAX_RECORDS_PER_READ): Promise<{
  evidence: UsageEvidenceV2[];
  malformed: number;
  hasMore: boolean;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("pending evidence limit must be a positive safe integer");
  }
  const acknowledged = new Set<string>();
  for (const line of await readLines(acknowledgementsPath())) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const agent = agentIdSchema.safeParse(value.agent);
      const surface = agentSurfaceSchema.safeParse(value.surface);
      const eventId = evidenceIdentifierSchema.safeParse(value.eventId);
      if (agent.success && surface.success && eventId.success) {
        acknowledged.add(identityKey(agent.data, surface.data, eventId.data));
      }
    } catch {
      // Invalid acknowledgement lines fail closed and do not hide evidence.
    }
  }
  const evidence: UsageEvidenceV2[] = [];
  const pending = new Set<string>();
  let malformed = 0;
  let hasMore = false;
  for await (const line of streamLines(evidencePath())) {
    try {
      const parsed = usageEvidenceV2Schema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        malformed += 1;
        continue;
      }
      const key = identityKey(parsed.data.agent, parsed.data.surface, parsed.data.eventId);
      if (acknowledged.has(key) || pending.has(key)) continue;
      if (evidence.length >= limit) {
        hasMore = true;
        break;
      }
      pending.add(key);
      evidence.push(parsed.data);
    } catch {
      malformed += 1;
    }
  }
  return { evidence, malformed, hasMore };
}

/** Ack IDs only after their signed upload has succeeded. */
export async function acknowledgeEvidence(
  records: readonly Pick<UsageEvidenceV2, "agent" | "surface" | "eventId">[],
): Promise<void> {
  const lines = records.map((record) => JSON.stringify({
    agent: agentIdSchema.parse(record.agent),
    surface: agentSurfaceSchema.parse(record.surface),
    eventId: evidenceIdentifierSchema.parse(record.eventId),
    acknowledgedAt: new Date().toISOString(),
  }));
  await appendPrivate(acknowledgementsPath(), lines);
}

/** Persist only a bounded reason code/count; source data is never quarantined. */
export async function recordQuarantine(agent: UsageEvidenceV2["agent"], count: number): Promise<void> {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  await appendPrivate(quarantinePath(), [JSON.stringify({
    agent: agentIdSchema.parse(agent),
    code: "collector_rejected_record",
    count: Math.min(count, 5000),
    capturedAt: new Date().toISOString(),
  })]);
}

export async function recordDeliveryQuarantine(
  records: readonly UsageEvidenceV2[],
  code: "permanent_rejection" | "invalid_acknowledgement",
  batchDigest: string,
): Promise<void> {
  if (records.length === 0 || !/^[a-f0-9]{64}$/.test(batchDigest)) return;
  const agents = [...new Set(records.map((record) => agentIdSchema.parse(record.agent)))];
  await appendPrivate(quarantinePath(), [JSON.stringify({
    agents,
    code,
    count: Math.min(records.length, 5000),
    batchDigest,
    capturedAt: new Date().toISOString(),
  })]);
}

export async function inspectSpool(): Promise<{
  pending: number;
  malformed: number;
  quarantined: number;
  privatePermissions: boolean;
  scheduledRetries: number;
  queueBytes: number;
  oldestPendingAt?: string;
  lastAcknowledgedAt?: string;
}> {
  const pending = await inspectPendingEvidence();
  const quarantined = (await readLines(quarantinePath())).reduce((total, line) => {
    try {
      const row = JSON.parse(line) as { count?: unknown };
      return total + (Number.isSafeInteger(row.count) && Number(row.count) > 0 ? Number(row.count) : 0);
    } catch { return total; }
  }, 0);
  const scheduledRetries = (await readRetrySchedule()).length;
  const queueBytes = await fileSize(evidencePath());
  const lastAcknowledgedAt = await lastAcknowledgementTime();
  let privatePermissions = true;
  for (const filePath of [
    evidencePath(),
    acknowledgementsPath(),
    quarantinePath(),
    retryStatePath(),
    path.join(spoolDir(), "upload-worker.lock"),
  ]) {
    try {
      const stat = await fs.lstat(filePath);
      privatePermissions = privatePermissions && stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
    }
  }
  return {
    pending: pending.count,
    malformed: pending.malformed,
    quarantined,
    privatePermissions,
    scheduledRetries,
    queueBytes,
    ...(pending.oldestPendingAt ? { oldestPendingAt: pending.oldestPendingAt } : {}),
    ...(lastAcknowledgedAt ? { lastAcknowledgedAt } : {}),
  };
}

async function inspectPendingEvidence(): Promise<{
  count: number;
  malformed: number;
  oldestPendingAt?: string;
}> {
  const acknowledged = new Set<string>();
  for (const line of await readLines(acknowledgementsPath())) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const agent = agentIdSchema.safeParse(value.agent);
      const surface = agentSurfaceSchema.safeParse(value.surface);
      const eventId = evidenceIdentifierSchema.safeParse(value.eventId);
      if (agent.success && surface.success && eventId.success) {
        acknowledged.add(identityKey(agent.data, surface.data, eventId.data));
      }
    } catch {
      // Invalid acknowledgements cannot hide evidence.
    }
  }
  const pending = new Set<string>();
  let malformed = 0;
  let oldestPendingAt: string | undefined;
  for await (const line of streamLines(evidencePath())) {
    try {
      const parsed = usageEvidenceV2Schema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        malformed += 1;
        continue;
      }
      const key = identityKey(parsed.data.agent, parsed.data.surface, parsed.data.eventId);
      if (acknowledged.has(key) || pending.has(key)) continue;
      pending.add(key);
      if (!oldestPendingAt || parsed.data.occurredAt < oldestPendingAt) {
        oldestPendingAt = parsed.data.occurredAt;
      }
    } catch {
      malformed += 1;
    }
  }
  return { count: pending.size, malformed, oldestPendingAt };
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function lastAcknowledgementTime(): Promise<string | undefined> {
  let latest: string | undefined;
  for (const line of await readLines(acknowledgementsPath())) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof value.acknowledgedAt === "string" &&
        Number.isFinite(Date.parse(value.acknowledgedAt)) &&
        (!latest || value.acknowledgedAt > latest)
      ) latest = value.acknowledgedAt;
    } catch {
      // Invalid metadata is reported through the pending-evidence inspection.
    }
  }
  return latest;
}

/** Read only bounded retry timing metadata; evidence and errors are never stored here. */
export async function readRetrySchedule(): Promise<SpoolRetryEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(retryStatePath(), "utf8"));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return [];
    return [];
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.batches)) return [];
  return raw.batches.slice(0, 1000).filter(isRetryEntry);
}

/** Atomically replace bounded, content-free retry timing metadata. */
export async function writeRetrySchedule(entries: readonly SpoolRetryEntry[]): Promise<void> {
  const batches = entries.slice(0, 1000).map((entry) => {
    if (!isRetryEntry(entry)) throw new Error("Invalid spool retry entry");
    return entry;
  });
  await ensurePrivateDirectory();
  const temporary = `${retryStatePath()}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, batches })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, retryStatePath());
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function requireRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Burnbook's local state directories must not be symlinks.");
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

async function fileEndsWithNewline(handle: fs.FileHandle, size: number): Promise<boolean> {
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, size - 1);
  return bytesRead === 1 && byte[0] === 0x0a;
}

function identityKey(agent: string, surface: string, eventId: string): string {
  return `${agent}:${surface}:${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryEntry(value: unknown): value is SpoolRetryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.batchDigest === "string" && /^[a-f0-9]{64}$/.test(value.batchDigest) &&
    Number.isSafeInteger(value.attempts) && (value.attempts as number) >= 1 &&
    (value.attempts as number) <= 100 &&
    typeof value.nextAttemptAt === "string" &&
    Number.isFinite(Date.parse(value.nextAttemptAt))
  );
}
