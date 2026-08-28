import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadState, saveState, sourceCursorKey } from "../../src/core/state.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-state-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.BURNBOOK_CONFIG_DIR;
  } else {
    process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("state", () => {
  it("loadState returns an empty cursor map when no state file exists", async () => {
    const state = await loadState();
    expect(state).toEqual({ cursors: {} });
  });

  it("round-trips cursor state via BURNBOOK_CONFIG_DIR, and the file is mode 0600", async () => {
    const written = { cursors: { "/path/to/session-a.jsonl": 42, "/path/to/session-b.jsonl": 7 } };
    await saveState(written);

    const statePath = path.join(tmpDir, "state.json");
    const stat = await fs.stat(statePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const loaded = await loadState();
    expect(loaded).toEqual(written);
  });

  it("creates the config directory recursively with mode 0700", async () => {
    const nested = path.join(tmpDir, "nested", "config", "dir");
    process.env.BURNBOOK_CONFIG_DIR = nested;

    await saveState({ cursors: {} });

    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("keeps V2 cursors isolated by agent, surface, source, and resource", async () => {
    const claude = sourceCursorKey("claude-code", "cli", "transcript", "/same/resource.jsonl");
    const codex = sourceCursorKey("codex", "cli", "transcript", "/same/resource.jsonl");
    expect(claude).not.toBe(codex);
    await saveState({ cursors: {}, sourceCursors: { [claude]: 10, [codex]: 20 } });
    expect((await loadState()).sourceCursors).toEqual({ [claude]: 10, [codex]: 20 });
  });

  it("round-trips append-only byte cursors", async () => {
    const cursor = {
      version: 1 as const,
      byteOffset: 4096,
      line: 12,
      file: {
        dev: "1",
        ino: "2",
        birthtimeMs: 1234,
        prefixLength: 64,
        prefixSha256: "a".repeat(64),
      },
      context: { sessionId: "session-1" },
    };

    await saveState({ cursors: { "codex:/local/session.jsonl": cursor } });
    expect(await loadState()).toEqual({ cursors: { "codex:/local/session.jsonl": cursor } });
  });

  it("atomically replaces state without leaving partial temporary files", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, cursor) =>
      saveState({ cursors: { "/local/session.jsonl": cursor } }),
    ));

    const raw = await fs.readFile(path.join(tmpDir, "state.json"), "utf8");
    const parsed = JSON.parse(raw) as { cursors: Record<string, number> };
    expect(parsed.cursors["/local/session.jsonl"]).toBeGreaterThanOrEqual(0);
    expect((await fs.readdir(tmpDir)).filter((name) => name.startsWith(".state-"))).toEqual([]);
  });

  it("rejects malformed cursor and file-stamp values", async () => {
    await fs.writeFile(path.join(tmpDir, "state.json"), JSON.stringify({
      cursors: { "/local/session.jsonl": -1 },
      files: { "/local/session.jsonl": { size: 1, mtimeMs: Number.NaN } },
    }));

    expect(await loadState()).toEqual({ cursors: {} });
  });
});
