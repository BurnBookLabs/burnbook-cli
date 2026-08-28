import { promises as nodeFs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BackgroundService, CommandRunner } from "./background-service.js";
import { canonicalApiOrigin, DEFAULT_API_ORIGIN } from "../core/api.js";
import {
  createMacLaunchdService,
  type LaunchdFileSystem,
} from "./macos-launchd.js";
import { createLinuxSystemdService } from "./linux-systemd.js";
import { createWindowsTaskService } from "./windows-task.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type BackgroundServiceResolution =
  | { supported: true; service: BackgroundService }
  | { supported: false; reason: "unsupported-platform" };

export interface BackgroundServiceFactoryOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  configDir?: string;
  nodePath?: string;
  burnbookPath?: string;
  uid?: number;
  fs?: LaunchdFileSystem;
  run?: CommandRunner;
  randomId?: () => string;
  apiOrigin?: string;
}

export async function resolveBackgroundService(
  options: BackgroundServiceFactoryOptions = {},
): Promise<BackgroundServiceResolution> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { supported: false, reason: "unsupported-platform" };
  }
  const fs = options.fs ?? (nodeFs as unknown as LaunchdFileSystem);
  const homeDir = options.homeDir ?? os.homedir();
  const configDir = options.configDir ?? (platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? homeDir, "Burnbook")
    : path.join(homeDir, ".config", "burnbook"));
  const nodePath = await fs.realpath(path.resolve(options.nodePath ?? process.execPath));
  const entry = options.burnbookPath ?? process.argv[1];
  if (!entry) throw new Error("Burnbook's executable path is unavailable.");
  const burnbookPath = await fs.realpath(path.resolve(entry));
  const apiOrigin = canonicalApiOrigin(options.apiOrigin ?? DEFAULT_API_ORIGIN);

  const common = { homeDir, configDir, nodePath, burnbookPath, apiOrigin };
  if (platform === "linux") {
    return {
      supported: true,
      service: createLinuxSystemdService({
        ...common,
        managerExecutable: "/usr/bin/systemctl",
        run: options.run ?? defaultRunner,
      }),
    };
  }
  if (platform === "win32") {
    return {
      supported: true,
      service: createWindowsTaskService({
        ...common,
        managerExecutable: windowsTaskSchedulerPath(process.env.SystemRoot),
        run: options.run ?? defaultRunner,
      }),
    };
  }
  return {
    supported: true,
    service: createMacLaunchdService({
      homeDir,
      configDir,
      nodePath,
      burnbookPath,
      apiOrigin,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.fs ? { fs: options.fs } : {}),
      ...(options.run ? { run: options.run } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    }),
  };
}

function windowsTaskSchedulerPath(systemRoot: string | undefined): string {
  const root = systemRoot?.trim() || "C:\\Windows";
  if (!path.win32.isAbsolute(root) || /[\n\r\0]/.test(root)) {
    throw new Error("SystemRoot must be an absolute Windows path.");
  }
  return path.win32.join(root, "System32", "schtasks.exe");
}

const execFileAsync = promisify(execFile);
async function defaultRunner(executable: string, args: readonly string[]) {
  try {
    const result = await execFileAsync(executable, [...args], { encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}
