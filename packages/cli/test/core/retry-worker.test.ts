import { describe, expect, it, vi } from "vitest";
import { runRetryWorkerLoop } from "../../src/core/retry-worker.js";

const EMPTY_PASS = {
  accepted: 0,
  duplicates: 0,
  failedBatches: 0,
  quarantined: 0,
  deferredBatches: 0,
};

describe("foreground retry worker loop", () => {
  it("runs one bounded pass and emits aggregates only", async () => {
    const logs: string[] = [];
    const result = await runRetryWorkerLoop({
      once: true,
      intervalMs: 60_000,
      signal: new AbortController().signal,
      runPass: async () => ({ ...EMPTY_PASS, accepted: 3, duplicates: 2 }),
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ passes: 1, failedPasses: 0, stopped: "once" });
    expect(logs).toEqual([
      "retry worker pass: 3 accepted, 2 duplicates, 0 failed batch(es), 0 quarantined event(s), 0 deferred batch(es)",
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/prompt|response|event-|session-|token/i);
  });

  it("wakes for the next scheduled retry and exits cleanly when aborted", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    const runPass = vi.fn(async () => ({
      ...EMPTY_PASS,
      deferredBatches: 1,
      nextAttemptAt: "2026-08-03T00:00:12.000Z",
    }));
    const result = await runRetryWorkerLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      now: () => Date.parse("2026-08-03T00:00:00.000Z"),
      runPass,
      sleep: async (delay) => {
        sleeps.push(delay);
        controller.abort();
      },
      log: () => undefined,
    });

    expect(sleeps).toEqual([12_000]);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe("signal");
  });

  it("backs off local failures without logging their potentially sensitive messages", async () => {
    const controller = new AbortController();
    const errors: string[] = [];
    const sleeps: number[] = [];
    const result = await runRetryWorkerLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      random: () => 1,
      runPass: async () => {
        throw new Error("/private/path/secret-transcript.jsonl");
      },
      sleep: async (delay) => {
        sleeps.push(delay);
        controller.abort();
      },
      errorLog: (message) => errors.push(message),
    });

    expect(sleeps).toEqual([5_000]);
    expect(result).toEqual({ passes: 1, failedPasses: 1, stopped: "signal" });
    expect(errors).toEqual([
      "retry worker pass failed locally; no evidence details were logged",
    ]);
    expect(JSON.stringify(errors)).not.toContain("secret-transcript");
  });

  it("does no work when shutdown was already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const runPass = vi.fn();
    const result = await runRetryWorkerLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      runPass,
    });
    expect(result).toEqual({ passes: 0, failedPasses: 0, stopped: "signal" });
    expect(runPass).not.toHaveBeenCalled();
  });

  it("rejects poll intervals outside the operational bounds", async () => {
    await expect(runRetryWorkerLoop({
      intervalMs: 9_999,
      signal: new AbortController().signal,
      runPass: async () => EMPTY_PASS,
    })).rejects.toThrow("interval must be between 10 and 3600 seconds");
  });
});
