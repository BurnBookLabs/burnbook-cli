import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { canonicalApiOrigin } from "../core/api.js";
import type {
  BackgroundService,
  BackgroundServiceChange,
  BackgroundServiceHealth,
  CommandResult,
  CommandRunner,
} from "./background-service.js";

export const BURNBOOK_LAUNCHD_LABEL = "dev.burnbook.sync";
export const BURNBOOK_SYNC_INTERVAL_SECONDS = 60;

const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";
const ENV = "/usr/bin/env";
const TRANSIENT_SEGMENTS = [
  "/.npm/_npx/",
  "/_npx/",
  "/npm/_cacache/",
  "/TemporaryItems/",
];

interface FileStat {
  mode: number;
  uid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface FileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchdFileSystem {
  mkdir(filePath: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  chmod(filePath: string, mode: number): Promise<void>;
  lstat(filePath: string): Promise<FileStat>;
  stat(filePath: string): Promise<FileStat>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  open(filePath: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface MacLaunchdOptions {
  homeDir: string;
  configDir: string;
  nodePath: string;
  burnbookPath: string;
  apiOrigin: string;
  uid?: number;
  fs?: LaunchdFileSystem;
  run?: CommandRunner;
  randomId?: () => string;
}

interface LaunchdPaths {
  plist: string;
  launchAgentsDir: string;
}

export function renderMacLaunchAgent(options: Pick<
  MacLaunchdOptions,
  "configDir" | "nodePath" | "burnbookPath" | "apiOrigin"
>): string {
  validateAbsolutePath("configDir", options.configDir);
  validateAbsolutePath("nodePath", options.nodePath);
  validateAbsolutePath("burnbookPath", options.burnbookPath);
  rejectTransientExecutable(options.nodePath, "nodePath");
  rejectTransientExecutable(options.burnbookPath, "burnbookPath");
  const apiOrigin = canonicalApiOrigin(options.apiOrigin);

  const values = {
    label: escapeXml(BURNBOOK_LAUNCHD_LABEL),
    node: escapeXml(options.nodePath),
    burnbook: escapeXml(options.burnbookPath),
    workdir: escapeXml(options.configDir),
    configEnvironment: escapeXml(`BURNBOOK_CONFIG_DIR=${options.configDir}`),
    apiEnvironment: escapeXml(`BURNBOOK_API=${apiOrigin}`),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${values.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ENV}</string>
    <string>-i</string>
    <string>${values.configEnvironment}</string>
    <string>${values.apiEnvironment}</string>
    <string>${values.node}</string>
    <string>${values.burnbook}</string>
    <string>sync-worker</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${BURNBOOK_SYNC_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>LowPriorityBackgroundIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>Umask</key>
  <string>077</string>
  <key>WorkingDirectory</key>
  <string>${values.workdir}</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export function createMacLaunchdService(options: MacLaunchdOptions): BackgroundService {
  const fs = options.fs ?? (nodeFs as unknown as LaunchdFileSystem);
  const run = options.run ?? defaultCommandRunner;
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    throw new Error("A numeric user id is required to manage the Burnbook LaunchAgent.");
  }
  const paths = launchdPaths(options.homeDir);
  const serviceTarget = `gui/${uid}/${BURNBOOK_LAUNCHD_LABEL}`;
  const domainTarget = `gui/${uid}`;
  const randomId = options.randomId ?? randomUUID;

  async function inspect(): Promise<BackgroundServiceHealth> {
    const existing = await readExistingPlist(fs, paths.plist, Number(uid));
    const loaded = (await run(LAUNCHCTL, ["print", serviceTarget])).code === 0;
    if (existing.kind === "missing") {
      return loaded
        ? health("conflict", false, true, false, false, "A service uses Burnbook's label without a managed plist.")
        : health("not-installed", false, false, false, false, "Periodic background sync is not installed.");
    }
    if (existing.kind === "unsafe") {
      return health("conflict", true, loaded, false, false, existing.detail);
    }
    const managed = isManagedLaunchAgent(existing.content, options);
    if (!managed) {
      return health("conflict", true, loaded, false, false, "The LaunchAgent path contains an unmanaged service.");
    }

    let expected: string;
    try {
      expected = renderMacLaunchAgent(options);
      await validateRuntimePaths(fs, options, Number(uid));
    } catch (error) {
      return health("needs-repair", true, loaded, true, false, errorMessage(error));
    }
    const current = existing.content === expected;
    return current && loaded
      ? health("installed", true, true, true, true, "Periodic background sync is loaded and current.")
      : health("needs-repair", true, loaded, true, current, loaded
        ? "The LaunchAgent configuration needs repair."
        : "The LaunchAgent is installed but not loaded.");
  }

  async function install(): Promise<BackgroundServiceChange> {
    await preparePrivateConfigDirectory(fs, options.configDir, Number(uid));
    await validateRuntimePaths(fs, options, Number(uid));
    await prepareLaunchAgentsDirectory(fs, paths.launchAgentsDir, Number(uid));

    const expected = renderMacLaunchAgent(options);
    const existing = await readExistingPlist(fs, paths.plist, Number(uid));
    if (existing.kind === "unsafe") throw new Error(existing.detail);
    if (existing.kind === "present" && !isManagedLaunchAgent(existing.content, options)) {
      throw new Error("Refusing to replace an unmanaged LaunchAgent at the Burnbook service path.");
    }

    const loaded = (await run(LAUNCHCTL, ["print", serviceTarget])).code === 0;
    if (existing.kind === "missing" && loaded) {
      throw new Error("Refusing to replace a loaded service that only shares Burnbook's label.");
    }
    if (existing.kind === "present" && existing.content === expected && loaded) {
      return { changed: false, detail: "Periodic background sync is already installed." };
    }

    const temporary = `${paths.plist}.tmp-${process.pid}-${randomId()}`;
    let needsRollback = false;
    try {
      await writePlistTemporary(fs, temporary, expected);
      await requireSuccess(run, PLUTIL, ["-lint", temporary], "LaunchAgent validation failed");
      if (loaded) {
        await requireSuccess(run, LAUNCHCTL, ["bootout", serviceTarget], "Could not unload the existing LaunchAgent");
        needsRollback = true;
      }
      await fs.rename(temporary, paths.plist);
      needsRollback = true;
      await syncDirectory(fs, paths.launchAgentsDir);
      const bootstrapped = await run(LAUNCHCTL, ["bootstrap", domainTarget, paths.plist]);
      if (bootstrapped.code !== 0) {
        throw commandError("Could not load the Burnbook LaunchAgent", bootstrapped);
      }
      const enabled = await run(LAUNCHCTL, ["enable", serviceTarget]);
      if (enabled.code !== 0) {
        throw commandError("Could not enable the Burnbook LaunchAgent", enabled);
      }
      return { changed: true, detail: "Installed periodic background sync." };
    } catch (error) {
      await unlinkIfPresent(fs, temporary);
      if (needsRollback) {
        try {
          await rollbackInstall(fs, run, paths, existing, loaded, domainTarget, serviceTarget, randomId);
        } catch (rollbackError) {
          throw new Error(`${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`);
        }
      }
      throw error;
    }
  }

  async function trigger(): Promise<boolean> {
    const result = await run(LAUNCHCTL, ["kickstart", serviceTarget]);
    return result.code === 0;
  }

  async function remove(): Promise<BackgroundServiceChange> {
    const existing = await readExistingPlist(fs, paths.plist, Number(uid));
    const loaded = (await run(LAUNCHCTL, ["print", serviceTarget])).code === 0;
    if (existing.kind === "missing") {
      if (loaded) throw new Error("Refusing to unload a service that only shares Burnbook's label.");
      return { changed: false, detail: "Periodic background sync is not installed." };
    }
    if (existing.kind === "unsafe") throw new Error(existing.detail);
    if (!isManagedLaunchAgent(existing.content, options)) {
      throw new Error("Refusing to remove an unmanaged LaunchAgent from the Burnbook service path.");
    }
    if (loaded) {
      await requireSuccess(run, LAUNCHCTL, ["bootout", serviceTarget], "Could not unload the Burnbook LaunchAgent");
    }
    try {
      await fs.unlink(paths.plist);
      await syncDirectory(fs, paths.launchAgentsDir);
    } catch (error) {
      try {
        await rollbackInstall(fs, run, paths, existing, loaded, domainTarget, serviceTarget, randomId);
      } catch (rollbackError) {
        throw new Error(`${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`);
      }
      throw error;
    }
    return { changed: true, detail: "Removed periodic background sync." };
  }

  return { install, inspect, trigger, remove };
}

function launchdPaths(homeDir: string): LaunchdPaths {
  validateAbsolutePath("homeDir", homeDir);
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  return { launchAgentsDir, plist: path.join(launchAgentsDir, `${BURNBOOK_LAUNCHD_LABEL}.plist`) };
}

function health(
  state: BackgroundServiceHealth["state"],
  installed: boolean,
  loaded: boolean,
  managed: boolean,
  current: boolean,
  detail: string,
): BackgroundServiceHealth {
  return { state, installed, loaded, managed, current, detail };
}

async function preparePrivateConfigDirectory(
  fs: LaunchdFileSystem,
  configDir: string,
  uid: number,
): Promise<void> {
  validateAbsolutePath("configDir", configDir);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const lexical = await fs.lstat(configDir);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error("Burnbook's config directory must be a real directory, not a symlink.");
  }
  const canonical = await fs.realpath(configDir);
  if (canonical !== path.resolve(configDir)) {
    throw new Error("Burnbook's config directory must not traverse symlinks.");
  }
  const stat = await fs.stat(configDir);
  if (stat.uid !== uid) throw new Error("Burnbook's config directory must be owned by the current user.");
  await fs.chmod(configDir, 0o700);
}

async function prepareLaunchAgentsDirectory(
  fs: LaunchdFileSystem,
  directory: string,
  uid: number,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const lexical = await fs.lstat(directory);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error("The user LaunchAgents path must be a real directory, not a symlink.");
  }
  if (await fs.realpath(directory) !== path.resolve(directory)) {
    throw new Error("The user LaunchAgents path must not traverse symlinks.");
  }
  const stat = await fs.stat(directory);
  if (stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error("The user LaunchAgents directory has unsafe ownership or permissions.");
  }
}

async function validateRuntimePaths(
  fs: LaunchdFileSystem,
  options: Pick<MacLaunchdOptions, "nodePath" | "burnbookPath">,
  uid: number,
): Promise<void> {
  await validateExecutable(fs, options.nodePath, "Node.js", uid);
  await validateExecutable(fs, options.burnbookPath, "Burnbook", uid);
}

async function validateExecutable(
  fs: LaunchdFileSystem,
  executable: string,
  label: string,
  uid: number,
): Promise<void> {
  validateAbsolutePath(`${label} executable`, executable);
  rejectTransientExecutable(executable, `${label} executable`);
  const lexical = await fs.lstat(executable);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error(`${label} executable must be a canonical regular file.`);
  }
  const target = await fs.stat(executable);
  if (!target.isFile()) throw new Error(`${label} executable does not resolve to a regular file.`);
  if ((target.mode & 0o022) !== 0) throw new Error(`${label} executable must not be group- or world-writable.`);
  if (target.uid !== 0 && target.uid !== uid) {
    throw new Error(`${label} executable must be owned by root or the current user.`);
  }
}

type ExistingPlist =
  | { kind: "missing" }
  | { kind: "unsafe"; detail: string }
  | { kind: "present"; content: string };

async function readExistingPlist(
  fs: LaunchdFileSystem,
  plistPath: string,
  ownerUid: number,
): Promise<ExistingPlist> {
  let stat: FileStat;
  try {
    stat = await fs.lstat(plistPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { kind: "unsafe", detail: "Refusing to manage a symlink at the Burnbook LaunchAgent path." };
  }
  if (!stat.isFile()) {
    return { kind: "unsafe", detail: "The Burnbook LaunchAgent path is not a regular file." };
  }
  if (stat.uid !== ownerUid) {
    return { kind: "unsafe", detail: "The Burnbook LaunchAgent must be owned by the current user." };
  }
  if ((stat.mode & 0o022) !== 0) {
    return { kind: "unsafe", detail: "The Burnbook LaunchAgent must not be group- or world-writable." };
  }
  return { kind: "present", content: await fs.readFile(plistPath, "utf8") };
}

export function isManagedLaunchAgent(
  content: string,
  expected?: Pick<MacLaunchdOptions, "configDir" | "nodePath" | "burnbookPath"> & { apiOrigin?: string },
): boolean {
  const label = extractString(content, "Label");
  const workdir = extractString(content, "WorkingDirectory");
  const args = extractArrayStrings(content, "ProgramArguments");
  if (label !== BURNBOOK_LAUNCHD_LABEL || workdir === undefined) return false;
  const current = isAbsoluteSingleLinePath(workdir) &&
    args.length === 7 &&
    args[0] === ENV &&
    args[1] === "-i" &&
    args[2] === `BURNBOOK_CONFIG_DIR=${workdir}` &&
    isCanonicalApiEnvironment(args[3], expected?.apiOrigin) &&
    isAbsoluteSingleLinePath(args[4]) &&
    isAbsoluteSingleLinePath(args[5]) &&
    args[6] === "sync-worker";
  if (current) return true;
  const isolatedLegacy = isAbsoluteSingleLinePath(workdir) &&
    args.length === 6 &&
    args[0] === ENV &&
    args[1] === "-i" &&
    args[2] === `BURNBOOK_CONFIG_DIR=${workdir}` &&
    isAbsoluteSingleLinePath(args[3]) &&
    isAbsoluteSingleLinePath(args[4]) &&
    args[5] === "sync-worker";
  if (isolatedLegacy) return true;
  if (!expected) return false;
  if (workdir !== expected.configDir) return false;
  const exactLegacy = args.length === 3 &&
    args[0] === expected.nodePath &&
    args[1] === expected.burnbookPath &&
    args[2] === "sync-worker";
  return exactLegacy;
}

function isCanonicalApiEnvironment(value: string | undefined, expected?: string): boolean {
  if (!value?.startsWith("BURNBOOK_API=")) return false;
  const raw = value.slice("BURNBOOK_API=".length);
  try {
    const canonical = canonicalApiOrigin(raw);
    return canonical === raw && (expected === undefined || canonical === canonicalApiOrigin(expected));
  } catch {
    return false;
  }
}

async function writePlistTemporary(fs: LaunchdFileSystem, filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
}

async function rollbackInstall(
  fs: LaunchdFileSystem,
  run: CommandRunner,
  paths: LaunchdPaths,
  previous: ExistingPlist,
  wasLoaded: boolean,
  domainTarget: string,
  serviceTarget: string,
  randomId: () => string,
): Promise<void> {
  await run(LAUNCHCTL, ["bootout", serviceTarget]);
  if (previous.kind === "present") {
    const rollback = `${paths.plist}.rollback-${process.pid}-${randomId()}`;
    try {
      await writePlistTemporary(fs, rollback, previous.content);
      await fs.rename(rollback, paths.plist);
      await syncDirectory(fs, paths.launchAgentsDir);
      if (wasLoaded) {
        await requireSuccess(run, LAUNCHCTL, ["bootstrap", domainTarget, paths.plist], "Could not reload the previous LaunchAgent");
      }
      return;
    } finally {
      await unlinkIfPresent(fs, rollback);
    }
  }
  await unlinkIfPresent(fs, paths.plist);
  await syncDirectory(fs, paths.launchAgentsDir);
}

async function syncDirectory(fs: LaunchdFileSystem, directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireSuccess(
  run: CommandRunner,
  executable: string,
  args: readonly string[],
  message: string,
): Promise<void> {
  const result = await run(executable, args);
  if (result.code !== 0) throw commandError(message, result);
}

function commandError(message: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(detail ? `${message}: ${detail}` : message);
}

async function unlinkIfPresent(fs: LaunchdFileSystem, filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function extractString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`));
  return match ? decodeXml(match[1]) : undefined;
}

function extractArrayStrings(content: string, key: string): string[] {
  const match = content.match(new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<array>([\\s\\S]*?)</array>`));
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((entry) => decodeXml(entry[1]));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function validateAbsolutePath(name: string, value: string): void {
  if (!isAbsoluteSingleLinePath(value)) {
    throw new Error(`${name} must be an absolute single-line path.`);
  }
}

function isAbsoluteSingleLinePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0") && !/[\r\n]/.test(value);
}

function rejectTransientExecutable(value: string, name: string): void {
  if (TRANSIENT_SEGMENTS.some((segment) => value.includes(segment))) {
    throw new Error(`${name} is transient. Install Burnbook globally before enabling background sync.`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(executable: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], { encoding: "utf8", timeout: 5000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      const output = error as Error & { code: number; stdout?: string; stderr?: string };
      return { code: output.code, stdout: output.stdout ?? "", stderr: output.stderr ?? "" };
    }
    throw error;
  }
}
