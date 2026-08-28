import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { configDir } from "./paths.js";

interface LockOwner {
  pid: number;
  token: string;
  createdAtMs?: number;
  leaseUntilMs?: number;
}

export interface SyncLock {
  release(): Promise<void>;
}

export interface SyncLockOptions {
  now?: () => number;
  leaseMs?: number;
  processIsAlive?: (pid: number) => boolean;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

function lockPath(): string {
  return path.join(configDir(), "sync-worker.lock");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function createLock(owner: LockOwner): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath(), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
}

async function readOwner(): Promise<{ owner?: LockOwner; raw?: string; mtimeMs?: number }> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  let raw: string;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await fs.open(lockPath(), constants.O_RDONLY | noFollow);
    stat = await handle.stat();
    if (!stat.isFile()) return { raw: "" };
    raw = await handle.readFile("utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    if (isErrno(error, "ELOOP")) return { raw: "" };
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    const validLease =
      parsed.createdAtMs === undefined ||
      parsed.leaseUntilMs === undefined ||
      (
        Number.isFinite(parsed.createdAtMs) &&
        Number.isFinite(parsed.leaseUntilMs) &&
        Number(parsed.leaseUntilMs) >= Number(parsed.createdAtMs)
      );
    if (
      Number.isInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.token === "string" &&
      validLease
    ) {
      return { owner: parsed as LockOwner, raw, mtimeMs: stat.mtimeMs };
    }
  } catch {
    // Invalid lock bytes are reclaimable and are never executed or logged.
  }
  return { raw, mtimeMs: stat.mtimeMs };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function removeIfUnchanged(expectedRaw: string | undefined): Promise<void> {
  if (expectedRaw === undefined) return;
  const current = await readOwner();
  if (current.raw !== expectedRaw) return;
  try {
    await fs.unlink(lockPath());
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

export async function acquireSyncLock(options: SyncLockOptions = {}): Promise<SyncLock | undefined> {
  const directory = configDir();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Burnbook config directory must be a real directory.");
  }
  await fs.chmod(directory, 0o700);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("Sync lock lease must be a positive duration.");
  }
  const isAlive = options.processIsAlive ?? processIsAlive;
  const createdAtMs = now();
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAtMs,
    leaseUntilMs: createdAtMs + leaseMs,
  };
  if (!(await createLock(owner))) {
    const current = await readOwner();
    if (current.owner && isAlive(current.owner.pid)) return undefined;
    await removeIfUnchanged(current.raw);
    if (!(await createLock(owner))) return undefined;
  }

  return {
    release: async () => {
      const current = await readOwner();
      if (current.owner?.token === owner.token) await removeIfUnchanged(current.raw);
    },
  };
}
