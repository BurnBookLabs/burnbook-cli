import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ed from "@noble/ed25519";
import type { UsageEvidenceV2 } from "@burnbook/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync, syncErrorCategory } from "../../src/commands/sync.js";
import { saveConfig } from "../../src/core/config.js";
import { ensureKeypair } from "../../src/core/keys.js";
import { appendEvidence, inspectSpool, readPendingEvidence } from "../../src/core/spool.js";
import { getOriginalDispatcher, setupMockFetch, teardownMockFetch } from "../helpers/mockFetch.js";

const DEVICE_ID = "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f";
const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
const ORIGINAL_API = process.env.BURNBOOK_API;
let configDirectory: string;
let sourceRoot: string;
let mockAgent: ReturnType<typeof setupMockFetch>;
let originalDispatcher: ReturnType<typeof getOriginalDispatcher>;

beforeEach(async () => {
  configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-sync-v2-config-"));
  sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-sync-v2-source-"));
  process.env.BURNBOOK_CONFIG_DIR = configDirectory;
  process.env.BURNBOOK_API = "https://api.test";
  originalDispatcher = getOriginalDispatcher();
  mockAgent = setupMockFetch();
  await saveConfig({ deviceToken: "token", deviceId: DEVICE_ID });
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  if (ORIGINAL_API === undefined) delete process.env.BURNBOOK_API;
  else process.env.BURNBOOK_API = ORIGINAL_API;
  mockAgent.assertNoPendingInterceptors();
  teardownMockFetch(mockAgent, originalDispatcher);
  await fs.rm(configDirectory, { recursive: true, force: true });
  await fs.rm(sourceRoot, { recursive: true, force: true });
});

function evidence(
  eventId: string,
  agent: "claude-code" | "codex" = "claude-code",
): UsageEvidenceV2 {
  return {
    schemaVersion: 2,
    agent,
    surface: "cli",
    source: "transcript",
    sourceVersion: agent === "codex" ? "codex-v1" : "claude-v1",
    collectorVersion: "1",
    normalizerVersion: 1,
    evidenceClass: "agent-local",
    supportTier: agent === "codex" ? "preview" : "supported",
    eventId,
    sessionId: "session-1",
    occurredAt: "2026-07-31T12:00:00.000Z",
    timeBasis: "provider",
    model: agent === "codex" ? "gpt-5.6-codex" : "claude-sonnet-5",
    inputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    outputTokens: 5,
    reasoningTokens: 0,
    toolInputTokens: 0,
    totalTokens: 18,
  };
}

