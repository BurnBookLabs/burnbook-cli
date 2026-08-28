import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  promises as fs,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "./paths.js";
import { canonicalApiOrigin, DEFAULT_API_ORIGIN } from "./api.js";

const SERVICE_ID = "dev.burnbook.retry-worker";
const SYSTEMD_UNIT = "burnbook-retry-worker.service";
const MANAGED_MARKER = "Managed by Burnbook retry-service; do not edit.";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export type RetryServiceAction = "install" | "status" | "remove";
export type SupportedServicePlatform = "darwin" | "linux";

export interface RetryServiceSettings {
  intervalSeconds: number;
  maxBatches: number;
}

export interface ProcessResult {
  code: number;
}

export interface RetryServiceFileHandle {
  readFile(options: { encoding: BufferEncoding }): Promise<string>;
  stat(): Promise<Stats>;
  writeFile(contents: string, encoding: BufferEncoding): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface RetryServiceRuntime {
  platform: NodeJS.Platform;
  uid: number | undefined;
  homeDir: string;
  configDir: string;
  apiOrigin?: string;
  nodeExecutable: string;
  cliEntry: string;
  systemctlExecutable?: string;
  processId: number;
  randomSuffix: () => string;
  mkdir: typeof fs.mkdir;
  lstat: typeof fs.lstat;
  open: (target: string, flags: string | number, mode: number) => Promise<RetryServiceFileHandle>;
  rename: typeof fs.rename;
  unlink: typeof fs.unlink;
  run: (executable: string, args: readonly string[]) => Promise<ProcessResult>;
}

export interface RetryServiceResult {
  exitCode: number;
  message: string;
}

interface ServiceDefinition {
  platform: SupportedServicePlatform;
  target: string;
  directory: string;
  ownershipRoot: string;
  contents: string;
  managerExecutable: string;
  managerName: string;
}

interface ExistingDefinition {
  contents?: string;
  mode?: number;
}

export async function manageRetryService(
  action: RetryServiceAction,
  settings: RetryServiceSettings,
  injectedRuntime?: Partial<RetryServiceRuntime>,
): Promise<RetryServiceResult> {
  assertSettings(settings);
  const runtime = { ...defaultRuntime(), ...injectedRuntime } as RetryServiceRuntime;
  const definition = buildServiceDefinition(runtime, settings);

  if (action === "install") return installService(runtime, definition);
  if (action === "status") return serviceStatus(runtime, definition);
  return removeService(runtime, definition);
}

export function buildServiceDefinition(
  runtime: Pick<
    RetryServiceRuntime,
    | "platform"
    | "uid"
    | "homeDir"
    | "configDir"
    | "apiOrigin"
    | "nodeExecutable"
    | "cliEntry"
    | "systemctlExecutable"
  >,
  settings: RetryServiceSettings,
): ServiceDefinition {
  assertSettings(settings);
  if (runtime.platform !== "darwin" && runtime.platform !== "linux") {
    throw new Error(
      `resident retry services are not supported on ${runtime.platform}; use burn retry-worker`,
    );
  }
  if (!Number.isSafeInteger(runtime.uid) || runtime.uid! < 0) {
    throw new Error("could not determine the current user id; refusing to install a service");
  }

  const homeDir = requireAbsolutePath(runtime.homeDir, "home directory");
  const stateDir = requireAbsolutePath(runtime.configDir, "Burnbook config directory");
  const nodeExecutable = requireAbsolutePath(runtime.nodeExecutable, "Node executable");
  const cliEntry = requireAbsolutePath(runtime.cliEntry, "Burnbook CLI entry");
  const environment = serviceEnvironment(stateDir, runtime.apiOrigin);
  const args = [
    nodeExecutable,
    cliEntry,
    "retry-worker",
    "--interval",
    String(settings.intervalSeconds),
    "--max-batches",
    String(settings.maxBatches),
  ];

  if (runtime.platform === "darwin") {
    const directory = path.join(homeDir, "Library", "LaunchAgents");
    return {
      platform: "darwin",
      target: path.join(directory, `${SERVICE_ID}.plist`),
      directory,
      ownershipRoot: homeDir,
      contents: renderLaunchd(args, environment),
      managerExecutable: "/bin/launchctl",
      managerName: "launchd",
    };
  }

  const directory = path.join(homeDir, ".local", "share", "systemd", "user");
  return {
    platform: "linux",
    target: path.join(directory, SYSTEMD_UNIT),
    directory,
    ownershipRoot: homeDir,
    contents: renderSystemd(args, environment, stateDir),
    managerExecutable: requireSystemctlExecutable(runtime.systemctlExecutable),
    managerName: "systemd",
  };
}

async function installService(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
): Promise<RetryServiceResult> {
  await inspectOwnedDirectory(runtime, definition.ownershipRoot, definition.directory, true);
  const existing = await inspectManagedTarget(runtime, definition.target);
  const state = await managerState(runtime, definition);
  if (!existing.contents && state.known) {
    throw new Error(
      `${definition.managerName} already knows ${serviceDisplayName(definition)} from another location`,
    );
  }

  try {
    if (definition.platform === "darwin" && state.active) {
      await expectManagerSuccess(
        runtime,
        definition,
        ["bootout", `gui/${runtime.uid}`, definition.target],
        "stop the previous service",
      );
    }
    await atomicManagedWrite(runtime, definition.target, definition.contents);
    await activate(runtime, definition);
  } catch (error) {
    await rollbackOrThrow(runtime, definition, existing.contents, state, error);
  }

  return {
    exitCode: 0,
    message: `retry service installed and active (${definition.target})`,
  };
}

async function serviceStatus(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
): Promise<RetryServiceResult> {
  if (!await inspectOwnedDirectory(runtime, definition.ownershipRoot, definition.directory, false)) {
    return { exitCode: 1, message: "retry service is not installed" };
  }
  const existing = await inspectManagedTarget(runtime, definition.target);
  if (!existing.contents) return { exitCode: 1, message: "retry service is not installed" };
  const state = await managerState(runtime, definition);
  return state.active
    ? { exitCode: 0, message: "retry service is installed and active" }
    : { exitCode: 1, message: "retry service is installed but inactive" };
}

async function removeService(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
): Promise<RetryServiceResult> {
  if (!await inspectOwnedDirectory(runtime, definition.ownershipRoot, definition.directory, false)) {
    return { exitCode: 0, message: "retry service is not installed" };
  }
  const existing = await inspectManagedTarget(runtime, definition.target);
  if (!existing.contents) return { exitCode: 0, message: "retry service is not installed" };
  const state = await managerState(runtime, definition);

  try {
    if (definition.platform === "darwin") {
      if (state.active) {
        await expectManagerSuccess(
          runtime,
          definition,
          ["bootout", `gui/${runtime.uid}`, definition.target],
          "stop the service",
        );
      }
    } else {
      await expectManagerSuccess(
        runtime,
        definition,
        ["--user", "disable", "--now", SYSTEMD_UNIT],
        "disable the service",
      );
    }

    await runtime.unlink(definition.target);
    if (definition.platform === "linux") {
      await expectManagerSuccess(
        runtime,
        definition,
        ["--user", "daemon-reload"],
        "reload the user service manager",
      );
    }
  } catch (error) {
    await rollbackOrThrow(runtime, definition, existing.contents, state, error);
  }
  return { exitCode: 0, message: "retry service removed" };
}

async function activate(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
): Promise<void> {
  if (definition.platform === "darwin") {
    await expectManagerSuccess(
      runtime,
      definition,
      ["bootstrap", `gui/${runtime.uid}`, definition.target],
      "activate the service",
    );
    return;
  }
  await expectManagerSuccess(
    runtime,
    definition,
    ["--user", "daemon-reload"],
    "reload the user service manager",
  );
  await expectManagerSuccess(
    runtime,
    definition,
    ["--user", "enable", SYSTEMD_UNIT],
    "enable the service",
  );
  await expectManagerSuccess(
    runtime,
    definition,
    ["--user", "restart", SYSTEMD_UNIT],
    "start the service",
  );
}

async function restoreDefinition(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
  previousContents: string | undefined,
  previousState: { known: boolean; active: boolean; enabled: boolean },
): Promise<void> {
  const failures: string[] = [];
  if (definition.platform === "linux") {
    if (previousContents) {
      await recordRollbackStep(failures, "restore definition", () =>
        atomicManagedWrite(runtime, definition.target, previousContents));
    }
    await recordRollbackStep(failures, "prepare manager", () =>
      expectManagerSuccess(
        runtime,
        definition,
        ["--user", "disable", "--now", SYSTEMD_UNIT],
        "prepare rollback",
      ));
  } else {
    await recordRollbackStep(failures, "prepare manager", async () => {
      const current = await runManager(runtime, definition, [
        "print",
        `gui/${runtime.uid}/${SERVICE_ID}`,
      ]);
      if (current.code === 0) {
        await expectManagerSuccess(
          runtime,
          definition,
          ["bootout", `gui/${runtime.uid}`, definition.target],
          "prepare rollback",
        );
      }
    });
    if (previousContents) {
      await recordRollbackStep(failures, "restore definition", () =>
        atomicManagedWrite(runtime, definition.target, previousContents));
    }
  }
  if (definition.platform === "linux") {
    if (!previousContents) {
      await recordRollbackStep(failures, "remove replacement definition", () =>
        removeManagedFile(runtime, definition.target));
    }
    await recordRollbackStep(failures, "reload manager", () =>
      expectManagerSuccess(
        runtime,
        definition,
        ["--user", "daemon-reload"],
        "reload the previous definition",
      ));
    if (previousContents && previousState.enabled) {
      await recordRollbackStep(failures, "restore enabled state", () =>
        expectManagerSuccess(
          runtime,
          definition,
          ["--user", "enable", SYSTEMD_UNIT],
          "restore the enabled service",
        ));
    }
    if (previousContents && previousState.active) {
      await recordRollbackStep(failures, "restore active state", () =>
        expectManagerSuccess(
          runtime,
          definition,
          ["--user", "restart", SYSTEMD_UNIT],
          "restore the active service",
        ));
    }
  } else {
    if (!previousContents) {
      await recordRollbackStep(failures, "remove replacement definition", () =>
        removeManagedFile(runtime, definition.target));
    }
    if (previousContents && previousState.active) {
      await recordRollbackStep(failures, "restore active state", () =>
        expectManagerSuccess(
          runtime,
          definition,
          ["bootstrap", `gui/${runtime.uid}`, definition.target],
          "restore the active service",
        ));
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function recordRollbackStep(
  failures: string[],
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    failures.push(`${label}: ${errorMessage(error)}`);
  }
}

async function rollbackOrThrow(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
  previousContents: string | undefined,
  previousState: { known: boolean; active: boolean; enabled: boolean },
  originalError: unknown,
): Promise<never> {
  try {
    await restoreDefinition(runtime, definition, previousContents, previousState);
  } catch (rollbackError) {
    throw new Error(
      `${errorMessage(originalError)}; rollback failed: ${errorMessage(rollbackError)}`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function managerState(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
): Promise<{ known: boolean; active: boolean; enabled: boolean }> {
  if (definition.platform === "darwin") {
    const result = await runManager(runtime, definition, ["print", `gui/${runtime.uid}/${SERVICE_ID}`]);
    return { known: result.code === 0, active: result.code === 0, enabled: result.code === 0 };
  }
  const known = await runManager(runtime, definition, ["--user", "cat", SYSTEMD_UNIT]);
  const active = await runManager(runtime, definition, ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
  const enabled = await runManager(runtime, definition, [
    "--user",
    "is-enabled",
    "--quiet",
    SYSTEMD_UNIT,
  ]);
  return { known: known.code === 0, active: active.code === 0, enabled: enabled.code === 0 };
}

async function expectManagerSuccess(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
  args: readonly string[],
  operation: string,
): Promise<void> {
  const result = await runManager(runtime, definition, args);
  if (result.code !== 0) throw new Error(`${definition.managerName} could not ${operation}`);
}

async function runManager(
  runtime: RetryServiceRuntime,
  definition: ServiceDefinition,
  args: readonly string[],
): Promise<ProcessResult> {
  try {
    return await runtime.run(definition.managerExecutable, args);
  } catch {
    throw new Error(`${definition.managerName} is unavailable; no service files were removed`);
  }
}

async function inspectOwnedDirectory(
  runtime: RetryServiceRuntime,
  ownershipRoot: string,
  directory: string,
  create: boolean,
): Promise<boolean> {
  const relative = path.relative(ownershipRoot, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("service directory escaped its ownership root");
  }
  const segments = relative ? relative.split(path.sep) : [];
  let current = ownershipRoot;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await runtime.lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      if (!create) return false;
      await runtime.mkdir(current, { mode: DIRECTORY_MODE });
      stat = await runtime.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`service directory path contains a link or non-directory: ${current}`);
    }
    assertOwnedByCurrentUser(stat, runtime.uid, "service directory");
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`service directory path is writable by another user: ${current}`);
    }
  }
  return true;
}

async function inspectManagedTarget(
  runtime: RetryServiceRuntime,
  target: string,
): Promise<ExistingDefinition> {
  let handle: RetryServiceFileHandle;
  try {
    handle = await runtime.open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    if (isErrno(error, "ELOOP")) {
      throw new Error(`refusing to replace non-regular service path: ${target}`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`refusing to replace non-regular service path: ${target}`);
    }
    assertOwnedByCurrentUser(stat, runtime.uid, "service file");
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`service file is writable by another user: ${target}`);
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    if (!isManagedDefinition(contents)) {
      throw new Error(`refusing to replace an unmanaged service file: ${target}`);
    }
    return { contents, mode: stat.mode };
  } finally {
    await handle.close();
  }
}

async function atomicManagedWrite(
  runtime: RetryServiceRuntime,
  target: string,
  contents: string,
): Promise<void> {
  const temp = `${target}.${runtime.processId}.${runtime.randomSuffix()}.tmp`;
  let handle: RetryServiceFileHandle | undefined;
  try {
    handle = await runtime.open(temp, "wx", FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.chmod(FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await runtime.rename(temp, target);
    const written = await inspectManagedTarget(runtime, target);
    if (written.contents !== contents) {
      throw new Error("atomic service write verification failed");
    }
    if ((written.mode! & 0o777) !== FILE_MODE) {
      throw new Error("service file permissions are not owner-only");
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await runtime.unlink(temp).catch((unlinkError: unknown) => {
      if (!isErrno(unlinkError, "ENOENT")) throw unlinkError;
    });
    throw error;
  }
}

async function removeManagedFile(runtime: RetryServiceRuntime, target: string): Promise<void> {
  const current = await inspectManagedTarget(runtime, target);
  if (current.contents) await runtime.unlink(target);
}

function assertOwnedByCurrentUser(stat: Stats, uid: number | undefined, label: string): void {
  if (!Number.isSafeInteger(uid) || stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function isManagedDefinition(contents: string): boolean {
  return (
    contents.startsWith(`# ${MANAGED_MARKER}\n`) ||
    (contents.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n") &&
      contents.slice(0, 512).includes(`<!-- ${MANAGED_MARKER} -->`))
  );
}

function renderLaunchd(args: readonly string[], environment: Readonly<Record<string, string>>): string {
  const argumentsXml = args.map((argument) => `    <string>${escapeXml(argument)}</string>`).join("\n");
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    `<!-- ${MANAGED_MARKER} -->`,
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${SERVICE_ID}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsXml,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentXml,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>30</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>/dev/null</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderSystemd(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  stateDir: string,
): string {
  const environmentLines = Object.entries(environment).map(
    ([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`,
  );
  return [
    `# ${MANAGED_MARKER}`,
    "[Unit]",
    "Description=Burnbook sanitized evidence retry worker",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=:${args.map(quoteSystemd).join(" ")}`,
    ...environmentLines,
    "Restart=on-failure",
    "RestartSec=30",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${quoteSystemd(stateDir)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function serviceEnvironment(stateDir: string, apiOrigin?: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { BURNBOOK_CONFIG_DIR: stateDir };
  if (apiOrigin) environment.BURNBOOK_API = validateApiOrigin(apiOrigin);
  return environment;
}

function validateApiOrigin(raw: string): string {
  return canonicalApiOrigin(raw);
}

function quoteSystemd(value: string): string {
  assertSafeValue(value, "systemd argument");
  return `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}"`;
}

function escapeXml(value: string): string {
  assertSafeValue(value, "launchd value");
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function requireAbsolutePath(value: string, label: string): string {
  assertSafeValue(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

function requireSystemctlExecutable(value: string | undefined): string {
  if (!value) {
    throw new Error("systemctl was not found in a trusted system location; use burn retry-worker");
  }
  return requireAbsolutePath(value, "systemctl executable");
}

function assertSafeValue(value: string, label: string): void {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${label} contains an unsafe value`);
}

function assertSettings(settings: RetryServiceSettings): void {
  if (
    !Number.isSafeInteger(settings.intervalSeconds) ||
    settings.intervalSeconds < 10 ||
    settings.intervalSeconds > 3600
  ) {
    throw new Error("interval must be an integer between 10 and 3600 seconds");
  }
  if (
    !Number.isSafeInteger(settings.maxBatches) ||
    settings.maxBatches < 1 ||
    settings.maxBatches > 20
  ) {
    throw new Error("max-batches must be an integer between 1 and 20");
  }
}

function serviceDisplayName(definition: ServiceDefinition): string {
  return definition.platform === "darwin" ? SERVICE_ID : SYSTEMD_UNIT;
}

function defaultRuntime(): RetryServiceRuntime {
  const cliArgument = process.argv[1];
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    homeDir: os.homedir(),
    configDir: configDir(),
    apiOrigin: DEFAULT_API_ORIGIN,
    nodeExecutable: process.execPath,
    cliEntry: cliArgument ? realpathSync(cliArgument) : "",
    systemctlExecutable: process.platform === "linux" ? findSystemctlExecutable() : undefined,
    processId: process.pid,
    randomSuffix: () => randomBytes(8).toString("hex"),
    mkdir: fs.mkdir,
    lstat: fs.lstat,
    open: (target, flags, mode) => fs.open(target, flags, mode),
    rename: fs.rename,
    unlink: fs.unlink,
    run: runWithoutShell,
  };
}

function findSystemctlExecutable(): string {
  const candidates = [
    "/usr/bin/systemctl",
    "/bin/systemctl",
    "/usr/local/bin/systemctl",
    "/run/current-system/sw/bin/systemctl",
  ];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (
        stat.isFile() &&
        stat.uid === 0 &&
        (stat.mode & 0o111) !== 0 &&
        (stat.mode & 0o022) === 0
      ) return resolved;
    } catch {
      continue;
    }
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runWithoutShell(executable: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1 }));
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
