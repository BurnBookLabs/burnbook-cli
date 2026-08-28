import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReconcile } from "../../src/commands/reconcile.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-reconcile-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("legacy reconciliation", () => {
  it("classifies canonical identities without adding overlapping totals", async () => {
    const matched = legacy("m1", 10);
    const conflictLocal = legacy("m2", 20);
    const conflictServer = legacy("m2", 21);
    const local = path.join(root, "local.jsonl");
    const server = path.join(root, "server.jsonl");
    const out = path.join(root, "ledger.json");
    await fs.writeFile(local, `${JSON.stringify(matched)}\n${JSON.stringify(conflictLocal)}\n${JSON.stringify(legacy("m3", 30))}\n`);
    await fs.writeFile(server, `${JSON.stringify(matched)}\n${JSON.stringify(conflictServer)}\n${JSON.stringify(legacy("m4", 40))}\n`);
    expect(await runReconcile({ local, server, out, log: () => {} })).toBe(2);
    const ledger = JSON.parse(await fs.readFile(out, "utf8"));
    expect(ledger.counts).toEqual({ matched: 1, localOnly: 1, serverOnly: 1, conflict: 2, invalid: 0 });
    expect(JSON.stringify(ledger)).not.toContain("prompt");
  });

  it("matches a canonical V1 alias despite millisecond timestamp drift", async () => {
    const raw = legacy("m1", 10);
    const eventId = `v1-${createHash("md5")
      .update(`${raw.sessionId}\x1f${raw.messageId}\x1f${raw.requestId}`)
      .digest("hex")}`;
    const exported = {
      schemaVersion: 3,
      agent: "claude-code",
      surface: "cli",
      source: "transcript",
      sourceVersion: "claude-transcript-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      supportTier: "supported",
      eventId,
      sessionId: raw.sessionId,
      occurredAt: new Date(Date.parse(raw.ts) - 6).toISOString(),
      timeBasis: "provider",
      model: raw.model,
      inputTokens: String(raw.inputTokens),
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      outputTokens: String(raw.outputTokens),
      reasoningTokens: "0",
      toolInputTokens: "0",
      totalTokens: String(raw.inputTokens + raw.outputTokens),
    };
    const local = path.join(root, "raw-legacy.jsonl");
    const server = path.join(root, "server-export.jsonl");
    const out = path.join(root, "ledger.json");
    await fs.writeFile(local, `${JSON.stringify(raw)}\n`);
    await fs.writeFile(server, `${JSON.stringify(exported)}\n`);

    expect(await runReconcile({ local, server, out, log: () => {} })).toBe(0);
    expect(JSON.parse(await fs.readFile(out, "utf8")).counts).toEqual({
      matched: 1,
      localOnly: 0,
      serverOnly: 0,
      conflict: 0,
      invalid: 0,
    });
  });

  it("normalizes the nested SpoolRecord shape written by CLI 0.1.5", async () => {
    const raw = legacy("m1", 10);
    const spooled = {
      id: "spool-1",
      sourceId: "claude-local",
      agent: "claude-code",
      evidenceClass: "agent-local",
      cursorNamespace: "claude:transcript:v1",
      capabilities: { supportsCacheTokens: true },
      sessionId: raw.sessionId,
      message: {
        messageId: raw.messageId,
        requestId: raw.requestId,
        ts: raw.ts,
        model: raw.model,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cacheReadTokens,
        cacheCreationTokens: raw.cacheCreationTokens,
      },
    };
    const local = path.join(root, "legacy-spool.jsonl");
    const server = path.join(root, "server.jsonl");
    const out = path.join(root, "ledger.json");
    await fs.writeFile(local, `${JSON.stringify(spooled)}\n`);
    await fs.writeFile(server, "");

    expect(await runReconcile({ local, server, out, log: () => {} })).toBe(0);
    expect(JSON.parse(await fs.readFile(out, "utf8")).counts).toEqual({
      matched: 0,
      localOnly: 1,
      serverOnly: 0,
      conflict: 0,
      invalid: 0,
    });
  });

  it("matches a 0.1.5 Codex spool record to split-reasoning current evidence", async () => {
    const raw = legacy("source-event", 10);
    const spooled = {
      agent: "codex",
      sessionId: raw.sessionId,
      message: { ...raw, sessionId: undefined, outputTokens: 7 },
    };
    const current = {
      schemaVersion: 2,
      agent: "codex",
      surface: "cli",
      source: "transcript",
      sourceVersion: "codex-rollout-token-count-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      supportTier: "preview",
      eventId: raw.messageId,
      sessionId: raw.sessionId,
      occurredAt: raw.ts,
      timeBasis: "provider",
      model: raw.model,
      inputTokens: raw.inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      reasoningTokens: 3,
      toolInputTokens: 0,
      totalTokens: raw.inputTokens + 7,
    };
    const local = path.join(root, "legacy-spool.jsonl");
    const server = path.join(root, "current.jsonl");
    const out = path.join(root, "ledger.json");
    await fs.writeFile(local, `${JSON.stringify(spooled)}\n`);
    await fs.writeFile(server, `${JSON.stringify(current)}\n`);

    expect(await runReconcile({ local, server, out, log: () => {} })).toBe(0);
    expect(JSON.parse(await fs.readFile(out, "utf8")).counts.matched).toBe(1);
  });

  it("collapses equivalent legacy and current aliases without a conflict", async () => {
    const raw = legacy("source-event", 10);
    const spooled = { agent: "codex", sessionId: raw.sessionId, message: raw };
    const current = {
      schemaVersion: 2,
      agent: "codex",
      surface: "cli",
      source: "transcript",
      sourceVersion: "codex-rollout-token-count-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      supportTier: "preview",
      eventId: raw.messageId,
      sessionId: raw.sessionId,
      occurredAt: raw.ts,
      timeBasis: "provider",
      model: raw.model,
      inputTokens: raw.inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: raw.outputTokens,
      reasoningTokens: 0,
      toolInputTokens: 0,
      totalTokens: raw.inputTokens + raw.outputTokens,
    };
    const local = path.join(root, "combined-local.jsonl");
    const server = path.join(root, "server.jsonl");
    const out = path.join(root, "ledger.json");
    await fs.writeFile(local, `${JSON.stringify(spooled)}\n${JSON.stringify(current)}\n`);
    await fs.writeFile(server, "");

    expect(await runReconcile({ local, server, out, log: () => {} })).toBe(0);
    const ledger = JSON.parse(await fs.readFile(out, "utf8"));
    expect(ledger.counts).toEqual({ matched: 0, localOnly: 2, serverOnly: 0, conflict: 0, invalid: 0 });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].local).toHaveLength(2);
  });
});

function legacy(messageId: string, inputTokens: number) {
  return { agent: "claude", sessionId: "session-1", messageId, requestId: `request-${messageId}`,
    ts: "2026-08-03T10:00:00.000Z", model: "claude", inputTokens, outputTokens: 1,
    cacheReadTokens: 0, cacheCreationTokens: 0 };
}
