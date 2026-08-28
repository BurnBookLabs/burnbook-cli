import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkerLaunch,
  enqueueSync,
  runCollectWorker,
  runSyncWorker,
  sanitizedWorkerEnvironment,
} from "../../src/commands/hook.js";
import type { BackgroundState } from "../../src/core/background-state.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-hook-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("background sync dispatcher", () => {
  it("spawns a detached worker request and returns immediately", async () => {
    let starts = 0;
    expect(await enqueueSync({ spawnWorker: () => { starts += 1; } })).toBe(true);
    expect(starts).toBe(1);
  });

  it("surfaces a spawn failure without leaving dispatcher state", async () => {
    await expect(enqueueSync({ spawnWorker: () => { throw new Error("spawn failed"); } })).rejects.toThrow("spawn failed");
    expect(await enqueueSync({ spawnWorker: () => {} })).toBe(true);
  });

  it("never triggers the upload scheduler from an assistant hook", async () => {
    let spawned = false;
    let triggered = false;
    expect(await enqueueSync({
      triggerService: () => {
        triggered = true;
        return new Promise<boolean>(() => {});
      },
      spawnWorker: () => { spawned = true; },
    })).toBe(true);
    expect(triggered).toBe(false);
    expect(spawned).toBe(true);
  });

  it("drops ambient code-loading, endpoint, and cloud credential variables", () => {
    expect(sanitizedWorkerEnvironment({
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--require=/tmp/evil.js",
      BURNBOOK_API: "https://attacker.example",
      AWS_SECRET_ACCESS_KEY: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    })).toEqual({ HOME: "/Users/example", LANG: "en_US.UTF-8" });
  });

  it("builds an absolute no-shell launch with the CLI path as one argument", async () => {
    const entry = path.join(tmpDir, "burnbook;touch-pwned.js");
    await fs.writeFile(entry, "", "utf8");
    const launch = createWorkerLaunch(entry, process.execPath, { HOME: tmpDir }, tmpDir);
    const resolvedEntry = await fs.realpath(entry);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([resolvedEntry, "collect-worker"]);
    expect(launch.options).toMatchObject({
      cwd: tmpDir,
      detached: true,
      env: { HOME: tmpDir },
      shell: false,
      stdio: "ignore",
    });
  });

  it("runs the detached assistant-hook worker in local-collection-only mode", async () => {
    let syncOptions: unknown;
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("network should be unreachable");
    }) as typeof fetch;
    expect(await runCollectWorker({
      sync: async (options) => { syncOptions = options; return 0; },
    })).toBe(0);
    globalThis.fetch = originalFetch;
    expect(syncOptions).toMatchObject({ quiet: true, background: true, deliver: false });
    expect(fetched).toBe(false);
  });

  it("records a successful bounded worker run", async () => {
    let state: BackgroundState | undefined;
    const code = await runSyncWorker({
      now: (() => {
        const times = [new Date("2026-08-03T10:00:00Z"), new Date("2026-08-03T10:00:01Z")];
        return () => times.shift()!;
      })(),
      sync: async () => 0,
      loadState: async () => state,
      saveState: async (next) => { state = next; },
    });
    expect(code).toBe(0);
    expect(state).toMatchObject({ status: "healthy", failureCount: 0, lastSuccessAt: "2026-08-03T10:00:01.000Z" });
  });

  it("persists rate-limit backoff instead of sleeping under the sync lock", async () => {
    let state: BackgroundState | undefined;
    const code = await runSyncWorker({
      now: (() => {
        const times = [new Date("2026-08-03T10:00:00Z"), new Date("2026-08-03T10:00:01Z")];
        return () => times.shift()!;
      })(),
      sync: async (options) => {
        options.onFailure?.("rate-limited", 120);
        return 1;
      },
      loadState: async () => state,
      saveState: async (next) => { state = next; },
    });
    expect(code).toBe(1);
    expect(state).toMatchObject({
      status: "backoff",
      failureKind: "rate-limited",
      nextAttemptAt: "2026-08-03T10:02:01.000Z",
    });
  });

  it("continues local collection while authentication delivery is paused", async () => {
    const state: BackgroundState = {
      version: 1,
      status: "authentication-required",
      failureCount: 1,
      lastAttemptAt: "2026-08-03T09:00:00.000Z",
      lastFailureAt: "2026-08-03T09:00:00.000Z",
      failureKind: "authentication",
    };
    let syncOptions: unknown;
    let saves = 0;
    const code = await runSyncWorker({
      now: () => new Date("2026-08-03T10:00:00Z"),
      sync: async (options) => { syncOptions = options; return 0; },
      loadState: async () => state,
      saveState: async () => { saves += 1; },
    });
    expect(code).toBe(0);
    expect(syncOptions).toMatchObject({ quiet: true, background: true, deliver: false });
    expect(saves).toBe(0);
  });
});
