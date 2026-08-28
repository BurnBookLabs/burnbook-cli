import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireUploadLease,
  inspectUploadLease,
} from "../../src/core/upload-lease.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-upload-lease-"));
  process.env.BURNBOOK_CONFIG_DIR = temporaryDirectory;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("upload worker lease", () => {
  it("allows one owner at a time and releases only its private lock", async () => {
    expect(await inspectUploadLease()).toBe("inactive");
    const first = await acquireUploadLease();
    expect(first).toBeDefined();
    expect(await inspectUploadLease()).toBe("active");
    expect(await acquireUploadLease()).toBeUndefined();

    const lockPath = path.join(temporaryDirectory, "spool", "upload-worker.lock");
    expect((await fs.stat(lockPath)).mode & 0o077).toBe(0);
    const serialized = await fs.readFile(lockPath, "utf8");
    expect(serialized).not.toMatch(/token|evidence|prompt|response|path|payload/i);

    await first!.release();
    expect(await inspectUploadLease()).toBe("inactive");
    const second = await acquireUploadLease();
    expect(second).toBeDefined();
    await second!.release();
  });

  it("reclaims a lease whose recorded process no longer exists", async () => {
    const directory = path.join(temporaryDirectory, "spool");
    const lockPath = path.join(directory, "upload-worker.lock");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1,
      owner: "stale-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-08-03T00:00:00.000Z",
    }), { mode: 0o600 });

    const lease = await acquireUploadLease();
    expect(lease).toBeDefined();
    expect(await fs.readFile(lockPath, "utf8")).not.toContain("stale-owner");
    await lease!.release();
  });

  it("does not steal a fresh lease after observing an older stale owner", async () => {
    const directory = path.join(temporaryDirectory, "spool");
    const lockPath = path.join(directory, "upload-worker.lock");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1,
      owner: "stale-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-08-03T00:00:00.000Z",
    }), { mode: 0o600 });

    let resumeFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });
    let staleWasObserved!: () => void;
    const firstObservedStale = new Promise<void>((resolve) => {
      staleWasObserved = resolve;
    });
    const recoveryPath = path.join(directory, "upload-worker.recovery.lock");
    const realOpen = fs.open.bind(fs);
    let delayedRecoveryOpen = false;
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (!delayedRecoveryOpen && target === recoveryPath && flags === "wx") {
        delayedRecoveryOpen = true;
        staleWasObserved();
        await firstMayContinue;
      }
      return await realOpen(target, flags, mode);
    });
    const delayedContender = acquireUploadLease();

    await firstObservedStale;
    const winner = await acquireUploadLease();
    expect(winner).toBeDefined();
    resumeFirst();
    expect(await delayedContender).toBeUndefined();
    expect(await inspectUploadLease()).toBe("active");

    await winner!.release();
    expect(await inspectUploadLease()).toBe("inactive");
  });

  it("fails closed when another stale recovery claim already exists", async () => {
    const directory = path.join(temporaryDirectory, "spool");
    const lockPath = path.join(directory, "upload-worker.lock");
    const recoveryPath = path.join(directory, "upload-worker.recovery.lock");
    await fs.mkdir(directory, { recursive: true });
    const staleRecord = JSON.stringify({
      version: 1,
      owner: "stale-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-08-03T00:00:00.000Z",
    });
    await fs.writeFile(lockPath, staleRecord, { mode: 0o600 });
    await fs.writeFile(recoveryPath, JSON.stringify({
      version: 1,
      owner: "recovery-owner",
      pid: 2_147_483_646,
      acquiredAt: "2026-08-03T00:00:01.000Z",
    }), { mode: 0o600 });

    expect(await acquireUploadLease()).toBeUndefined();
    expect(await fs.readFile(lockPath, "utf8")).toBe(staleRecord);
    expect(await fs.stat(recoveryPath)).toBeDefined();
  });
});
