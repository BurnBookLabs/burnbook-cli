import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDoctor, runDoctor } from "../../src/commands/doctor.js";
import { saveBackgroundState } from "../../src/core/background-state.js";
import { saveConfig } from "../../src/core/config.js";

const originalConfigDir = process.env.BURNBOOK_CONFIG_DIR;
let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-doctor-secret-marker-"));
  process.env.BURNBOOK_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = originalConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});

async function makeHealthy(): Promise<void> {
  await saveConfig({ deviceToken: "secret-device-token", deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });
  await fs.writeFile(path.join(configDir, "key.json"), "secret-key", { mode: 0o600 });
  await saveBackgroundState({
    version: 1,
    status: "healthy",
    failureCount: 0,
    lastAttemptAt: "2026-08-03T10:00:00.000Z",
    lastSuccessAt: "2026-08-03T10:00:01.000Z",
  });
}

describe("doctor", () => {
  it("returns a structured healthy report with injected scheduler inspection", async () => {
    await makeHealthy();
    const report = await inspectDoctor({
      inspectScheduler: async () => ({ state: "installed" }),
      now: new Date("2026-08-03T10:01:00.000Z"),
    });

    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual([
      { id: "authentication", status: "ok", code: "logged-in" },
      { id: "permissions", status: "ok", code: "private" },
      { id: "scheduler", status: "ok", code: "enabled" },
      { id: "worker", status: "ok", code: "idle" },
      { id: "spool", status: "ok", code: "empty", count: 0 },
      { id: "background", status: "ok", code: "recent-success" },
    ]);
  });

  it("reports missing login, scheduler, and first success without leaking local values", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runDoctor({
      inspectScheduler: async () => ({ status: "disabled" }),
      log: (message) => logs.push(message),
      errorLog: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    const output = [...logs, ...errors].join("\n");
    expect(output).toContain("burn login");
    expect(output).toContain("burn repair");
    expect(output).not.toContain(configDir);
    expect(output).not.toContain("secret-device-token");
  });

  it("does not expose an exception thrown by scheduler inspection", async () => {
    await makeHealthy();
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runDoctor({
      inspectScheduler: async () => { throw new Error(`secret ${configDir}`); },
      now: new Date("2026-08-03T10:01:00.000Z"),
      log: (message) => logs.push(message),
      errorLog: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect([...logs, ...errors].join("\n")).not.toContain(configDir);
  });

  it("distinguishes a live lock from malformed and stale locks", async () => {
    await makeHealthy();
    const lockPath = path.join(configDir, "sync-worker.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 42, token: "owner" }), { mode: 0o600 });

    const active = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      processIsAlive: () => true,
      now: new Date("2026-08-03T10:01:00.000Z"),
    });
    expect(active.checks.find((check) => check.id === "worker")).toMatchObject({ status: "ok", code: "active" });

    const stale = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      processIsAlive: () => false,
      now: new Date("2026-08-03T10:01:00.000Z"),
    });
    expect(stale.checks.find((check) => check.id === "worker")).toMatchObject({ status: "error", code: "lock-stale" });

    await fs.writeFile(lockPath, "not json", { mode: 0o600 });
    const malformed = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      now: new Date("2026-08-03T10:01:00.000Z"),
    });
    expect(malformed.checks.find((check) => check.id === "worker")).toMatchObject({ status: "error", code: "lock-malformed" });
  });

  it("refuses symlinked and oversized worker lock files", async () => {
    await makeHealthy();
    const lockPath = path.join(configDir, "sync-worker.lock");
    const targetPath = path.join(configDir, "lock-target.json");
    await fs.writeFile(targetPath, JSON.stringify({ pid: 42, token: "owner" }), { mode: 0o600 });
    await fs.symlink(targetPath, lockPath);

    const symlinked = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      processIsAlive: () => true,
      now: new Date("2026-08-03T10:01:00.000Z"),
    });
    expect(symlinked.checks.find((check) => check.id === "worker"))
      .toMatchObject({ status: "error", code: "lock-unreadable" });

    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    const oversized = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      now: new Date("2026-08-03T10:01:00.000Z"),
    });
    expect(oversized.checks.find((check) => check.id === "worker"))
      .toMatchObject({ status: "error", code: "lock-unreadable" });
  });

  it("flags stale success and broad local permissions", async () => {
    await makeHealthy();
    await fs.chmod(path.join(configDir, "config.json"), 0o644);
    const report = await inspectDoctor({
      inspectScheduler: async () => ({ status: "enabled" }),
      now: new Date("2026-08-03T11:00:00.000Z"),
      staleAfterMs: 5 * 60 * 1000,
    });

    expect(report.healthy).toBe(false);
    expect(report.checks.find((check) => check.id === "permissions")).toMatchObject({ status: "error", code: "too-broad" });
    expect(report.checks.find((check) => check.id === "background")).toMatchObject({ status: "error", code: "last-success-stale" });
  });

  it("reports malformed queued records without echoing their contents", async () => {
    await makeHealthy();
    const spoolDir = path.join(configDir, "spool");
    await fs.mkdir(spoolDir, { mode: 0o700 });
    await fs.writeFile(path.join(spoolDir, "evidence-v2.jsonl"), "secret malformed record\n", { mode: 0o600 });
    const logs: string[] = [];
    const errors: string[] = [];

    expect(await runDoctor({
      inspectScheduler: async () => ({ state: "installed" }),
      now: new Date("2026-08-03T10:01:00.000Z"),
      log: (message) => logs.push(message),
      errorLog: (message) => errors.push(message),
    })).toBe(1);
    const output = [...logs, ...errors].join("\n");
    expect(output).toContain("malformed records");
    expect(output).not.toContain("secret malformed record");
  });
});
