import { describe, expect, it, vi } from "vitest";
import type { CliConfig } from "../../src/core/config.js";
import { runRetryWorker } from "../../src/commands/retry-worker.js";

const CONFIG: CliConfig = {
  deviceId: "device-1",
  deviceToken: "private-device-token",
};

describe("retry-worker command", () => {
  it("requires login before acquiring the upload lease", async () => {
    const acquireLease = vi.fn();
    const errors: string[] = [];
    const exitCode = await runRetryWorker({
      once: true,
      errorLog: (message) => errors.push(message),
      runtime: { loadConfig: async () => undefined, acquireLease },
    });
    expect(exitCode).toBe(1);
    expect(errors).toEqual(["Not logged in. Run `burn login` first."]);
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("runs one upload-only pass, bounds the batch count, and releases the lease", async () => {
    const release = vi.fn(async () => undefined);
    const upload = vi.fn(async () => ({
      accepted: 2,
      duplicates: 1,
      failedBatches: 0,
      quarantined: 0,
      deferredBatches: 0,
    }));
    const logs: string[] = [];
    const exitCode = await runRetryWorker({
      once: true,
      maxBatches: 3,
      log: (message) => logs.push(message),
      runtime: {
        loadConfig: async () => CONFIG,
        acquireLease: async () => ({ release }),
        upload,
      },
    });

    expect(exitCode).toBe(0);
    expect(upload).toHaveBeenCalledWith(CONFIG, {
      maxBatches: 3,
      signal: expect.any(AbortSignal),
    });
    expect(release).toHaveBeenCalledOnce();
    expect(logs[0]).toContain("uploads only sanitized evidence already in the spool");
    expect(JSON.stringify(logs)).not.toContain(CONFIG.deviceToken);
  });

  it("fails closed when another uploader owns the lease", async () => {
    const upload = vi.fn();
    const errors: string[] = [];
    const exitCode = await runRetryWorker({
      once: true,
      errorLog: (message) => errors.push(message),
      runtime: {
        loadConfig: async () => CONFIG,
        acquireLease: async () => undefined,
        upload,
      },
    });
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    expect(errors).toEqual(["another Burnbook upload worker is already active"]);
  });

  it("rejects invalid operational bounds without touching credentials or the spool", async () => {
    const loadConfig = vi.fn();
    const errors: string[] = [];
    expect(await runRetryWorker({
      intervalSeconds: 9,
      errorLog: (message) => errors.push(message),
      runtime: { loadConfig },
    })).toBe(1);
    expect(await runRetryWorker({
      maxBatches: 21,
      errorLog: (message) => errors.push(message),
      runtime: { loadConfig },
    })).toBe(1);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
  });
});
