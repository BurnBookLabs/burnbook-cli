import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCollect } from "../../src/commands/collect.js";
import { readPendingEvidence } from "../../src/core/spool.js";
import { loadState, saveState, sourceCursorKey } from "../../src/core/state.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let configDirectory: string;
let transcriptRoot: string;

function cursorLine(cursor: unknown): number | undefined {
  if (typeof cursor === "number") return cursor;
  if (cursor && typeof cursor === "object" && "line" in cursor) {
    return typeof cursor.line === "number" ? cursor.line : undefined;
  }
  return undefined;
}

beforeEach(async () => {
  configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-collect-config-"));
  transcriptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-collect-source-"));
  process.env.BURNBOOK_CONFIG_DIR = configDirectory;
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BURNBOOK_CONFIG_DIR;
  else process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  await fs.rm(configDirectory, { recursive: true, force: true });
  await fs.rm(transcriptRoot, { recursive: true, force: true });
});

describe("burn collect", () => {
  it("collects Claude evidence locally without requiring login or network", async () => {
    const project = path.join(transcriptRoot, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "session.jsonl"), `${JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      requestId: "request-1",
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: "message-1",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    })}\n`);

    const logs: string[] = [];
    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, log: (message) => logs.push(message) })).toBe(0);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).toBe("v1-5927e99824d114a4718f311ead6a5bd0");
    expect(logs).toContain("collected 1 claude-code event(s)");

    await runCollect({ agent: "claude-code", root: transcriptRoot, log: (message) => logs.push(message) });
    expect((await readPendingEvidence()).evidence).toHaveLength(1);
    expect(logs).toContain("collected 0 claude-code event(s)");
  });

  it("initializes Claude V2 collection from the legacy V1 file cursor", async () => {
    const project = path.join(transcriptRoot, "project");
    await fs.mkdir(project);
    const transcript = path.join(project, "session.jsonl");
    const line = (suffix: string) => JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      requestId: `request-${suffix}`,
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: `message-${suffix}`,
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    await fs.writeFile(transcript, `${line("old")}\n${line("new")}\n`);
    await saveState({ cursors: { [transcript]: 1 } });

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, log: () => {} })).toBe(0);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).toBe("v1-48cbe0ff1aafcb7f772ac2b7d1427f9b");
  });

  it("normalizes a Claude model label without dropping the usage event", async () => {
    const project = path.join(transcriptRoot, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "session.jsonl"), `${JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      requestId: "request-1",
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: "message-1",
        model: "/claude beta (preview)",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`);

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    expect((await readPendingEvidence()).evidence[0].model).toBe("claude-beta--preview-");
  });

  it("initializes Codex collection from the 0.1.5 agent-prefixed cursor", async () => {
    const codexRoot = path.join(transcriptRoot, "codex-home");
    await fs.mkdir(path.join(codexRoot, "sessions"), { recursive: true });
    const rollout = path.join(codexRoot, "sessions", "rollout.jsonl");
    const rows = [
      { type: "session_meta", payload: { id: "codex-session" } },
      { type: "turn_context", payload: { turn_id: "codex-turn", model: "gpt-5.6-codex" } },
      codexTokenCount("2026-08-03T10:00:00.000Z", 15, 5),
      codexTokenCount("2026-08-03T10:01:00.000Z", 25, 8),
    ];
    await fs.writeFile(rollout, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await saveState({ cursors: { [`codex:${rollout}`]: 3 } });

    expect(await runCollect({ agent: "codex", root: codexRoot, quiet: true })).toBe(0);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      agent: "codex",
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    });
  });

  it("bounds one run and drains a large history across resumable passes", async () => {
    const project = path.join(transcriptRoot, "project");
    await fs.mkdir(project);
    const transcript = path.join(project, "large-session.jsonl");
    const lines = Array.from({ length: 501 }, (_, index) => JSON.stringify({
      type: "assistant",
      sessionId: "large-session",
      requestId: `request-${index}`,
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: `message-${index}`,
        model: "claude-sonnet-5",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));
    await fs.writeFile(transcript, `${lines.join("\n")}\n`);
    const key = sourceCursorKey("claude-code", "cli", "transcript", transcript);

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    expect((await readPendingEvidence()).evidence).toHaveLength(500);
    expect(cursorLine((await loadState()).sourceCursors?.[key])).toBe(500);

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending).toHaveLength(501);
    expect(new Set(pending.map((record) => record.eventId)).size).toBe(501);
    expect(cursorLine((await loadState()).sourceCursors?.[key])).toBe(501);
  });

  it("bounds sparse source scanning without skipping later evidence", async () => {
    const project = path.join(transcriptRoot, "project");
    await fs.mkdir(project);
    const transcript = path.join(project, "sparse-session.jsonl");
    const evidenceLine = JSON.stringify({
      type: "assistant",
      sessionId: "sparse-session",
      requestId: "request-final",
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: "message-final",
        model: "claude-sonnet-5",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    await fs.writeFile(transcript, `${"{}\n".repeat(10_000)}${evidenceLine}\n`);
    const key = sourceCursorKey("claude-code", "cli", "transcript", transcript);

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    expect((await readPendingEvidence()).evidence).toEqual([]);
    expect(cursorLine((await loadState()).sourceCursors?.[key])).toBe(10_000);

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    expect((await readPendingEvidence()).evidence).toHaveLength(1);
    expect(cursorLine((await loadState()).sourceCursors?.[key])).toBe(10_001);
  });

  it("keeps Claude supported and Codex preview evidence distinct in the V2 spool", async () => {
    const claudeProject = path.join(transcriptRoot, "claude-project");
    await fs.mkdir(claudeProject);
    await fs.writeFile(path.join(claudeProject, "session.jsonl"), `${JSON.stringify({
      type: "assistant",
      sessionId: "claude-session",
      requestId: "claude-request",
      timestamp: "2026-07-31T12:00:00.000Z",
      message: {
        id: "claude-message",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`);

    const codexRoot = path.join(transcriptRoot, "codex-home");
    await fs.mkdir(path.join(codexRoot, "sessions"), { recursive: true });
    await fs.writeFile(path.join(codexRoot, "sessions", "rollout.jsonl"), [
      { type: "session_meta", payload: { id: "codex-session" } },
      { type: "turn_context", payload: { turn_id: "codex-turn", model: "gpt-5.6-codex" } },
      {
        type: "event_msg",
        timestamp: "2026-07-31T12:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
              total_tokens: 15,
            },
          },
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    expect(await runCollect({ agent: "claude-code", root: transcriptRoot, quiet: true })).toBe(0);
    expect(await runCollect({ agent: "codex", root: codexRoot, quiet: true })).toBe(0);
    const pending = (await readPendingEvidence()).evidence;
    expect(pending.map((record) => ({
      agent: record.agent,
      supportTier: record.supportTier,
      evidenceClass: record.evidenceClass,
    }))).toEqual([
      { agent: "claude-code", supportTier: "supported", evidenceClass: "agent-local" },
      { agent: "codex", supportTier: "preview", evidenceClass: "agent-local" },
    ]);
  });
});

function codexTokenCount(timestamp: string, inputTokens: number, outputTokens: number) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens,
        },
      },
    },
  };
}
