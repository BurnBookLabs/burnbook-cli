import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRollouts, parseCodexRollout } from "../../src/collectors/codex.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function rollout(lines: unknown[], tail = "\n"): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-codex-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "rollout.jsonl");
  await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}${tail}`, "utf8");
  return filePath;
}

function session() {
  return {
    timestamp: "2026-07-31T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "019abcde-1234-7000-8000-000000000001", cli_version: "0.144.6" },
  };
}

function context() {
  return {
    timestamp: "2026-07-31T12:00:01.000Z",
    type: "turn_context",
    payload: { turn_id: "turn-1", model: "gpt-5.6-codex" },
  };
}

function tokenCount(timestamp: string, input: number, cached: number, output: number, reasoning: number) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
      },
    },
  };
}

describe("Codex rollout collector", () => {
  it("normalizes cumulative authoritative counters into disjoint V2 event deltas", async () => {
    const filePath = await rollout([
      session(),
      context(),
      tokenCount("2026-07-31T12:00:02.000Z", 100, 40, 30, 10),
      tokenCount("2026-07-31T12:00:03.000Z", 180, 70, 50, 15),
    ]);

    const result = await parseCodexRollout(filePath);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({
      schemaVersion: 2,
      agent: "codex",
      evidenceClass: "agent-local",
      supportTier: "preview",
      inputTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 130,
    });
    expect(result.evidence[1]).toMatchObject({
      inputTokens: 50,
      cacheReadTokens: 30,
      outputTokens: 15,
      reasoningTokens: 5,
      totalTokens: 100,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps identity and cumulative context across byte-cursor appends", async () => {
    const filePath = await rollout([
      session(),
      context(),
      tokenCount("2026-07-31T12:00:02.000Z", 100, 70, 20, 0),
    ], "\n");
    const first = await parseCodexRollout(filePath);
    await fs.appendFile(
      filePath,
      `${JSON.stringify(tokenCount("2026-07-31T12:00:03.000Z", 140, 80, 30, 0))}\n`,
    );

    const second = await parseCodexRollout(filePath, first.byteCursor);
    expect(second.evidence).toHaveLength(1);
    expect(second.evidence[0]).toMatchObject({
      sessionId: "019abcde-1234-7000-8000-000000000001",
      model: "gpt-5.6-codex",
      inputTokens: 30,
      cacheReadTokens: 10,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 50,
    });
  });

  it("reconstructs cumulative context when migrating a line cursor", async () => {
    const filePath = await rollout([
      session(),
      context(),
      tokenCount("2026-07-31T12:00:02.000Z", 100, 40, 30, 10),
      tokenCount("2026-07-31T12:00:03.000Z", 180, 70, 50, 15),
    ]);
    const result = await parseCodexRollout(filePath, 3);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      inputTokens: 50,
      cacheReadTokens: 30,
      outputTokens: 15,
      reasoningTokens: 5,
      totalTokens: 100,
    });
  });

  it("resumes correctly after an evidence-bounded collection pass", async () => {
    const filePath = await rollout([
      session(),
      context(),
      tokenCount("2026-07-31T12:00:02.000Z", 100, 40, 30, 10),
      tokenCount("2026-07-31T12:00:03.000Z", 180, 70, 50, 15),
    ]);

    const first = await parseCodexRollout(filePath, 0, { maxEvidence: 1, maxLines: 100 });
    const second = await parseCodexRollout(
      filePath,
      first.byteCursor,
      { maxEvidence: 1, maxLines: 100 },
    );

    expect(first.evidence).toHaveLength(1);
    expect(first.lastLine).toBe(3);
    expect(second.evidence).toHaveLength(1);
    expect(second.lastLine).toBe(4);
    expect(second.evidence[0]).toMatchObject({
      inputTokens: 50,
      cacheReadTokens: 30,
      outputTokens: 15,
      reasoningTokens: 5,
      totalTokens: 100,
    });
  });

  it("does not consume an incomplete tail before it becomes valid JSON", async () => {
    const complete = JSON.stringify(tokenCount("2026-07-31T12:00:02.000Z", 100, 40, 30, 10));
    const filePath = await rollout([session(), context()], `\n${complete.slice(0, 40)}`);
    const first = await parseCodexRollout(filePath);
    expect(first.evidence).toEqual([]);

    await fs.appendFile(filePath, `${complete.slice(40)}\n`);
    const second = await parseCodexRollout(filePath, first.byteCursor);
    expect(second.evidence).toHaveLength(1);
    expect(second.evidence[0]).toMatchObject({
      sessionId: "019abcde-1234-7000-8000-000000000001",
      model: "gpt-5.6-codex",
      totalTokens: 130,
    });
  });

  it("skips unchanged cumulative counters and starts a new epoch after a reset", async () => {
    const first = tokenCount("2026-07-31T12:00:02.000Z", 100, 20, 20, 5);
    const filePath = await rollout([
      session(),
      first,
      { ...first, timestamp: "2026-07-31T12:00:03.000Z" },
      tokenCount("2026-07-31T12:00:04.000Z", 10, 2, 4, 1),
    ]);

    const result = await parseCodexRollout(filePath);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.map((event) => event.totalTokens)).toEqual([120, 14]);
    expect(new Set(result.evidence.map((event) => event.eventId)).size).toBe(2);
  });

  it("fails closed when counters cannot reconcile", async () => {
    const invalid = tokenCount("2026-07-31T12:00:02.000Z", 10, 2, 4, 1);
    invalid.payload.info.total_token_usage.total_tokens = 99;
    const filePath = await rollout([session(), invalid]);

    const result = await parseCodexRollout(filePath);
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics).toEqual([
      "Ignored a Codex token_count record whose counters do not reconcile.",
    ]);
  });

  it("rejects negative optional counters and unproven cache-write usage", async () => {
    const negative = tokenCount("2026-07-31T12:00:02.000Z", 10, 2, 4, 1);
    negative.payload.info.total_token_usage.cached_input_tokens = -1;
    const cacheWrite = tokenCount("2026-07-31T12:00:03.000Z", 10, 2, 4, 1);
    Object.assign(cacheWrite.payload.info.total_token_usage, { cache_write_input_tokens: 1 });
    const filePath = await rollout([session(), negative, cacheWrite]);

    const result = await parseCodexRollout(filePath);
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("never copies content-bearing source fields into evidence or diagnostics", async () => {
    const source = tokenCount("2026-07-31T12:00:02.000Z", 10, 2, 4, 1) as Record<string, unknown>;
    source.prompt = "PRIVATE_PROMPT_SENTINEL";
    source.response = "PRIVATE_RESPONSE_SENTINEL";
    source.tool_payload = { secret: "PRIVATE_TOOL_SENTINEL" };
    source.cwd = "/private/company/repository";
    const filePath = await rollout([session(), context(), source]);

    const result = await parseCodexRollout(filePath);
    const serialized = JSON.stringify(result);
    expect(result.evidence).toHaveLength(1);
    for (const sentinel of [
      "PRIVATE_PROMPT_SENTINEL",
      "PRIVATE_RESPONSE_SENTINEL",
      "PRIVATE_TOOL_SENTINEL",
      "/private/company/repository",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("discovers active and archived rollouts recursively", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-codex-home-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "sessions", "2026", "07"), { recursive: true });
    await fs.mkdir(path.join(root, "archived_sessions"), { recursive: true });
    await fs.writeFile(path.join(root, "sessions", "2026", "07", "active.jsonl"), "");
    await fs.writeFile(path.join(root, "archived_sessions", "archived.jsonl"), "");
    await fs.writeFile(path.join(root, "sessions", "ignored.txt"), "");

    const files = await discoverRollouts(root);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".jsonl"))).toBe(true);
  });
});