describe("Evidence V2 sync", () => {
  it("redacts absolute paths from structured sync errors", () => {
    const error = Object.assign(new Error("ENOENT /Users/private/company/secret.jsonl"), { code: "ENOENT" });
    const rendered = syncErrorCategory(error);
    expect(rendered).toBe("local evidence could not be read safely");
    expect(rendered).not.toContain("/Users/private");
  });
  it("collects a fresh Claude install into V2 before uploading", async () => {
    const project = path.join(sourceRoot, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "session.jsonl"), `${JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      requestId: "request-1",
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: "message-1",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      },
    })}\n`);
    mockAgent.get("https://api.test").intercept({ path: "/api/v2/sync", method: "POST" }).reply(200, {
      acceptedEventIds: ["v1-5927e99824d114a4718f311ead6a5bd0"],
      duplicateEventIds: [],
    });

    expect(await runSync({ root: sourceRoot, log: () => {} })).toBe(0);
    expect((await readPendingEvidence()).evidence).toEqual([]);
  });

  it("makes quiet sync local-collection-only even when upload evidence is pending", async () => {
    await appendEvidence([evidence("event-1")]);
    expect(await runSync({ root: sourceRoot, quiet: true })).toBe(0);
    expect((await readPendingEvidence()).evidence.map((record) => record.eventId)).toEqual(["event-1"]);
  });

  it("signs, uploads, and acknowledges a pending homogeneous batch", async () => {
    await appendEvidence([evidence("event-1"), evidence("event-2")]);
    const { publicKeyB64 } = await ensureKeypair();
    let captured: { payloadB64: string; signatureB64: string } | undefined;
    mockAgent.get("https://api.test").intercept({ path: "/api/v2/sync", method: "POST" }).reply((options) => {
      captured = JSON.parse(options.body as string);
      return {
        statusCode: 200,
        data: JSON.stringify({ acceptedEventIds: ["event-1"], duplicateEventIds: ["event-2"] }),
      };
    });

    const logs: string[] = [];
    expect(await runSync({ root: sourceRoot, log: (message) => logs.push(message) })).toBe(0);
    expect(logs).toContain("synced 1 new events (1 duplicates)");
    expect((await readPendingEvidence()).evidence).toEqual([]);

    const bytes = Buffer.from(captured!.payloadB64, "base64");
    expect(await ed.verifyAsync(
      Buffer.from(captured!.signatureB64, "base64"),
      bytes,
      Buffer.from(publicKeyB64, "base64"),
    )).toBe(true);
    const payload = JSON.parse(bytes.toString("utf8"));
    expect(payload).toMatchObject({
      schemaVersion: 2,
      clientVersion: "0.0.0-dev",
      deviceId: DEVICE_ID,
    });
    expect(payload.evidence).toHaveLength(2);
    expect(new Set(payload.evidence.map((record: UsageEvidenceV2) => `${record.agent}:${record.surface}`)).size).toBe(1);

    const secondLogs: string[] = [];
    expect(await runSync({ root: sourceRoot, log: (message) => secondLogs.push(message) })).toBe(0);
    expect(secondLogs).toEqual(["synced 0 new events (0 duplicates)"]);
  });

  it("uses the origin bound at login for background sync after the ambient override is gone", async () => {
    await saveConfig({
      deviceToken: "staging-token",
      deviceId: DEVICE_ID,
      apiOrigin: "https://staging.burnbook.dev",
    });
    delete process.env.BURNBOOK_API;
    await appendEvidence([evidence("staging-event")]);
    mockAgent.get("https://staging.burnbook.dev")
      .intercept({ path: "/api/v2/sync", method: "POST" })
      .reply(200, { acceptedEventIds: ["staging-event"], duplicateEventIds: [] });

    expect(await runSync({ root: sourceRoot, background: true, log: () => {} })).toBe(0);
    expect((await readPendingEvidence()).evidence).toEqual([]);
  });

  it("uploads one record when concurrent collectors left duplicate spool lines", async () => {
    const directory = path.join(configDirectory, "spool");
    await fs.mkdir(directory, { recursive: true });
    const serialized = JSON.stringify(evidence("concurrent-event"));
    await fs.writeFile(path.join(directory, "evidence-v2.jsonl"), `${serialized}\n${serialized}\n`, { mode: 0o600 });
    let uploadedCount = 0;
    mockAgent.get("https://api.test").intercept({ path: "/api/v2/sync", method: "POST" }).reply((options) => {
      const envelope = JSON.parse(options.body as string) as { payloadB64: string };
      const payload = JSON.parse(Buffer.from(envelope.payloadB64, "base64").toString("utf8"));
      uploadedCount = payload.evidence.length;
      return {
        statusCode: 200,
        data: JSON.stringify({ acceptedEventIds: ["concurrent-event"], duplicateEventIds: [] }),
      };
    });

    expect(await runSync({ root: sourceRoot, log: () => {} })).toBe(0);
    expect(uploadedCount).toBe(1);
    expect((await readPendingEvidence()).evidence).toEqual([]);
  });

  it("quarantines a permanently rejected batch and never logs the response body", async () => {
    await appendEvidence([evidence("event-1")]);
    mockAgent.get("https://api.test").intercept({ path: "/api/v2/sync", method: "POST" }).reply(422, {
      error: "PRIVATE_SERVER_BODY_SENTINEL",
    });

    const logs: string[] = [];
    const errors: string[] = [];
    expect(await runSync({ root: sourceRoot, log: (message) => logs.push(message), errorLog: (message) => errors.push(message) })).toBe(0);
    expect((await readPendingEvidence()).evidence).toEqual([]);
    expect((await inspectSpool()).quarantined).toBe(1);
    expect(JSON.stringify({ logs, errors })).not.toContain("PRIVATE_SERVER_BODY_SENTINEL");
  });

  it("allows one agent batch to succeed when another agent batch fails", async () => {
    await appendEvidence([evidence("claude-event"), evidence("codex-event", "codex")]);
    const pool = mockAgent.get("https://api.test");
    pool.intercept({ path: "/api/v2/sync", method: "POST" }).reply(500, { error: "retry" });
    pool.intercept({ path: "/api/v2/sync", method: "POST" }).reply(200, {
      acceptedEventIds: ["codex-event"],
      duplicateEventIds: [],
    });

    expect(await runSync({ root: sourceRoot, log: () => {}, errorLog: () => {} })).toBe(1);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending.map((record) => record.eventId)).toEqual(["claude-event"]);
  });

  it("preserves Claude supported and Codex preview tiers through background spool upload", async () => {
    await appendEvidence([
      evidence("claude-supported"),
      evidence("codex-preview", "codex"),
    ]);
    const captured: UsageEvidenceV2[] = [];
    const pool = mockAgent.get("https://api.test");
    for (let index = 0; index < 2; index += 1) {
      pool.intercept({ path: "/api/v2/sync", method: "POST" }).reply((options) => {
        const envelope = JSON.parse(options.body as string) as { payloadB64: string };
        const payload = JSON.parse(
          Buffer.from(envelope.payloadB64, "base64").toString("utf8"),
        ) as { evidence: UsageEvidenceV2[] };
        captured.push(...payload.evidence);
        return {
          statusCode: 200,
          data: JSON.stringify({
            acceptedEventIds: payload.evidence.map((record) => record.eventId),
            duplicateEventIds: [],
          }),
        };
      });
    }

    expect(await runSync({
      root: sourceRoot,
      background: true,
      log: () => {},
      errorLog: () => {},
    })).toBe(0);
    expect(captured.map((record) => ({
      eventId: record.eventId,
      agent: record.agent,
      supportTier: record.supportTier,
      evidenceClass: record.evidenceClass,
    }))).toEqual([
      {
        eventId: "claude-supported",
        agent: "claude-code",
        supportTier: "supported",
        evidenceClass: "agent-local",
      },
      {
        eventId: "codex-preview",
        agent: "codex",
        supportTier: "preview",
        evidenceClass: "agent-local",
      },
    ]);
    expect((await readPendingEvidence()).evidence).toEqual([]);
  });

  it("separates records with different source or support classifications", async () => {
    const supported = evidence("supported-event");
    const preview = {
      ...evidence("preview-event"),
      source: "hook" as const,
      supportTier: "preview" as const,
    };
    await appendEvidence([supported, preview]);
    const capturedPayloads: UsageEvidenceV2[][] = [];
    const pool = mockAgent.get("https://api.test");
    for (const eventId of ["supported-event", "preview-event"]) {
      pool.intercept({ path: "/api/v2/sync", method: "POST" }).reply((options) => {
        const envelope = JSON.parse(options.body as string) as { payloadB64: string };
        const payload = JSON.parse(Buffer.from(envelope.payloadB64, "base64").toString("utf8"));
        capturedPayloads.push(payload.evidence);
        return {
          statusCode: 200,
          data: JSON.stringify({ acceptedEventIds: [eventId], duplicateEventIds: [] }),
        };
      });
    }

    expect(await runSync({ root: sourceRoot, log: () => {} })).toBe(0);
    expect(capturedPayloads).toHaveLength(2);
    expect(capturedPayloads.every((batch) => batch.length === 1)).toBe(true);
  });

  it("fails closed while preserving evidence after an inconsistent acknowledgement", async () => {
    await appendEvidence([evidence("event-1")]);
    mockAgent.get("https://api.test").intercept({ path: "/api/v2/sync", method: "POST" }).reply(200, {
      acceptedEventIds: ["unknown-event"],
      duplicateEventIds: [],
    });

    expect(await runSync({ root: sourceRoot, log: () => {}, errorLog: () => {} })).toBe(1);
    expect((await readPendingEvidence()).evidence).toHaveLength(1);
    expect((await inspectSpool()).quarantined).toBe(0);
  });
});
