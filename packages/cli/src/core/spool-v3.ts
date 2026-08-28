import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { usageEvidenceV3Schema, type UsageEvidenceV3 } from "@burnbook/schema";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

function directory() { return path.join(configDir(), "spool"); }
function evidenceFile() { return path.join(directory(), "evidence-v3.jsonl"); }
function ackFile() { return path.join(directory(), "acknowledged-v3.jsonl"); }
function quarantineFile() { return path.join(directory(), "quarantine-v3.jsonl"); }
function retryFile() { return path.join(directory(), "retry-state-v3.json"); }

export async function appendEvidenceV3(records: readonly UsageEvidenceV3[]) {
  const known = new Set<string>();
  for await (const line of lines(evidenceFile())) {
    try {
      const value = usageEvidenceV3Schema.safeParse(JSON.parse(line));
      if (value.success) known.add(key(value.data));
    } catch { /* doctor reports malformed local rows */ }
  }
  const pending: string[] = [];
  let duplicates = 0;
  for (const record of records) {
    const value = usageEvidenceV3Schema.parse(record);
    if (known.has(key(value))) { duplicates += 1; continue; }
    known.add(key(value));
    pending.push(JSON.stringify(value));
  }
  await append(evidenceFile(), pending);
  return { appended: pending.length, duplicates };
}

export async function readPendingEvidenceV3Window(limit: number) {
  const acked = new Set((await read(ackFile())).flatMap((line) => {
    try { const row = JSON.parse(line) as { key?: unknown }; return typeof row.key === "string" ? [row.key] : []; } catch { return []; }
  }));
  const evidence: UsageEvidenceV3[] = [];
  const pending = new Set<string>();
  let malformed = 0;
  let hasMore = false;
  for await (const line of lines(evidenceFile())) {
    try {
      const parsed = usageEvidenceV3Schema.safeParse(JSON.parse(line));
      if (!parsed.success) { malformed += 1; continue; }
      const identity = key(parsed.data);
      if (acked.has(identity) || pending.has(identity)) continue;
      if (evidence.length >= limit) { hasMore = true; break; }
      pending.add(identity);
      evidence.push(parsed.data);
    } catch { malformed += 1; }
  }
  return { evidence, malformed, hasMore };
}

export async function acknowledgeEvidenceV3(records: readonly UsageEvidenceV3[]) {
  await append(ackFile(), records.map((record) => JSON.stringify({ key: key(record), acknowledgedAt: new Date().toISOString() })));
}

export async function recordDeliveryQuarantineV3(records: readonly UsageEvidenceV3[], code: string, batchDigest: string) {
  await append(quarantineFile(), [JSON.stringify({ code, batchDigest, count: records.length, capturedAt: new Date().toISOString() })]);
}

export async function readRetryScheduleV3() {
  try {
    const raw = await readPrivateFile(retryFile(), 1024 * 1024);
    if (!raw) return [];
    const value = JSON.parse(raw) as { batches?: unknown };
    return Array.isArray(value.batches) ? value.batches as Array<{ batchDigest: string; attempts: number; nextAttemptAt: string }> : [];
  } catch { return []; }
}

export async function writeRetryScheduleV3(entries: readonly { batchDigest: string; attempts: number; nextAttemptAt: string }[]) {
  await writePrivateFile(retryFile(), `${JSON.stringify({ version: 1, batches: entries })}\n`);
}

export async function inspectSpoolV3() {
  const acknowledgements = await read(ackFile());
  const acknowledged = new Set(acknowledgements.flatMap((line) => {
    try { const row = JSON.parse(line) as { key?: unknown }; return typeof row.key === "string" ? [row.key] : []; }
    catch { return []; }
  }));
  const pending = new Set<string>();
  let malformed = 0;
  let oldestPendingAt: string | undefined;
  for await (const line of lines(evidenceFile())) {
    try {
      const parsed = usageEvidenceV3Schema.safeParse(JSON.parse(line));
      if (!parsed.success) { malformed += 1; continue; }
      const identity = key(parsed.data);
      if (acknowledged.has(identity) || pending.has(identity)) continue;
      pending.add(identity);
      if (!oldestPendingAt || parsed.data.occurredAt < oldestPendingAt) oldestPendingAt = parsed.data.occurredAt;
    } catch { malformed += 1; }
  }
  const quarantine = await read(quarantineFile());
  const quarantined = quarantine.reduce((total, line) => {
    try {
      const row = JSON.parse(line) as { count?: unknown };
      return total + (Number.isSafeInteger(row.count) && Number(row.count) > 0 ? Number(row.count) : 0);
    } catch { return total; }
  }, 0);
  const lastAcknowledgedAt = acknowledgements.reduce<string | undefined>((latest, line) => {
    try {
      const row = JSON.parse(line) as { acknowledgedAt?: unknown };
      return typeof row.acknowledgedAt === "string" && Number.isFinite(Date.parse(row.acknowledgedAt)) &&
        (!latest || row.acknowledgedAt > latest) ? row.acknowledgedAt : latest;
    } catch { return latest; }
  }, undefined);
  const privatePermissions = await filesArePrivate([
    evidenceFile(), ackFile(), quarantineFile(), retryFile(),
  ]);
  return {
    pending: pending.size,
    malformed,
    quarantined,
    queueBytes: await size(evidenceFile()),
    privatePermissions,
    ...(oldestPendingAt ? { oldestPendingAt } : {}),
    ...(lastAcknowledgedAt ? { lastAcknowledgedAt } : {}),
  };
}

async function ensure() {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await requireDirectory(configDir());
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  await requireDirectory(directory());
  await fs.chmod(directory(), 0o700);
}

async function append(file: string, values: string[]) {
  if (!values.length) return;
  await ensure();
  const handle = await fs.open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow(), 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Burnbook spool entries must be regular files.");
    await handle.writeFile(`${values.join("\n")}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await fs.chmod(file, 0o600);
}

async function read(file: string): Promise<string[]> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | noFollow());
    if (!(await handle.stat()).isFile()) throw new Error("Burnbook spool entries must be regular files.");
    return (await handle.readFile("utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally { await handle?.close(); }
}

async function* lines(file: string): AsyncGenerator<string> {
  try {
    const handle = await fs.open(file, constants.O_RDONLY | noFollow());
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      throw new Error("Burnbook spool entries must be regular files.");
    }
    const input = handle.createReadStream({ encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of reader) if (line) yield line; } finally { reader.close(); input.destroy(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function key(record: UsageEvidenceV3): string { return `${record.agent}:${record.surface}:${record.eventId}`; }

function noFollow(): number { return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0; }

async function requireDirectory(target: string) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Burnbook state directories must not be symlinks.");
}

async function size(file: string): Promise<number> {
  try { return (await fs.stat(file)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function filesArePrivate(files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}
