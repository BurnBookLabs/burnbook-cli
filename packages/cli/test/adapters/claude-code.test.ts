import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverTranscripts, parseTranscript } from "../../src/adapters/claude-code.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");
const SESSION_A = path.join(FIXTURES, "session-a.jsonl");
const MALFORMED = path.join(FIXTURES, "malformed.jsonl");
const TRUNCATED_TAIL = path.join(FIXTURES, "truncated-tail.jsonl");

describe("parseTranscript", () => {
  it("extracts the exact number of usage tuples from the golden fixture", async () => {
    const result = await parseTranscript(SESSION_A, 0);
    expect(result.tuples).toHaveLength(3);
    expect(result.sessionId).toBe("sess-a-0001");
    expect(result.lastLine).toBe(8);
  });

  it("skips non-assistant lines (user/attachment/queue-operation)", async () => {
    const result = await parseTranscript(SESSION_A, 0);
    const messageIds = result.tuples.map((t) => t.messageId).sort();
    expect(messageIds).toEqual(["msg_a1", "msg_a2", "msg_a4"]);
  });

  it("skips assistant lines without message.usage", async () => {
    const result = await parseTranscript(SESSION_A, 0);
    expect(result.tuples.find((t) => t.messageId === "msg_a3")).toBeUndefined();
  });

  it("dedups duplicate (message.id, requestId) pairs, keeping the first", async () => {
    const result = await parseTranscript(SESSION_A, 0);
    const dupes = result.tuples.filter((t) => t.messageId === "msg_a1" && t.requestId === "req_a1");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].inputTokens).toBe(100);
    expect(dupes[0].outputTokens).toBe(50);
  });

  it("skips malformed JSON lines without throwing", async () => {
    await expect(parseTranscript(MALFORMED, 0)).resolves.toBeDefined();
    const result = await parseTranscript(MALFORMED, 0);
    expect(result.tuples).toHaveLength(2);
    expect(result.lastLine).toBe(3);
    expect(result.tuples.map((t) => t.messageId).sort()).toEqual(["msg_b1", "msg_b2"]);
  });

  it("re-parsing from lastLine yields 0 new tuples", async () => {
    const first = await parseTranscript(SESSION_A, 0);
    const second = await parseTranscript(SESSION_A, first.lastLine);
    expect(second.tuples).toHaveLength(0);
    expect(second.lastLine).toBe(first.lastLine);
  });

  it("only advances lastLine to the number of lines actually consumed", async () => {
    const partial = await parseTranscript(SESSION_A, 4);
    // Lines 5-8 consumed: queue-operation, msg_a2 (usage), msg_a3 (no usage), msg_a4 (usage)
    expect(partial.lastLine).toBe(8);
    expect(partial.tuples.map((t) => t.messageId).sort()).toEqual(["msg_a2", "msg_a4"]);
  });

  it("returns a resumable cursor when an evidence limit stops the stream", async () => {
    const first = await parseTranscript(SESSION_A, 0, { maxTuples: 1, maxLines: 100 });
    const second = await parseTranscript(SESSION_A, first.lastLine, { maxTuples: 10, maxLines: 100 });

    expect(first.tuples).toHaveLength(1);
    expect(first.lastLine).toBe(2);
    expect(second.lastLine).toBe(8);
    expect(second.tuples.map((tuple) => tuple.messageId)).toEqual(["msg_a1", "msg_a2", "msg_a4"]);
  });

  it("advances only through the bounded number of new source lines", async () => {
    const first = await parseTranscript(SESSION_A, 0, { maxTuples: 100, maxLines: 4 });
    const second = await parseTranscript(SESSION_A, first.lastLine, { maxTuples: 100, maxLines: 4 });

    expect(first.lastLine).toBe(4);
    expect(second.lastLine).toBe(8);
    expect([...first.tuples, ...second.tuples].map((tuple) => tuple.messageId)).toEqual([
      "msg_a1",
      "msg_a2",
      "msg_a4",
    ]);
  });

  it("does not consume a malformed line that is the last line of the file (truncated tail)", async () => {
    const result = await parseTranscript(TRUNCATED_TAIL, 0);
    expect(result.tuples).toHaveLength(2);
    expect(result.tuples.map((t) => t.messageId).sort()).toEqual(["msg_c1", "msg_c2"]);
    // The truncated 3rd line must NOT be counted as consumed, so a resumed
    // parse re-reads it once the writer finishes appending to it.
    expect(result.lastLine).toBe(2);
  });

  it("re-reads a truncated tail line once the append that completed it lands on disk", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-truncated-"));
    try {
      const tmpFile = path.join(tmp, "session.jsonl");
      const line1 =
        '{"type":"assistant","sessionId":"sess-c-0001","requestId":"req_c1","timestamp":"2026-01-15T12:00:00.000Z","message":{"id":"msg_c1","role":"assistant","model":"claude-sonnet-5-20260115","content":[{"type":"text","text":"REDACTED"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';
      const line2 =
        '{"type":"assistant","sessionId":"sess-c-0001","requestId":"req_c2","timestamp":"2026-01-15T12:00:01.000Z","message":{"id":"msg_c2","role":"assistant","model":"claude-sonnet-5-20260115","content":[{"type":"text","text":"REDACTED"}],"usage":{"input_tokens":20,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';
      const truncatedLine3 = '{"type":"assistant","sessionId":"sess-c-0001","requestId":"req_c3","messa';
      const completedLine3 =
        '{"type":"assistant","sessionId":"sess-c-0001","requestId":"req_c3","timestamp":"2026-01-15T12:00:02.000Z","message":{"id":"msg_c3","role":"assistant","model":"claude-sonnet-5-20260115","content":[{"type":"text","text":"REDACTED"}],"usage":{"input_tokens":30,"output_tokens":15,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';

      // Simulate the writer having only flushed a partial (truncated) 3rd line.
      await fs.writeFile(tmpFile, [line1, line2, truncatedLine3].join("\n"));

      const first = await parseTranscript(tmpFile, 0);
      expect(first.tuples).toHaveLength(2);
      expect(first.lastLine).toBe(2);

      // Simulate the writer completing the append: the 3rd line is now full
      // JSON, followed by a trailing newline.
      await fs.writeFile(tmpFile, [line1, line2, completedLine3].join("\n") + "\n");

      const second = await parseTranscript(tmpFile, first.lastLine);
      expect(second.tuples).toHaveLength(1);
      expect(second.tuples[0].messageId).toBe("msg_c3");
      expect(second.lastLine).toBe(3);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads only new records while preserving session context with a byte cursor", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-byte-cursor-"));
    try {
      const file = path.join(tmp, "session.jsonl");
      const line = (id: string) => JSON.stringify({
        type: "assistant",
        sessionId: "stable-session",
        requestId: `request-${id}`,
        timestamp: "2026-01-15T12:00:00.000Z",
        message: {
          id: `message-${id}`,
          model: "claude-sonnet-5",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      await fs.writeFile(file, `${line("one")}\n`);
      const first = await parseTranscript(file);
      await fs.appendFile(file, `${line("two")}\n`);

      const second = await parseTranscript(file, first.byteCursor);
      expect(second.sessionId).toBe("stable-session");
      expect(second.tuples.map((tuple) => tuple.messageId)).toEqual(["message-two"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("discoverTranscripts", () => {
  it("finds *.jsonl files one level under the given root", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-discover-"));
    try {
      const proj1 = path.join(tmp, "proj-1");
      const proj2 = path.join(tmp, "proj-2");
      await fs.mkdir(proj1, { recursive: true });
      await fs.mkdir(proj2, { recursive: true });
      await fs.writeFile(path.join(proj1, "session-1.jsonl"), "");
      await fs.writeFile(path.join(proj2, "session-2.jsonl"), "");
      await fs.writeFile(path.join(proj2, "notes.txt"), "");

      const found = await discoverTranscripts(tmp);
      expect(found).toHaveLength(2);
      expect(found.some((f) => f.endsWith("session-1.jsonl"))).toBe(true);
      expect(found.some((f) => f.endsWith("session-2.jsonl"))).toBe(true);
      expect(found.some((f) => f.endsWith("notes.txt"))).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the root does not exist", async () => {
    const missing = path.join(os.tmpdir(), `burnbook-does-not-exist-${Date.now()}`);
    const found = await discoverTranscripts(missing);
    expect(found).toEqual([]);
  });

  it("excludes symlinks and non-regular entries with jsonl names", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-discover-safe-"));
    try {
      const project = path.join(tmp, "project");
      const target = path.join(project, "target.txt");
      await fs.mkdir(project);
      await fs.writeFile(target, "not a transcript");
      await fs.symlink(target, path.join(project, "linked.jsonl"));
      await fs.mkdir(path.join(project, "directory.jsonl"));
      await fs.writeFile(path.join(project, "real.jsonl"), "");
      if (process.platform !== "win32") {
        const fifo = path.join(project, "pipe.jsonl");
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      }

      expect(await discoverTranscripts(tmp)).toEqual([path.join(project, "real.jsonl")]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
