import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { configDir } from "./paths.js";

interface LeaseRecord {
  version: 1;
  owner: string;
  pid: number;
  acquiredAt: string;
}

export interface UploadLease {
  release: () => Promise<void>;
}

export type UploadLeaseStatus = "active" | "stale" | "inactive";

function spoolDirectory(): string {
  return path.join(configDir(), "spool");
}

function leasePath(): string {
  return path.join(spoolDirectory(), "upload-worker.lock");
}

function recoveryPath(): string {
  return path.join(spoolDirectory(), "upload-worker.recovery.lock");
}

/** Acquire the one local upload lease. A dead owner's lease is reclaimed once. */
export async function acquireUploadLease(): Promise<UploadLease | undefined> {
  await fs.mkdir(spoolDirectory(), { recursive: true, mode: 0o700 });
  await fs.chmod(spoolDirectory(), 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = randomUUID();
    const record: LeaseRecord = {
      version: 1,
      owner,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      const handle = await fs.open(leasePath(), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(leasePath(), 0o600);
      return { release: () => releaseOwnedLease(owner) };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (attempt > 0 || await leaseOwnerMayBeAlive()) return undefined;
      if (!await claimStaleLease()) return undefined;
    }
  }
  return undefined;
}

/** Inspect only process-coordination metadata; no spool evidence is read. */
export async function inspectUploadLease(): Promise<UploadLeaseStatus> {
  try {
    await fs.stat(leasePath());
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "inactive";
    throw error;
  }
  return await leaseOwnerMayBeAlive() ? "active" : "stale";
}

async function releaseOwnedLease(owner: string): Promise<void> {
  const current = await readLease();
  if (current?.owner !== owner) return;
  try {
    await fs.unlink(leasePath());
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function claimStaleLease(): Promise<boolean> {
  const recoveryOwner = randomUUID();
  const recoveryRecord: LeaseRecord = {
    version: 1,
    owner: recoveryOwner,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  let recoveryHandle;
  // Recovery claims are never stolen; an interrupted recovery fails closed rather than risking two uploaders.
  try {
    recoveryHandle = await fs.open(recoveryPath(), "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }

  const claimed = `${leasePath()}.stale-${process.pid}-${randomUUID()}`;
  try {
    await recoveryHandle.writeFile(`${JSON.stringify(recoveryRecord)}\n`, "utf8");
    await recoveryHandle.sync();
    await recoveryHandle.close();
    recoveryHandle = undefined;
    await fs.chmod(recoveryPath(), 0o600);
    if (await leaseOwnerMayBeAlive()) return false;
    await fs.rename(leasePath(), claimed);
    await fs.unlink(claimed);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  } finally {
    await recoveryHandle?.close();
    try {
      await fs.unlink(recoveryPath());
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}

async function leaseOwnerMayBeAlive(): Promise<boolean> {
  const record = await readLease();
  if (!record) {
    try {
      const stat = await fs.stat(leasePath());
      return Date.now() - stat.mtimeMs < 10_000;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function readLease(): Promise<LeaseRecord | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(leasePath(), "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    if (
      value.version !== 1 ||
      typeof value.owner !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(value.acquiredAt))
    ) return undefined;
    return value as unknown as LeaseRecord;
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
