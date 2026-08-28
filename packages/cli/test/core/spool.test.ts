import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageEvidenceV2 } from "@burnbook/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeEvidence,
  appendEvidence,
  inspectSpool,
  readPendingEvidence,
  recordQuarantine,
} from "../../src/core/spool.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-spool-"));
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
    sourceVersion: "claude-v1",
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

function evidencePath(): string {
  return path.join(temporaryDirectory, "spool", "evidence-v2.jsonl");
}

describe("private V2 evidence spool", () => {
  it("appends strict evidence once and creates owner-only files", async () => {
    expect(await appendEvidence([evidence()])).toEqual({ appended: 1, duplicates: 0 });
    expect(await appendEvidence([evidence()])).toEqual({ appended: 0, duplicates: 1 });
    expect((await fs.stat(path.dirname(evidencePath()))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(evidencePath())).mode & 0o777).toBe(0o600);
    expect((await readPendingEvidence()).evidence).toEqual([evidence()]);
    expect(await inspectSpool()).toEqual({
      pending: 1,
      malformed: 0,
      quarantined: 0,
      privatePermissions: true,
      scheduledRetries: 0,
      queueBytes: expect.any(Number),
      oldestPendingAt: evidence().occurredAt,
    });
  });

  it("does not remove evidence until it is explicitly acknowledged", async () => {
    await appendEvidence([evidence("event-1"), evidence("event-2")]);
    await acknowledgeEvidence([evidence("event-1")]);
    expect((await readPendingEvidence()).evidence.map((record) => record.eventId)).toEqual(["event-2"]);
  });

  it("deduplicates valid records left by concurrent appenders before sync", async () => {
    await fs.mkdir(path.dirname(evidencePath()), { recursive: true });
    const serialized = JSON.stringify(evidence("concurrent-event"));
    await fs.writeFile(evidencePath(), `${serialized}\n${serialized}\n`, { mode: 0o600 });

    const pending = await readPendingEvidence();
    expect(pending).toEqual({ evidence: [evidence("concurrent-event")], malformed: 0 });
    await acknowledgeEvidence(pending.evidence);
    expect(await readPendingEvidence()).toEqual({ evidence: [], malformed: 0 });
  });

  it("scopes dedupe and acknowledgement by agent and surface", async () => {
    const claude = evidence("shared-id");
    const codex = {
      ...evidence("shared-id"),
      agent: "codex" as const,
      supportTier: "preview" as const,
    };
    expect(await appendEvidence([claude, codex])).toEqual({ appended: 2, duplicates: 0 });
    await acknowledgeEvidence([claude]);
    expect((await readPendingEvidence()).evidence).toEqual([codex]);
  });

  it("rejects content-bearing records instead of serializing them", async () => {
    const tainted = { ...evidence(), prompt: "PRIVATE_SENTINEL" };
    await expect(appendEvidence([tainted as UsageEvidenceV2])).rejects.toThrow();
    const serialized = await fs.readFile(evidencePath(), "utf8").catch(() => "");
    expect(serialized).not.toContain("PRIVATE_SENTINEL");
  });

  it("refuses a symlinked evidence queue without modifying its target", async () => {
    const directory = path.dirname(evidencePath());
    const target = path.join(temporaryDirectory, "sentinel");
    await fs.mkdir(directory);
    await fs.writeFile(target, "do-not-touch", "utf8");
    await fs.symlink(target, evidencePath());

    await expect(appendEvidence([evidence()])).rejects.toThrow(/regular file|symbolic link/i);
    await expect(readPendingEvidence()).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("do-not-touch");
  });

  it("separates new evidence from an incomplete crash tail", async () => {
    await fs.mkdir(path.dirname(evidencePath()));
    await fs.writeFile(evidencePath(), "{\"eventId\":", { mode: 0o600 });

    expect(await appendEvidence([evidence("after-crash")])).toEqual({ appended: 1, duplicates: 0 });
    expect(await readPendingEvidence()).toEqual({
      evidence: [evidence("after-crash")],
      malformed: 1,
    });
  });

  it("continues durable append beyond the former 64MB queue ceiling", async () => {
    await fs.mkdir(path.dirname(evidencePath()));
    await fs.writeFile(evidencePath(), "", { mode: 0o600 });
    await fs.truncate(evidencePath(), 64 * 1024 * 1024 + 1);

    await expect(appendEvidence([evidence()])).resolves.toEqual({ appended: 1, duplicates: 0 });
    expect((await inspectSpool()).queueBytes).toBeGreaterThan(64 * 1024 * 1024);
  });

  it("quarantines malformed local lines by omission and reports only their count", async () => {
    await fs.mkdir(path.dirname(evidencePath()), { recursive: true });
    await fs.writeFile(evidencePath(), "{not-json}\n", { mode: 0o600 });
    expect(await readPendingEvidence()).toEqual({ evidence: [], malformed: 1 });
  });

  it("durably retains every content-free quarantine diagnostic", async () => {
    for (let index = 0; index < 110; index += 1) {
      await recordQuarantine("codex", 1);
    }
    expect((await inspectSpool()).quarantined).toBe(110);
    const serialized = await fs.readFile(
      path.join(temporaryDirectory, "spool", "quarantine-v2.jsonl"),
      "utf8",
    );
    expect(serialized).not.toMatch(/prompt|response|path|toolPayload/);
  });
});
