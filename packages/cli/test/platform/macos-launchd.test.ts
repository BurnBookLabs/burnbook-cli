import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../../src/platform/background-service.js";
import {
  BURNBOOK_LAUNCHD_LABEL,
  BURNBOOK_SYNC_INTERVAL_SECONDS,
  createMacLaunchdService,
  isManagedLaunchAgent,
  renderMacLaunchAgent,
  type LaunchdFileSystem,
} from "../../src/platform/macos-launchd.js";

interface RunnerState {
  loaded: boolean;
  failBootstrap: number;
  failEnable: number;
  calls: Array<{ executable: string; args: readonly string[] }>;
}

let root: string;
let homeDir: string;
let configDir: string;
let nodePath: string;
let burnbookPath: string;
let plistPath: string;
const API_ORIGIN = "https://staging.burnbook.dev";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), ".launchd-test-"));
  homeDir = path.join(root, "home");
  configDir = path.join(root, "config");
  nodePath = path.join(root, "bin", "node");
  burnbookPath = path.join(root, "bin", "burnbook");
  plistPath = path.join(homeDir, "Library", "LaunchAgents", `${BURNBOOK_LAUNCHD_LABEL}.plist`);
  await fs.mkdir(path.dirname(nodePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(nodePath, "node", { mode: 0o700 });
  await fs.writeFile(burnbookPath, "burnbook", { mode: 0o700 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("macOS LaunchAgent rendering", () => {
  it("renders a one-shot, low-priority, sixty-second worker", () => {
    const plist = renderMacLaunchAgent({ configDir, nodePath, burnbookPath, apiOrigin: API_ORIGIN });

    expect(plist).toContain(`<string>${BURNBOOK_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(`<integer>${BURNBOOK_SYNC_INTERVAL_SECONDS}</integer>`);
    expect(plist).toContain("<string>/usr/bin/env</string>");
    expect(plist).toContain("<string>-i</string>");
    expect(plist).toContain(`<string>BURNBOOK_CONFIG_DIR=${configDir}</string>`);
    expect(plist).toContain(`<string>BURNBOOK_API=${API_ORIGIN}</string>`);
    expect(plist).not.toContain("private-device-token");
    expect(plist).not.toContain("BURNBOOK_CLAUDE_DIR");
    expect(plist).not.toContain("BURNBOOK_ANTIGRAVITY_USAGE_FILE");
    expect(plist).not.toContain("GEMINI_TELEMETRY_OUTFILE");
    expect(plist).not.toContain("NODE_OPTIONS");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<string>Background</string>");
    expect(plist).toContain("<key>LowPriorityIO</key>");
    expect(plist).toContain("<key>LowPriorityBackgroundIO</key>");
    expect(plist).toContain("<string>/dev/null</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).not.toContain("WatchPaths");
    expect(isManagedLaunchAgent(plist)).toBe(true);
  });

  it("rejects a job that does not clear the inherited environment", () => {
    const plist = renderMacLaunchAgent({ configDir, nodePath, burnbookPath, apiOrigin: API_ORIGIN });
    const contaminated = plist.replace("<string>-i</string>", "<string>NODE_OPTIONS=--require=/tmp/unsafe</string>");

    expect(isManagedLaunchAgent(contaminated)).toBe(false);
  });

  it("escapes XML paths without changing the managed identity", () => {
    const plist = renderMacLaunchAgent({
      configDir: "/Users/test/Burn & Book",
      nodePath: "/opt/homebrew/bin/node",
      burnbookPath: "/Users/test/bin/burn<book",
      apiOrigin: API_ORIGIN,
    });

    expect(plist).toContain("Burn &amp; Book");
    expect(plist).toContain("burn&lt;book");
    expect(isManagedLaunchAgent(plist)).toBe(true);
  });

  it("rejects transient and malformed executable paths", () => {
    expect(() => renderMacLaunchAgent({
      configDir: "/Users/test/.config/burnbook",
      nodePath: "/opt/homebrew/bin/node",
      burnbookPath: "/Users/test/.npm/_npx/123/node_modules/.bin/burnbook",
      apiOrigin: API_ORIGIN,
    })).toThrow("transient");
    expect(() => renderMacLaunchAgent({
      configDir: "/Users/test/.config/burnbook",
      nodePath: "/opt/homebrew/bin/node\nother",
      burnbookPath: "/Users/test/bin/burnbook",
      apiOrigin: API_ORIGIN,
    })).toThrow("single-line");
  });
});

describe("macOS LaunchAgent lifecycle", () => {
  it("installs atomically with absolute Apple tools and is idempotent", async () => {
    const state = runnerState();
    const service = serviceFor(state);

    expect(await service.install()).toEqual({ changed: true, detail: "Installed periodic background sync." });
    expect((await fs.stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(plistPath, "utf8")).toBe(
      renderMacLaunchAgent({ configDir, nodePath, burnbookPath, apiOrigin: API_ORIGIN }),
    );
    expect(state.calls).toContainEqual({ executable: "/usr/bin/plutil", args: ["-lint", expect.any(String)] });
    expect(state.calls).toContainEqual({
      executable: "/bin/launchctl",
      args: ["bootstrap", `gui/${process.getuid()}`, plistPath],
    });
    expect(await service.install()).toEqual({
      changed: false,
      detail: "Periodic background sync is already installed.",
    });
  });

  it("upgrades the exact legacy job to an isolated environment", async () => {
    const state = runnerState();
    const service = serviceFor(state);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    const isolated = renderMacLaunchAgent({ configDir, nodePath, burnbookPath, apiOrigin: API_ORIGIN });
    const legacy = isolated.replace(
      `    <string>/usr/bin/env</string>\n    <string>-i</string>\n    <string>BURNBOOK_CONFIG_DIR=${configDir}</string>\n    <string>BURNBOOK_API=${API_ORIGIN}</string>\n`,
      "",
    );
    await fs.writeFile(plistPath, legacy, { mode: 0o600 });
    state.loaded = true;

    expect(isManagedLaunchAgent(legacy)).toBe(false);
    expect(isManagedLaunchAgent(legacy, { configDir, nodePath, burnbookPath })).toBe(true);
    expect(await service.install()).toEqual({ changed: true, detail: "Installed periodic background sync." });
    expect(await fs.readFile(plistPath, "utf8")).toBe(isolated);
  });

  it("reports installed, stale, absent, and label-conflict states", async () => {
    const state = runnerState();
    const service = serviceFor(state);
    expect((await service.inspect()).state).toBe("not-installed");

    await service.install();
    expect(await service.inspect()).toMatchObject({ state: "installed", loaded: true, current: true });
    state.loaded = false;
    expect(await service.inspect()).toMatchObject({ state: "needs-repair", loaded: false, current: true });

    await fs.unlink(plistPath);
    state.loaded = true;
    expect(await service.inspect()).toMatchObject({ state: "conflict", installed: false, loaded: true });
  });

  it("refuses unmanaged and symlink plist targets", async () => {
    const state = runnerState();
    const service = serviceFor(state);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "<plist><dict><key>Label</key><string>other</string></dict></plist>", { mode: 0o600 });
    await expect(service.install()).rejects.toThrow("unmanaged");

    await fs.unlink(plistPath);
    await fs.symlink(burnbookPath, plistPath);
    await expect(service.install()).rejects.toThrow("symlink");
  });

  it("rolls back and reloads the previous managed plist after bootstrap failure", async () => {
    const state = runnerState();
    let directorySyncs = 0;
    const oldBurnbook = path.join(root, "bin", "burnbook-old");
    await fs.writeFile(oldBurnbook, "old", { mode: 0o700 });
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    const previous = renderMacLaunchAgent({ configDir, nodePath, burnbookPath: oldBurnbook, apiOrigin: API_ORIGIN });
    await fs.writeFile(plistPath, previous, { mode: 0o600 });
    state.loaded = true;
    state.failBootstrap = 1;

    await expect(serviceFor(state, recordingFileSystem(() => { directorySyncs += 1; })).install())
      .rejects.toThrow("Could not load");
    expect(await fs.readFile(plistPath, "utf8")).toBe(previous);
    expect(state.loaded).toBe(true);
    expect(state.calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(2);
    expect(directorySyncs).toBeGreaterThanOrEqual(2);
  });

  it("triggers without killing a live job and removes only the managed plist", async () => {
    const state = runnerState();
    const service = serviceFor(state);
    await service.install();
    const sentinel = path.join(configDir, "config.json");
    await fs.writeFile(sentinel, "keep", { mode: 0o600 });

    expect(await service.trigger()).toBe(true);
    expect(state.calls.at(-1)).toEqual({
      executable: "/bin/launchctl",
      args: ["kickstart", `gui/${process.getuid()}/${BURNBOOK_LAUNCHD_LABEL}`],
    });
    expect(state.calls.at(-1)?.args).not.toContain("-k");

    expect(await service.remove()).toEqual({ changed: true, detail: "Removed periodic background sync." });
    await expect(fs.access(plistPath)).rejects.toThrow();
    expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
  });

  it("rejects unsafe executables and a symlinked config directory", async () => {
    const state = runnerState();
    const burnbookLink = path.join(root, "bin", "burnbook-link");
    await fs.symlink(burnbookPath, burnbookLink);
    await expect(createMacLaunchdService({
      homeDir,
      configDir,
      nodePath,
      burnbookPath: burnbookLink,
      apiOrigin: API_ORIGIN,
      uid: process.getuid(),
      run: runner(state),
    }).install()).rejects.toThrow("canonical regular file");

    await fs.chmod(burnbookPath, 0o722);
    await expect(serviceFor(state).install()).rejects.toThrow("group- or world-writable");

    await fs.chmod(burnbookPath, 0o700);
    await fs.rm(configDir, { recursive: true, force: true });
    const realConfig = path.join(root, "real-config");
    await fs.mkdir(realConfig, { mode: 0o700 });
    await fs.symlink(realConfig, configDir);
    await expect(serviceFor(state).install()).rejects.toThrow("not a symlink");
  });
});

function runnerState(): RunnerState {
  return { loaded: false, failBootstrap: 0, failEnable: 0, calls: [] };
}

function serviceFor(state: RunnerState, fileSystem?: LaunchdFileSystem) {
  return createMacLaunchdService({
    homeDir,
    configDir,
    nodePath,
    burnbookPath,
    apiOrigin: API_ORIGIN,
    uid: process.getuid(),
    run: runner(state),
    randomId: () => "fixed",
    ...(fileSystem ? { fs: fileSystem } : {}),
  });
}

function runner(state: RunnerState): CommandRunner {
  return async (executable, args): Promise<CommandResult> => {
    state.calls.push({ executable, args: [...args] });
    if (executable === "/usr/bin/plutil") return success();
    const action = args[0];
    if (action === "print") return state.loaded ? success() : failure();
    if (action === "bootout") {
      state.loaded = false;
      return success();
    }
    if (action === "bootstrap") {
      if (state.failBootstrap > 0) {
        state.failBootstrap -= 1;
        return failure("bootstrap failed");
      }
      state.loaded = true;
      return success();
    }
    if (action === "enable") {
      if (state.failEnable > 0) {
        state.failEnable -= 1;
        return failure("enable failed");
      }
      return success();
    }
    if (action === "kickstart") return state.loaded ? success() : failure();
    return failure("unexpected command");
  };
}

function recordingFileSystem(onDirectorySync: () => void): LaunchdFileSystem {
  return {
    mkdir: (filePath, options) => fs.mkdir(filePath, options),
    chmod: (filePath, mode) => fs.chmod(filePath, mode),
    lstat: (filePath) => fs.lstat(filePath),
    stat: (filePath) => fs.stat(filePath),
    realpath: (filePath) => fs.realpath(filePath),
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    unlink: (filePath) => fs.unlink(filePath),
    open: async (filePath, flags, mode) => {
      const handle = await fs.open(filePath, flags, mode);
      return {
        writeFile: async (data, encoding) => { await handle.writeFile(data, encoding); },
        sync: async () => {
          if (flags === "r") onDirectorySync();
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
}

function success(): CommandResult {
  return { code: 0, stdout: "", stderr: "" };
}

function failure(stderr = "not loaded"): CommandResult {
  return { code: 1, stdout: "", stderr };
}
