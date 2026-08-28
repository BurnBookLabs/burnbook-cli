import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateJsonlLineCursor, readJsonlTail } from "../../src/core/jsonl-tail.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryFile(body: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-jsonl-tail-"));
  directories.push(directory);
  const file = path.join(directory, "events.jsonl");
  await fs.writeFile(file, body);
  return file;
}

describe("JSONL byte tail", () => {
  it("commits only newline-terminated records", async () => {
    const file = await temporaryFile("one\ntwo");
    const first = await readJsonlTail(file);
    expect(first.lines.map((line) => line.value)).toEqual(["one"]);
    expect(first.cursor.byteOffset).toBe(4);

    await fs.appendFile(file, "\n");
    const second = await readJsonlTail(file, { cursor: first.cursor });
    expect(second.lines.map((line) => line.value)).toEqual(["two"]);
    expect(second.cursor.line).toBe(2);
  });

  it("reads only appended bytes after a byte cursor", async () => {
    const file = await temporaryFile("one\n");
    const first = await readJsonlTail(file);
    await fs.appendFile(file, "two\n");

    const second = await readJsonlTail(file, { cursor: first.cursor });
    expect(second.lines).toEqual([{ line: 2, value: "two" }]);
    expect(second.bytesRead).toBe(4);
    expect(second.reset).toBe(false);
  });

  it("resets when a resource is truncated and rewritten", async () => {
    const file = await temporaryFile("one\ntwo\n");
    const first = await readJsonlTail(file);
    await fs.writeFile(file, "new\n");

    const second = await readJsonlTail(file, { cursor: first.cursor });
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual([{ line: 1, value: "new" }]);
  });

  it("establishes a rewrite fingerprint after an initially empty file grows", async () => {
    const file = await temporaryFile("");
    const empty = await readJsonlTail(file);
    await fs.appendFile(file, "one\n");
    const first = await readJsonlTail(file, { cursor: empty.cursor });
    expect(first.cursor.file.prefixLength).toBe(4);
    await fs.writeFile(file, "two\n");

    const second = await readJsonlTail(file, { cursor: first.cursor });
    expect(second.reset).toBe(true);
    expect(second.lines.map((line) => line.value)).toEqual(["two"]);
  });

  it("bounds bytes and advances to the last complete record within the budget", async () => {
    const file = await temporaryFile("a\nbbbbb\n");
    const first = await readJsonlTail(file, { maxBytes: 5 });
    expect(first.bytesRead).toBe(5);
    expect(first.lines).toEqual([{ line: 1, value: "a" }]);
    expect(first.cursor.byteOffset).toBe(2);

    const second = await readJsonlTail(file, { cursor: first.cursor, maxBytes: 10 });
    expect(second.lines).toEqual([{ line: 2, value: "bbbbb" }]);
  });

  it("discards an oversized record in bounded chunks and resumes after its newline", async () => {
    const file = await temporaryFile(`${"x".repeat(11)}\nok\n`);
    let tail = await readJsonlTail(file, { maxBytes: 4 });
    expect(tail.lines).toEqual([]);
    expect(tail.cursor.byteOffset).toBe(4);
    expect(tail.cursor.discardingOversize).toBe(true);

    let discarded = 0;
    const values: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      tail = await readJsonlTail(file, { cursor: tail.cursor, maxBytes: 4 });
      discarded += tail.discardedOversizeRecords;
      values.push(...tail.lines.map((line) => line.value));
    }
    expect(discarded).toBe(1);
    expect(values).toEqual(["ok"]);
    expect(tail.cursor.byteOffset).toBe(15);
  });

  it("migrates a legacy line cursor without returning consumed records", async () => {
    const file = await temporaryFile("old-one\nold-two\nnew\n");
    const visited: string[] = [];
    const cursor = await migrateJsonlLineCursor(file, 2, (line) => visited.push(line.value));
    const tail = await readJsonlTail(file, { cursor });

    expect(visited).toEqual(["old-one", "old-two"]);
    expect(tail.lines.map((line) => line.value)).toEqual(["new"]);
    expect(tail.cursor.line).toBe(3);
  });

  it("rejects symlinks for byte reads and legacy cursor migration", async () => {
    const target = await temporaryFile("one\n");
    const link = path.join(path.dirname(target), "linked.jsonl");
    await fs.symlink(target, link);

    await expect(readJsonlTail(link)).rejects.toThrow("regular file");
    await expect(migrateJsonlLineCursor(link, 1, () => undefined)).rejects.toThrow("regular file");
  });

  it("rejects special files before attempting to read them", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-jsonl-special-"));
    directories.push(directory);

    await expect(readJsonlTail(directory)).rejects.toThrow("regular file");
    await expect(migrateJsonlLineCursor(directory, 1, () => undefined)).rejects.toThrow("regular file");
  });
});
