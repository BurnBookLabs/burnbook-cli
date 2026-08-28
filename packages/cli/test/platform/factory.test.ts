import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBackgroundService } from "../../src/platform/factory.js";
import type { LaunchdFileSystem } from "../../src/platform/macos-launchd.js";

const originalPath = process.env.PATH;
let root: string;
let binDir: string;
let burnbookPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), ".factory-test-"));
  binDir = path.join(root, "bin");
  burnbookPath = path.join(binDir, "burnbook");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "node"), "node", { mode: 0o700 });
  await fs.writeFile(burnbookPath, "burnbook", { mode: 0o700 });
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
});

describe("background service platform factory", () => {
  it("reports genuinely unsupported platforms without constructing a service", async () => {
    await expect(resolveBackgroundService({ platform: "freebsd" })).resolves.toEqual({
      supported: false,
      reason: "unsupported-platform",
    });
  });

  it.each(["linux", "win32"] as const)("supports current-user automation on %s", async (platform) => {
    const result = await resolveBackgroundService({
      platform,
      homeDir: path.join(root, "home"),
      configDir: path.join(root, "config"),
      burnbookPath,
      nodePath: path.join(binDir, "node"),
      run: installRunner,
    });
    expect(result.supported).toBe(true);
  });

  it.each([
    ["linux", "/usr/bin/systemctl"],
    ["win32", "C:\\Windows\\System32\\schtasks.exe"],
  ] as const)("uses the trusted absolute service manager on %s", async (platform, expectedManager) => {
    const calls: string[] = [];
    process.env.PATH = binDir;
    await fs.writeFile(path.join(binDir, platform === "linux" ? "systemctl" : "schtasks.exe"), "attacker", { mode: 0o700 });
    const result = await resolveBackgroundService({
      platform,
      homeDir: path.join(root, "home"),
      configDir: path.join(root, "config"),
      burnbookPath,
      nodePath: path.join(binDir, "node"),
      run: async (executable) => {
        calls.push(executable);
        return { code: 1, stdout: "", stderr: "not installed" };
      },
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    await result.service.inspect();
    expect(calls).toEqual([expectedManager]);
    expect(calls).not.toContain(path.join(binDir, platform === "linux" ? "systemctl" : "schtasks.exe"));
  });

  it("pins the current Node runtime instead of an early PATH executable", async () => {
    const homeDir = path.join(root, "home");
    const canonicalRuntime = await fs.realpath(process.execPath);
    process.env.PATH = binDir;
    const result = await resolveBackgroundService({
      platform: "darwin",
      homeDir,
      configDir: path.join(root, "config"),
      burnbookPath,
      fs: fileSystemWithSafeRuntime(canonicalRuntime),
      uid: process.getuid(),
      run: installRunner,
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    await result.service.install();
    const plist = await fs.readFile(
      path.join(homeDir, "Library", "LaunchAgents", "dev.burnbook.sync.plist"),
      "utf8",
    );
    expect(plist).toContain(`<string>${canonicalRuntime}</string>`);
    expect(plist).not.toContain(`<string>${path.join(binDir, "node")}</string>`);
  });

  it("keeps explicit Node runtime injection for tests", async () => {
    const homeDir = path.join(root, "home");
    const nodePath = path.join(binDir, "node");
    const result = await resolveBackgroundService({
      platform: "darwin",
      homeDir,
      configDir: path.join(root, "config"),
      burnbookPath,
      nodePath,
      uid: process.getuid(),
      run: installRunner,
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    await result.service.install();
    const plist = await fs.readFile(
      path.join(homeDir, "Library", "LaunchAgents", "dev.burnbook.sync.plist"),
      "utf8",
    );
    expect(plist).toContain(`<string>${nodePath}</string>`);
  });

  it("pins a repaired scheduler to the credential's canonical origin without embedding its token", async () => {
    const homeDir = path.join(root, "home");
    const result = await resolveBackgroundService({
      platform: "darwin",
      homeDir,
      configDir: path.join(root, "config"),
      burnbookPath,
      nodePath: path.join(binDir, "node"),
      apiOrigin: "https://staging.burnbook.dev/",
      uid: process.getuid(),
      run: installRunner,
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    await result.service.install();
    const plist = await fs.readFile(
      path.join(homeDir, "Library", "LaunchAgents", "dev.burnbook.sync.plist"),
      "utf8",
    );
    expect(plist).toContain("<string>BURNBOOK_API=https://staging.burnbook.dev</string>");
    expect(plist).not.toContain("deviceToken");
    expect(plist).not.toContain("private-device-token");
  });

  it("binds the scheduler to the canonical CLI entry", async () => {
    const homeDir = path.join(root, "home");
    const canonicalRuntime = await fs.realpath(process.execPath);
    const legitimate = path.join(binDir, "legitimate.mjs");
    const retargeted = path.join(binDir, "retargeted.mjs");
    const link = path.join(binDir, "burnbook-link");
    await fs.writeFile(legitimate, "legitimate", { mode: 0o700 });
    await fs.writeFile(retargeted, "retargeted", { mode: 0o700 });
    await fs.symlink(legitimate, link);

    const result = await resolveBackgroundService({
      platform: "darwin",
      homeDir,
      configDir: path.join(root, "config"),
      burnbookPath: link,
      fs: fileSystemWithSafeRuntime(canonicalRuntime),
      uid: process.getuid(),
      run: installRunner,
    });
    await fs.unlink(link);
    await fs.symlink(retargeted, link);

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    await result.service.install();
    const plist = await fs.readFile(
      path.join(homeDir, "Library", "LaunchAgents", "dev.burnbook.sync.plist"),
      "utf8",
    );
    expect(plist).toContain(`<string>${legitimate}</string>`);
    expect(plist).not.toContain(`<string>${link}</string>`);
    expect(plist).not.toContain(`<string>${retargeted}</string>`);
  });
});

async function installRunner(executable: string, args: readonly string[]) {
  if (executable === "/usr/bin/plutil") return { code: 0, stdout: "", stderr: "" };
  if (args[0] === "print") return { code: 1, stdout: "", stderr: "not loaded" };
  return { code: 0, stdout: "", stderr: "" };
}

function fileSystemWithSafeRuntime(runtimePath: string): LaunchdFileSystem {
  return {
    mkdir: (filePath, options) => fs.mkdir(filePath, options),
    chmod: (filePath, mode) => fs.chmod(filePath, mode),
    lstat: async (filePath) => safeRuntimeStat(filePath, runtimePath, await fs.lstat(filePath)),
    stat: async (filePath) => safeRuntimeStat(filePath, runtimePath, await fs.stat(filePath)),
    realpath: (filePath) => fs.realpath(filePath),
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    unlink: (filePath) => fs.unlink(filePath),
    open: async (filePath, flags, mode) => {
      const handle = await fs.open(filePath, flags, mode);
      return {
        writeFile: async (data, encoding) => { await handle.writeFile(data, encoding); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
}

function safeRuntimeStat(filePath: string, runtimePath: string, stat: Stats) {
  if (filePath !== runtimePath) return stat;
  return {
    mode: stat.mode & ~0o022,
    uid: process.getuid(),
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink(),
  };
}
