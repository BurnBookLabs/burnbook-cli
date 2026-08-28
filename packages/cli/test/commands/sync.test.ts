import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLegacySync as runSync } from "../../src/commands/sync.js";
import { saveConfig } from "../../src/core/config.js";
import { ensureKeypair } from "../../src/core/keys.js";
import { loadState, saveState } from "../../src/core/state.js";
import { getOriginalDispatcher, setupMockFetch, teardownMockFetch } from "../helpers/mockFetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SESSION_A = path.join(__dirname, "..", "fixtures", "session-a.jsonl");

const DEVICE_ID = "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
const ORIGINAL_API = process.env.BURNBOOK_API;
let tmpConfigDir: string;
let tmpRoot: string;
let mockAgent: ReturnType<typeof setupMockFetch>;
let originalDispatcher: ReturnType<typeof getOriginalDispatcher>;

beforeEach(async () => {
  tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-sync-config-"));
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-sync-root-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpConfigDir;
  process.env.BURNBOOK_API = "https://api.test";

  originalDispatcher = getOriginalDispatcher();
  mockAgent = setupMockFetch();
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.BURNBOOK_CONFIG_DIR;
  } else {
    process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
  if (ORIGINAL_API === undefined) {
    delete process.env.BURNBOOK_API;
  } else {
    process.env.BURNBOOK_API = ORIGINAL_API;
  }
  // Catches the class of mistake where the code under test makes *fewer*
  // requests than a test set up interceptors for — that would otherwise
  // pass silently.
  mockAgent.assertNoPendingInterceptors();
  teardownMockFetch(mockAgent, originalDispatcher);
  await fs.rm(tmpConfigDir, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function putTranscript(fileName: string, contents: string): Promise<string> {
  const projDir = path.join(tmpRoot, "proj-1");
  await fs.mkdir(projDir, { recursive: true });
  const target = path.join(projDir, fileName);
  await fs.writeFile(target, contents, "utf8");
  return target;
}

function assistantLine(sessionId: string, n: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    requestId: `req-${n}`,
    timestamp: "2026-01-15T10:00:00.000Z",
    message: {
      id: `msg-${n}`,
      role: "assistant",
      model: "claude-sonnet-5-20260115",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

/** Same as assistantLine but with a caller-controlled input token count, for exercising the token-budget batching. */
function assistantLineWithTokens(sessionId: string, n: number, inputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    requestId: `req-${n}`,
    timestamp: "2026-01-15T10:00:00.000Z",
    message: {
      id: `msg-${n}`,
      role: "assistant",
      model: "claude-sonnet-5-20260115",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

/** Sum of a decoded sync payload's token counts across all sessions/messages. */
function payloadTokenSum(payload: {
  sessions: { messages: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }[] }[];
}): number {
  let sum = 0;
  for (const session of payload.sessions) {
    for (const m of session.messages) {
      sum += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
    }
  }
  return sum;
}

function cursorLine(cursor: unknown): number {
  if (typeof cursor === "number") return cursor;
  if (cursor && typeof cursor === "object" && "line" in cursor) return Number(cursor.line);
  return 0;
}

describe("sync", () => {
  it("not logged in: non-quiet exits 1 with a message, quiet exits 0 silently", async () => {
    const errors: string[] = [];
    const code = await runSync({ root: tmpRoot, errorLog: (m) => errors.push(m) });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("burn login"))).toBe(true);

    const quietCode = await runSync({ root: tmpRoot, quiet: true, errorLog: () => {} });
    expect(quietCode).toBe(0);
  });

  it("posts a correctly signed envelope and advances the cursor after 200", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const { publicKeyB64 } = await ensureKeypair();
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    let captured: { payloadB64: string; signatureB64: string; keyId: string } | undefined;
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply((opts) => {
        captured = JSON.parse(opts.body as string);
        return { statusCode: 200, data: JSON.stringify({ accepted: 3, duplicates: 0 }) };
      });

    const logs: string[] = [];
    const code = await runSync({ root: tmpRoot, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("synced 3 new messages (0 duplicates)"))).toBe(true);

    expect(captured).toBeDefined();
    const payloadBytes = Buffer.from(captured!.payloadB64, "base64");
    const signatureBytes = Buffer.from(captured!.signatureB64, "base64");
    const publicKeyBytes = Buffer.from(publicKeyB64, "base64");
    const ok = await ed.verifyAsync(signatureBytes, payloadBytes, publicKeyBytes);
    expect(ok).toBe(true);

    const payload = JSON.parse(payloadBytes.toString("utf8"));
    expect(payload.deviceId).toBe(DEVICE_ID);
    expect(payload.agent).toBe("claude-code");
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].sessionId).toBe("sess-a-0001");
    expect(payload.sessions[0].messages).toHaveLength(3);

    const state = await loadState();
    expect(cursorLine(state.cursors[filePath])).toBe(8);
  });

  it("skips unchanged transcripts after a successful sync", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(200, { accepted: 3, duplicates: 0 });

    expect(await runSync({ root: tmpRoot, log: () => {} })).toBe(0);
    expect(await runSync({ root: tmpRoot, log: () => {} })).toBe(0);

    const state = await loadState();
    expect(state.cursors[filePath]).toEqual(expect.objectContaining({
      version: 1,
      line: 8,
      byteOffset: Buffer.byteLength(fixture),
      context: { sessionId: "sess-a-0001" },
      file: expect.objectContaining({
        prefixLength: Buffer.byteLength(fixture),
        prefixSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it("does not advance the cursor on a 500, and exits non-zero when not quiet; --quiet exits 0", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, { error: "internal error" });

    const errors: string[] = [];
    const code = await runSync({ root: tmpRoot, errorLog: (m) => errors.push(m), log: () => {} });
    expect(code).toBe(1);

    const state = await loadState();
    expect(state.cursors[filePath] ?? 0).toBe(0);

    // Second attempt, this time quiet — must exit 0 and stay silent even
    // though the server still 500s (hook safety).
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, { error: "internal error" });

    const logs: string[] = [];
    const quietCode = await runSync({ root: tmpRoot, quiet: true, log: (m) => logs.push(m), errorLog: () => {} });
    expect(quietCode).toBe(0);
    expect(logs).toHaveLength(0);

    const stateAfterQuiet = await loadState();
    expect(stateAfterQuiet.cursors[filePath] ?? 0).toBe(0);
  });

  it("file-shrink guard: a cursor past EOF is reset to 0 and the file is re-parsed", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    // Simulate a stale cursor from before the file was truncated/rewritten.
    await saveState({ cursors: { [filePath]: 999 } });

    let captured: { payloadB64: string } | undefined;
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply((opts) => {
        captured = JSON.parse(opts.body as string);
        return { statusCode: 200, data: JSON.stringify({ accepted: 3, duplicates: 0 }) };
      });

    const code = await runSync({ root: tmpRoot, log: () => {} });
    expect(code).toBe(0);

    expect(captured).toBeDefined();
    const payload = JSON.parse(Buffer.from(captured!.payloadB64, "base64").toString("utf8"));
    expect(payload.sessions[0].messages).toHaveLength(3); // full re-parse from 0, not 0 new tuples

    const state = await loadState();
    expect(cursorLine(state.cursors[filePath])).toBe(8);
  });

  it("splits a >5000-message session across multiple payloads, advancing the cursor only once every payload succeeds", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });

    const sessionId = "sess-big-0001";
    const lineCount = 5200;
    const lines = Array.from({ length: lineCount }, (_, i) => assistantLine(sessionId, i));
    const filePath = await putTranscript("session-big.jsonl", lines.join("\n") + "\n");

    const bodies: unknown[] = [];
    const pool = mockAgent.get("https://api.test");
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply((opts) => {
        bodies.push(JSON.parse(opts.body as string));
        return { statusCode: 200, data: JSON.stringify({ accepted: 5000, duplicates: 0 }) };
      })
      .times(1);
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply((opts) => {
        bodies.push(JSON.parse(opts.body as string));
        return { statusCode: 200, data: JSON.stringify({ accepted: 200, duplicates: 0 }) };
      })
      .times(1);

    const logs: string[] = [];
    const code = await runSync({ root: tmpRoot, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    // Two separate POSTs — the session's tuples were split across payloads,
    // not bundled as two `sessions[]` entries in one call.
    expect(bodies).toHaveLength(2);

    const decoded = bodies.map((b) => {
      const payloadB64 = (b as { payloadB64: string }).payloadB64;
      return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    });
    for (const payload of decoded) {
      expect(payload.sessions).toHaveLength(1);
      expect(payload.sessions[0].sessionId).toBe(sessionId);
      expect(payload.sessions[0].messages.length).toBeLessThanOrEqual(5000);
    }
    const messageCounts = decoded.map((p) => p.sessions[0].messages.length as number);
    expect(messageCounts.sort((a, b) => a - b)).toEqual([200, 5000]);
    expect(messageCounts.reduce((a, b) => a + b, 0)).toBe(lineCount);

    expect(logs.some((l) => l.includes("synced 5200 new messages (0 duplicates)"))).toBe(true);

    const state = await loadState();
    expect(cursorLine(state.cursors[filePath])).toBe(lineCount);
  });

  it("does not advance the cursor if only some of a split session's payloads succeed", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });

    const sessionId = "sess-big-0001";
    const lineCount = 5200;
    const lines = Array.from({ length: lineCount }, (_, i) => assistantLine(sessionId, i));
    const filePath = await putTranscript("session-big.jsonl", lines.join("\n") + "\n");

    const pool = mockAgent.get("https://api.test");
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(200, JSON.stringify({ accepted: 5000, duplicates: 0 }))
      .times(1);
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, JSON.stringify({ error: "internal error" }))
      .times(1);

    const code = await runSync({ root: tmpRoot, log: () => {}, errorLog: () => {} });
    expect(code).toBe(1);

    const state = await loadState();
    expect(state.cursors[filePath] ?? 0).toBe(0);
  });

  it("quiet mode + ApiError 500: exit 0 with no stderr", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, { error: "internal error" });

    const errors: string[] = [];
    const code = await runSync({ root: tmpRoot, quiet: true, errorLog: (m) => errors.push(m), log: () => {} });
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const state = await loadState();
    expect(state.cursors[filePath] ?? 0).toBe(0);
  });

  it("quiet mode + unexpected local error: exit 0 with stderr message", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });
    const fixture = await fs.readFile(FIXTURE_SESSION_A, "utf8");
    const filePath = await putTranscript("session-a.jsonl", fixture);

    // Corrupt key.json to cause a JSON parse error in signPayload -> ensureKeyFile -> loadKeyFile.
    const keyFile = path.join(tmpConfigDir, "key.json");
    await fs.writeFile(keyFile, "{invalid json", "utf8");

    const errors: string[] = [];
    const code = await runSync({ root: tmpRoot, quiet: true, errorLog: (m) => errors.push(m), log: () => {} });
    expect(code).toBe(0);
    expect(errors.some((e) => e.includes("unexpected local error"))).toBe(true);
  });

  const TOKEN_BUDGET = 1_500_000_000;

  it("token-budget batching: 3 small-message but huge-token sessions split across payloads under the budget", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });

    // Three sessions jointly exceed the client-side payload budget.
    const filePaths: string[] = [];
    for (const label of ["a", "b", "c"]) {
      const sessionId = `sess-tok-${label}`;
      const lines = [assistantLineWithTokens(sessionId, 1, 800_000_000)];
      filePaths.push(await putTranscript(`session-tok-${label}.jsonl`, lines.join("\n") + "\n"));
    }

    const bodies: unknown[] = [];
    const pool = mockAgent.get("https://api.test");
    // Up to 3 payloads could be produced; accept any number of POSTs by
    // registering a generous number of interceptors.
    for (let i = 0; i < 3; i++) {
      pool
        .intercept({ path: "/api/v1/sync", method: "POST" })
        .reply((opts) => {
          bodies.push(JSON.parse(opts.body as string));
          return { statusCode: 200, data: JSON.stringify({ accepted: 1, duplicates: 0 }) };
        })
        .times(1);
    }

    const logs: string[] = [];
    const code = await runSync({ root: tmpRoot, log: (m) => logs.push(m) });
    expect(code).toBe(0);

    expect(bodies.length).toBeGreaterThanOrEqual(2);

    const decoded = bodies.map((b) => {
      const payloadB64 = (b as { payloadB64: string }).payloadB64;
      return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    });
    for (const payload of decoded) {
      expect(payloadTokenSum(payload)).toBeLessThanOrEqual(TOKEN_BUDGET);
    }
    // Every session made it into exactly one payload, none dropped.
    const allSessionIds = decoded.flatMap((p) => p.sessions.map((s: { sessionId: string }) => s.sessionId));
    expect(allSessionIds.sort()).toEqual(["sess-tok-a", "sess-tok-b", "sess-tok-c"]);

    const state = await loadState();
    for (const filePath of filePaths) {
      expect(cursorLine(state.cursors[filePath])).toBeGreaterThan(0);
    }
  });

  it("single session whose tuples alone exceed the token budget is split into multiple chunks/payloads; cursor advances only once all succeed", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });

    const sessionId = "sess-tok-big";
    // 8 tuples at 200M tokens each = 1.6B total, over the 1.5B budget, but
    // only 8 messages — nowhere near the 5000-message cap. Token-budget
    // chunking must split this into >=2 chunks/payloads on its own.
    const lineCount = 8;
    const lines = Array.from({ length: lineCount }, (_, i) => assistantLineWithTokens(sessionId, i, 200_000_000));
    const filePath = await putTranscript("session-tok-big.jsonl", lines.join("\n") + "\n");

    const bodies: unknown[] = [];
    const pool = mockAgent.get("https://api.test");
    for (let i = 0; i < 2; i++) {
      pool
        .intercept({ path: "/api/v1/sync", method: "POST" })
        .reply((opts) => {
          const envelope = JSON.parse(opts.body as string) as { payloadB64: string };
          bodies.push(envelope);
          const payload = JSON.parse(Buffer.from(envelope.payloadB64, "base64").toString("utf8"));
          const accepted = payload.sessions.reduce(
            (sum: number, session: { messages: unknown[] }) => sum + session.messages.length,
            0,
          );
          return { statusCode: 200, data: JSON.stringify({ accepted, duplicates: 0 }) };
        })
        .times(1);
    }

    const code = await runSync({ root: tmpRoot, log: () => {} });
    expect(code).toBe(0);
    expect(bodies.length).toBeGreaterThanOrEqual(2);

    const decoded = bodies.map((b) => {
      const payloadB64 = (b as { payloadB64: string }).payloadB64;
      return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    });
    let totalMessages = 0;
    for (const payload of decoded) {
      expect(payload.sessions).toHaveLength(1);
      expect(payload.sessions[0].sessionId).toBe(sessionId);
      expect(payloadTokenSum(payload)).toBeLessThanOrEqual(TOKEN_BUDGET);
      totalMessages += payload.sessions[0].messages.length;
    }
    expect(totalMessages).toBe(lineCount);

    const state = await loadState();
    expect(cursorLine(state.cursors[filePath])).toBe(lineCount);
  });

  it("partial failure across token-budget-split payloads: summary reports the failure count, exit 1, failed file's cursor untouched", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: DEVICE_ID });

    // Two files, each single-session with 900M tokens — together they
    // exceed the 1.5B budget, forcing them into separate payloads even
    // though both are well under the 200-session cap.
    const fileAPath = await putTranscript(
      "session-tok-fail-a.jsonl",
      [assistantLineWithTokens("sess-tok-fail-a", 1, 900_000_000)].join("\n") + "\n",
    );
    const fileBPath = await putTranscript(
      "session-tok-fail-b.jsonl",
      [assistantLineWithTokens("sess-tok-fail-b", 1, 900_000_000)].join("\n") + "\n",
    );

    const pool = mockAgent.get("https://api.test");
    // discoverTranscripts sorts paths, so fail-a's payload is sent first.
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(200, JSON.stringify({ accepted: 1, duplicates: 0 }))
      .times(1);
    pool
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, JSON.stringify({ error: "internal error" }))
      .times(1);

    const logs: string[] = [];
    const code = await runSync({ root: tmpRoot, log: (m) => logs.push(m), errorLog: () => {} });
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("1 payload(s) failed"))).toBe(true);

    const state = await loadState();
    expect(cursorLine(state.cursors[fileAPath])).toBeGreaterThan(0);
    expect(state.cursors[fileBPath] ?? 0).toBe(0);
  });
});
