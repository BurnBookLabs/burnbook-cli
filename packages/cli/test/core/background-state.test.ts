import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_STATE_VERSION,
  backgroundAttempt,
  backgroundFailure,
  backgroundReady,
  backgroundSuccess,
  inspectBackgroundState,
  loadBackgroundState,
  saveBackgroundState,
} from "../../src/core/background-state.js";

const originalConfigDir = process.env.BURNBOOK_CONFIG_DIR;
let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-background-state-"));
  process.env.BURNBOOK_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = originalConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("background sync health state", () => {
  it("distinguishes missing state from a valid owner-only state", async () => {
    expect(await inspectBackgroundState()).toEqual({ status: "missing", privatePermissions: true });

    const attempted = backgroundAttempt(undefined, new Date("2026-08-03T10:00:00.000Z"));
    await saveBackgroundState(attempted);

    expect(await loadBackgroundState()).toEqual(attempted);
    const stat = await fs.stat(path.join(configDir, "background-state.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
  });

  it("records successful and failed transitions without arbitrary diagnostic text", () => {
    const attempt = backgroundAttempt(undefined, new Date("2026-08-03T10:00:00.000Z"));
    const success = backgroundSuccess(attempt, new Date("2026-08-03T10:00:02.000Z"));
    const failed = backgroundFailure(
      success,
      "network",
      new Date("2026-08-03T10:01:00.000Z"),
      new Date("2026-08-03T10:03:00.000Z"),
    );

    expect(success).toMatchObject({ status: "healthy", failureCount: 0 });
    expect(failed).toEqual({
      version: BACKGROUND_STATE_VERSION,
      status: "backoff",
      failureCount: 1,
      lastAttemptAt: "2026-08-03T10:01:00.000Z",
      lastSuccessAt: "2026-08-03T10:00:02.000Z",
      lastFailureAt: "2026-08-03T10:01:00.000Z",
      failureKind: "network",
      nextAttemptAt: "2026-08-03T10:03:00.000Z",
    });
    expect(Object.keys(failed)).not.toContain("message");
  });

  it("clears stale repair backoff while preserving the last successful sync", () => {
    const failed = backgroundFailure(
      backgroundSuccess(undefined, new Date("2026-08-03T10:00:00.000Z")),
      "server",
      new Date("2026-08-26T17:00:00.000Z"),
      new Date("2026-08-26T18:09:00.000Z"),
    );

    expect(backgroundReady(failed)).toEqual({
      version: BACKGROUND_STATE_VERSION,
      status: "idle",
      failureCount: 0,
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    });
  });

  it("rejects malformed state and unknown fields", async () => {
    await fs.writeFile(path.join(configDir, "background-state.json"), JSON.stringify({
      version: 1,
      status: "healthy",
      failureCount: 0,
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
      sourcePath: "/private/source.jsonl",
    }), { mode: 0o600 });

    expect(await loadBackgroundState()).toBeUndefined();
    expect(await inspectBackgroundState()).toEqual({ status: "invalid", privatePermissions: true });
  });

  it("reports broad permissions without returning file contents", async () => {
    await saveBackgroundState({
      version: 1,
      status: "healthy",
      failureCount: 0,
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    });
    await fs.chmod(path.join(configDir, "background-state.json"), 0o644);

    const inspection = await inspectBackgroundState();
    expect(inspection.status).toBe("valid");
    expect(inspection.privatePermissions).toBe(false);
  });

  it("cleans up an exclusive temporary file when atomic replacement fails", async () => {
    const target = path.join(configDir, "background-state.json");
    await fs.mkdir(target);

    await expect(saveBackgroundState({
      version: 1,
      status: "idle",
      failureCount: 0,
    })).rejects.toThrow();

    expect((await fs.readdir(configDir)).filter((name) => name.startsWith(".background-state-"))).toEqual([]);
  });
});
