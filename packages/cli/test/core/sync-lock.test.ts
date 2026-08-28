import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSyncLock } from "../../src/core/sync-lock.js";

const originalConfigDir = process.env.BURNBOOK_CONFIG_DIR;
let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-sync-lock-"));
  process.env.BURNBOOK_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = originalConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("sync process lock", () => {
  it("serializes live sync processes and releases only its own lock", async () => {
    const first = await acquireSyncLock();
    expect(first).toBeDefined();
    expect(await acquireSyncLock()).toBeUndefined();

    await first?.release();
    const next = await acquireSyncLock();
    expect(next).toBeDefined();
    await next?.release();
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "dead" }), { mode: 0o600 });

    const lock = await acquireSyncLock();
    expect(lock).toBeDefined();
    await lock?.release();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("keeps an expired lease while its recorded process is alive", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    await fs.writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: "expired",
      createdAtMs: 10,
      leaseUntilMs: 20,
    }), { mode: 0o600 });
    let probes = 0;

    const lock = await acquireSyncLock({
      now: () => 100,
      processIsAlive: () => { probes += 1; return true; },
    });
    expect(lock).toBeUndefined();
    expect(probes).toBe(1);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({ token: "expired" });
  });

  it("keeps a legacy lock while its recorded process is alive", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "legacy" }), { mode: 0o600 });
    const mtimeMs = (await fs.stat(lockPath)).mtimeMs;

    expect(await acquireSyncLock({
      now: () => mtimeMs + 500,
      leaseMs: 1000,
      processIsAlive: () => true,
    })).toBeUndefined();
    expect(await acquireSyncLock({
      now: () => mtimeMs + 1500,
      leaseMs: 1000,
      processIsAlive: () => true,
    })).toBeUndefined();
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({ token: "legacy" });
  });

  it("reclaims malformed lock bytes", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    await fs.writeFile(lockPath, "not-json", { mode: 0o600 });

    const lock = await acquireSyncLock();
    expect(lock).toBeDefined();
    await lock?.release();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("never removes a successor lock when the old owner releases", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    const first = await acquireSyncLock();
    expect(first).toBeDefined();
    await fs.writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: "successor",
      createdAtMs: Date.now(),
      leaseUntilMs: Date.now() + 1000,
    }));

    await first?.release();
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({ token: "successor" });
  });

  it("replaces a lock symlink without modifying its target", async () => {
    const lockPath = path.join(configDir, "sync-worker.lock");
    const target = path.join(configDir, "sentinel");
    await fs.writeFile(target, "do-not-touch", "utf8");
    await fs.symlink(target, lockPath);

    const lock = await acquireSyncLock({ processIsAlive: () => false });
    expect(lock).toBeDefined();
    expect(await fs.readFile(target, "utf8")).toBe("do-not-touch");
    expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(false);
    await lock?.release();
  });

  it("refuses a symlinked config directory", async () => {
    const realDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-real-config-"));
    const linkedDirectory = path.join(path.dirname(configDir), `burnbook-linked-${process.pid}`);
    await fs.symlink(realDirectory, linkedDirectory);
    process.env.BURNBOOK_CONFIG_DIR = linkedDirectory;
    try {
      await expect(acquireSyncLock()).rejects.toThrow("must be a real directory");
    } finally {
      process.env.BURNBOOK_CONFIG_DIR = configDir;
      await fs.unlink(linkedDirectory);
      await fs.rm(realDirectory, { recursive: true, force: true });
    }
  });
});
