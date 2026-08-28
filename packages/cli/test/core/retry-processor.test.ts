import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEvidenceV2 } from "@burnbook/schema";
import { processEvidenceSpoolRetries } from "../../src/core/retry-processor.js";
import {
  appendEvidence,
  inspectSpool,
  readPendingEvidence,
  writeRetrySchedule,
} from "../../src/core/spool.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-retry-"));
  process.env.BURNBOOK_CONFIG_DIR = temporaryDirectory;
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function evidence(eventId = "event-1"): UsageEvidenceV2 {
  return {
    schemaVersion: 2,
    agent: "claude-code",
    surface: "cli",
    source: "transcript",
    sourceVersion: "claude-transcript-v1",
    collectorVersion: "1",
    normalizerVersion: 1,
    evidenceClass: "agent-local",
    supportTier: "supported",
    eventId,
    sessionId: "session-1",
    occurredAt: "2026-07-31T12:00:00.000Z",
    timeBasis: "provider",
    model: "claude-sonnet-5",
    inputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    outputTokens: 5,
    reasoningTokens: 0,
    toolInputTokens: 0,
    totalTokens: 18,
  };
}

describe("local spool retry processor", () => {
  it("schedules retryable failures and resumes them after bounded backoff", async () => {
    await appendEvidence([evidence()]);
    const firstUpload = vi.fn(async () => ({ status: "retry" as const }));

    const first = await processEvidenceSpoolRetries({
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      random: () => 1,
      uploadBatch: firstUpload,
    });
    expect(first).toMatchObject({
      accepted: 0,
      duplicates: 0,
      failedBatches: 1,
      deferredBatches: 0,
      nextAttemptAt: "2026-08-03T00:00:30.000Z",
    });
    expect((await inspectSpool()).scheduledRetries).toBe(1);
    expect((await readPendingEvidence()).evidence).toHaveLength(1);

    const deferredUpload = vi.fn(async () => ({ status: "retry" as const }));
    const deferred = await processEvidenceSpoolRetries({
      now: () => new Date("2026-08-03T00:00:29.999Z"),
      uploadBatch: deferredUpload,
    });
    expect(deferred).toMatchObject({ failedBatches: 0, deferredBatches: 1 });
    expect(deferredUpload).not.toHaveBeenCalled();

    const retryUpload = vi.fn(async (batch: readonly UsageEvidenceV2[]) => ({
      status: "success" as const,
      response: { acceptedEventIds: [batch[0].eventId], duplicateEventIds: [] },
    }));
    const retried = await processEvidenceSpoolRetries({
      now: () => new Date("2026-08-03T00:00:30.000Z"),
      uploadBatch: retryUpload,
    });
    expect(retried).toEqual({
      accepted: 1,
      duplicates: 0,
      failedBatches: 0,
      quarantined: 0,
      deferredBatches: 0,
    });
    expect((await readPendingEvidence()).evidence).toEqual([]);
    expect((await inspectSpool()).scheduledRetries).toBe(0);
  });

  it("retries inconsistent acknowledgements without discarding evidence", async () => {
    await appendEvidence([evidence("expected-event")]);

    const result = await processEvidenceSpoolRetries({
      uploadBatch: async () => ({
        status: "success",
        response: { acceptedEventIds: ["unexpected-event"], duplicateEventIds: [] },
      }),
    });

    expect(result).toMatchObject({ failedBatches: 1, quarantined: 0 });
    expect((await readPendingEvidence()).evidence).toHaveLength(1);
    expect((await inspectSpool()).quarantined).toBe(0);
  });

  it("quarantines permanent rejections and continues with later batches", async () => {
    await appendEvidence([evidence("permanent-event")]);
    const result = await processEvidenceSpoolRetries({
      uploadBatch: async () => ({ status: "permanent", reason: "permanent_rejection" }),
    });

    expect(result).toMatchObject({ failedBatches: 0, quarantined: 1 });
    expect((await readPendingEvidence()).evidence).toEqual([]);
  });

  it("isolates one permanent record while valid neighbors continue draining", async () => {
    const records = [evidence("good-one"), evidence("bad-record"), evidence("good-two")];
    await appendEvidence(records);
    const result = await processEvidenceSpoolRetries({
      uploadBatch: async (batch) => batch.some((record) => record.eventId === "bad-record")
        ? { status: "permanent", reason: "permanent_rejection" }
        : {
          status: "success",
          response: {
            acceptedEventIds: batch.map((record) => record.eventId),
            duplicateEventIds: [],
          },
        },
    });

    expect(result).toMatchObject({ accepted: 2, quarantined: 1, failedBatches: 0 });
    expect((await readPendingEvidence()).evidence).toEqual([]);
    expect((await inspectSpool()).quarantined).toBe(1);
  });

  it("jitters exponential retry timing and respects a bounded Retry-After floor", async () => {
    await appendEvidence([evidence()]);
    const jittered = await processEvidenceSpoolRetries({
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      random: () => 0,
      uploadBatch: async () => ({ status: "retry" }),
    });
    expect(jittered.nextAttemptAt).toBe("2026-08-03T00:00:24.000Z");

    const retryAfter = await processEvidenceSpoolRetries({
      force: true,
      now: () => new Date("2026-08-03T00:00:01.000Z"),
      random: () => 0,
      uploadBatch: async () => ({ status: "retry", retryAfterMs: 90_000 }),
    });
    expect(retryAfter.nextAttemptAt).toBe("2026-08-03T00:01:31.000Z");
  });

  it("stores only digest, attempt count, and retry time", async () => {
    await appendEvidence([evidence("private-event-sentinel")]);
    await processEvidenceSpoolRetries({
      uploadBatch: async () => ({ status: "retry" }),
    });

    const serialized = await fs.readFile(
      path.join(temporaryDirectory, "spool", "retry-state-v2.json"),
      "utf8",
    );
    expect(serialized).not.toContain("private-event-sentinel");
    expect(serialized).not.toMatch(/prompt|response|path|error|payload|transcript/i);
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      batches: [{ attempts: 1 }],
    });
  });

  it("processes a large spool in bounded windows without pruning an unseen tail retry", async () => {
    const records = Array.from({ length: 5001 }, (_, index) =>
      evidence(`window-event-${index.toString().padStart(4, "0")}`),
    );
    await appendEvidence(records);
    const tail = records[5000];
    const tailDigest = createHash("sha256")
      .update(JSON.stringify([[tail.agent, tail.surface, tail.eventId]]))
      .digest("hex");
    await writeRetrySchedule([{
      batchDigest: tailDigest,
      attempts: 1,
      nextAttemptAt: "2026-08-03T00:01:00.000Z",
    }]);

    const batchSizes: number[] = [];
    const first = await processEvidenceSpoolRetries({
      maxBatches: 1,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      uploadBatch: async (batch) => {
        batchSizes.push(batch.length);
        return {
          status: "success",
          response: {
            acceptedEventIds: batch.map((entry) => entry.eventId),
            duplicateEventIds: [],
          },
        };
      },
    });

    expect(batchSizes).toEqual([5000]);
    expect(first).toMatchObject({ accepted: 5000, deferredBatches: 1 });
    expect((await readPendingEvidence()).evidence.map((entry) => entry.eventId))
      .toEqual([tail.eventId]);
    expect((await inspectSpool()).scheduledRetries).toBe(1);

    const earlyUpload = vi.fn();
    const early = await processEvidenceSpoolRetries({
      maxBatches: 1,
      now: () => new Date("2026-08-03T00:00:59.999Z"),
      uploadBatch: earlyUpload,
    });
    expect(early).toMatchObject({ accepted: 0, deferredBatches: 1 });
    expect(earlyUpload).not.toHaveBeenCalled();

    const final = await processEvidenceSpoolRetries({
      maxBatches: 1,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
      uploadBatch: async (batch) => ({
        status: "success",
        response: { acceptedEventIds: [batch[0].eventId], duplicateEventIds: [] },
      }),
    });
    expect(final).toEqual({
      accepted: 1,
      duplicates: 0,
      failedBatches: 0,
      quarantined: 0,
      deferredBatches: 0,
    });
    expect((await readPendingEvidence()).evidence).toEqual([]);
    expect((await inspectSpool()).scheduledRetries).toBe(0);
  });
});
