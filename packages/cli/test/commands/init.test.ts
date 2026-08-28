import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit as runInitBase } from "../../src/commands/init.js";

const ORIGINAL_CLAUDE_DIR = process.env.BURNBOOK_CLAUDE_DIR;
let tmpDir: string;
let settingsPath: string;
let backupPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-init-"));
  process.env.BURNBOOK_CLAUDE_DIR = tmpDir;
  settingsPath = path.join(tmpDir, "settings.json");
  backupPath = `${settingsPath}.bak`;
});

afterEach(async () => {
  if (ORIGINAL_CLAUDE_DIR === undefined) {
    delete process.env.BURNBOOK_CLAUDE_DIR;
  } else {
    process.env.BURNBOOK_CLAUDE_DIR = ORIGINAL_CLAUDE_DIR;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const OUR_COMMAND = "'/trusted/node' '/trusted/burnbook' hook";
const LEGACY_COMMANDS = [
  "burn sync --quiet",
  "burn collect --agent claude-code --quiet",
] as const;

function ourGroup() {
  return { hooks: [{ type: "command", command: OUR_COMMAND }] };
}

function runInit(options: Parameters<typeof runInitBase>[0] = {}) {
  return runInitBase({ ...options, hookCommand: OUR_COMMAND });
}

const OTHER_HOOKS_FIXTURE = {
  model: "claude-opus",
  permissions: { allow: ["Bash(git *)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "other-tool foo" }] }],
  },
};

async function readSettings(): Promise<unknown> {
  return JSON.parse(await fs.readFile(settingsPath, "utf8"));
}

describe("burn init", () => {
  it("pins hooks to absolute runtimes instead of resolving burn through PATH", async () => {
    expect(await runInitBase({ log: () => {} })).toBe(0);
    const settings = await readSettings() as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.Stop[0].hooks[0].command;
    expect(command).toContain(await fs.realpath(process.execPath));
    expect(command).toContain(await fs.realpath(process.argv[1]));
    expect(command).not.toBe("burn hook");
  });

  it("creates settings.json with exactly our hooks when the file is missing", async () => {
    const logs: string[] = [];
    const code = await runInit({ log: (m) => logs.push(m) });

    expect(code).toBe(0);
    const settings = await readSettings();
    expect(settings).toEqual({
      hooks: {
        Stop: [ourGroup()],
        SessionEnd: [ourGroup()],
      },
    });
    expect(logs.some((m) => m.includes("installed Stop + SessionEnd hooks"))).toBe(true);
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);

    // No backup should exist for a file that didn't exist before.
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("does not broaden restrictive settings or backup permissions", async () => {
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), { mode: 0o600 });
    await fs.chmod(settingsPath, 0o600);

    expect(await runInit({})).toBe(0);

    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("tightens settings and backups to owner-only permissions", async () => {
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), { mode: 0o640 });
    await fs.chmod(settingsPath, 0o640);
    await fs.writeFile(backupPath, "old backup", { mode: 0o600 });
    await fs.chmod(backupPath, 0o600);

    expect(await runInit({})).toBe(0);

    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("appends to an existing file with other hooks, leaving other keys and hooks untouched", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), "utf8");

    const code = await runInit({});
    expect(code).toBe(0);

    const settings = await readSettings();
    expect(settings).toEqual({
      model: "claude-opus",
      permissions: { allow: ["Bash(git *)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool foo" }] }, ourGroup()],
        SessionEnd: [ourGroup()],
      },
    });

    // Backup should hold exactly the pre-modify content.
    const backupContent = await fs.readFile(backupPath, "utf8");
    expect(JSON.parse(backupContent)).toEqual(OTHER_HOOKS_FIXTURE);
  });

  it("is idempotent: a second init leaves the file byte-identical", async () => {
    await runInit({});
    const firstBytes = await fs.readFile(settingsPath, "utf8");

    const logs: string[] = [];
    const code = await runInit({ log: (m) => logs.push(m) });
    expect(code).toBe(0);

    const secondBytes = await fs.readFile(settingsPath, "utf8");
    expect(secondBytes).toBe(firstBytes);
    expect(logs.some((m) => m.includes("already installed"))).toBe(true);
  });

  it.each(LEGACY_COMMANDS)("migrates legacy hook %s to the background dispatcher", async (command) => {
    const legacy = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command }] }],
        SessionEnd: [{ hooks: [{ type: "command", command }] }],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(legacy, null, 2), "utf8");

    expect(await runInit({})).toBe(0);
    expect(await readSettings()).toEqual({
      hooks: { Stop: [ourGroup()], SessionEnd: [ourGroup()] },
    });
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("is idempotent against the other-hooks fixture: second init doesn't duplicate our group", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), "utf8");

    await runInit({});
    const firstBytes = await fs.readFile(settingsPath, "utf8");

    const logs: string[] = [];
    const code = await runInit({ log: (m) => logs.push(m) });
    expect(code).toBe(0);

    const secondBytes = await fs.readFile(settingsPath, "utf8");
    expect(secondBytes).toBe(firstBytes);
    expect(logs.some((m) => m.includes("already installed"))).toBe(true);

    const settings = (await readSettings()) as { hooks: { Stop: unknown[] } };
    expect(settings.hooks.Stop.length).toBe(2);
  });

  it("tightens a pre-existing permissive backup before writing settings bytes", async () => {
    const original = JSON.stringify({ hooks: { Stop: [] } }, null, 2);
    await fs.writeFile(settingsPath, original, { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(backupPath, "old", { encoding: "utf8", mode: 0o644 });
    await fs.chmod(backupPath, 0o644);

    expect(await runInit({})).toBe(0);
    expect(await fs.readFile(backupPath, "utf8")).toBe(original);
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("replaces a backup symlink without modifying its target", async () => {
    const original = JSON.stringify({ hooks: { Stop: [] } }, null, 2);
    const sentinel = path.join(tmpDir, "sentinel");
    await fs.writeFile(settingsPath, original, "utf8");
    await fs.writeFile(sentinel, "do-not-touch", "utf8");
    await fs.symlink(sentinel, backupPath);

    expect(await runInit({})).toBe(0);
    expect(await fs.readFile(sentinel, "utf8")).toBe("do-not-touch");
    expect((await fs.lstat(backupPath)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(backupPath, "utf8")).toBe(original);
  });
  it("aborts when an existing \"hooks\" key isn't an object, without writing a .bak or touching the file", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const malformed = JSON.stringify({ model: "x", hooks: "nope" }, null, 2);
    await fs.writeFile(settingsPath, malformed, "utf8");

    const errors: string[] = [];
    const code = await runInit({ errorLog: (m) => errors.push(m) });

    expect(code).not.toBe(0);
    expect(errors.length).toBeGreaterThan(0);

    const content = await fs.readFile(settingsPath, "utf8");
    expect(content).toBe(malformed);
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("aborts when an event hook is not an array, without writing a .bak or touching the file", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const malformed = JSON.stringify({ model: "x", hooks: { Stop: "not-an-array" } }, null, 2);
    await fs.writeFile(settingsPath, malformed, "utf8");

    const errors: string[] = [];
    const code = await runInit({ errorLog: (m) => errors.push(m) });

    expect(code).not.toBe(0);
    expect(errors.length).toBeGreaterThan(0);

    const content = await fs.readFile(settingsPath, "utf8");
    expect(content).toBe(malformed);
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("aborts on corrupt JSON without writing a .bak or touching the file", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, "{ not valid json", "utf8");

    const errors: string[] = [];
    const code = await runInit({ errorLog: (m) => errors.push(m) });

    expect(code).not.toBe(0);
    expect(errors.length).toBeGreaterThan(0);

    const content = await fs.readFile(settingsPath, "utf8");
    expect(content).toBe("{ not valid json");
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("--remove reverses install exactly, restoring the original fixture", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), "utf8");

    await runInit({});
    const logs: string[] = [];
    const code = await runInit({ remove: true, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    const settings = await readSettings();
    expect(settings).toEqual(OTHER_HOOKS_FIXTURE);
    expect(logs.some((m) => m.includes("removed"))).toBe(true);
  });

  it("--remove replaces a pre-existing backup atomically", async () => {
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), "utf8");
    await runInit({});
    await fs.writeFile(backupPath, "older backup", { encoding: "utf8", mode: 0o644 });

    expect(await runInit({ remove: true })).toBe(0);
    expect(await readSettings()).toEqual(OTHER_HOOKS_FIXTURE);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("--remove reverses install exactly on a missing-file fixture (back to {})", async () => {
    await runInit({});
    const code = await runInit({ remove: true });
    expect(code).toBe(0);

    const settings = await readSettings();
    expect(settings).toEqual({});
  });

  it("--remove is a no-op when there is nothing to remove", async () => {
    const logs: string[] = [];
    const code = await runInit({ remove: true, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("nothing to remove"))).toBe(true);
    await expect(fs.access(settingsPath)).rejects.toThrow();
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("--remove is idempotent: second remove is also a no-op", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(OTHER_HOOKS_FIXTURE, null, 2), "utf8");
    await runInit({});
    await runInit({ remove: true });
    const bytesAfterFirstRemove = await fs.readFile(settingsPath, "utf8");

    const logs: string[] = [];
    const code = await runInit({ remove: true, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("nothing to remove"))).toBe(true);

    const bytesAfterSecondRemove = await fs.readFile(settingsPath, "utf8");
    expect(bytesAfterSecondRemove).toBe(bytesAfterFirstRemove);
  });

  it("--remove keeps a group if it contains other commands alongside ours", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const mixedGroupFixture = {
      model: "claude-opus",
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "other-tool foo" },
              { type: "command", command: OUR_COMMAND },
            ],
          },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(mixedGroupFixture, null, 2), "utf8");

    const logs: string[] = [];
    const code = await runInit({ remove: true, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    const settings = await readSettings();
    expect(settings).toEqual({
      model: "claude-opus",
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "other-tool foo" }],
          },
        ],
      },
    });
    expect(logs.some((m) => m.includes("removed"))).toBe(true);
  });
});
