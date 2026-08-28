import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalApiOrigin } from "../core/api.js";
import type {
  BackgroundService,
  BackgroundServiceChange,
  BackgroundServiceHealth,
  CommandRunner,
} from "./background-service.js";

export const BURNBOOK_SYSTEMD_SERVICE = "burnbook-sync.service";
export const BURNBOOK_SYSTEMD_TIMER = "burnbook-sync.timer";
const MARKER = "# Managed by Burnbook; do not edit.";

export interface LinuxSystemdOptions {
  homeDir: string;
  configDir: string;
  nodePath: string;
  burnbookPath: string;
  apiOrigin: string;
  managerExecutable: string;
  run: CommandRunner;
}

export function renderLinuxSystemdUnits(options: Omit<LinuxSystemdOptions, "run" | "managerExecutable">) {
  const nodePath = systemdValue(options.nodePath);
  const burnbookPath = systemdValue(options.burnbookPath);
  const configDir = systemdValue(options.configDir);
  const apiOrigin = systemdValue(canonicalApiOrigin(options.apiOrigin));
  return {
    service: `${MARKER}\n[Unit]\nDescription=Burnbook content-free usage sync\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUMask=0077\nWorkingDirectory=${configDir}\nEnvironment=BURNBOOK_CONFIG_DIR=${configDir}\nEnvironment=BURNBOOK_API=${apiOrigin}\nExecStart=${nodePath} ${burnbookPath} sync-worker\nNice=10\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${configDir}\n`,
    timer: `${MARKER}\n[Unit]\nDescription=Run Burnbook sync every minute\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nPersistent=true\nAccuracySec=10s\nUnit=${BURNBOOK_SYSTEMD_SERVICE}\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function createLinuxSystemdService(options: LinuxSystemdOptions): BackgroundService {
  const directory = path.join(options.homeDir, ".config", "systemd", "user");
  const servicePath = path.join(directory, BURNBOOK_SYSTEMD_SERVICE);
  const timerPath = path.join(directory, BURNBOOK_SYSTEMD_TIMER);
  const expected = renderLinuxSystemdUnits(options);

  async function inspect(): Promise<BackgroundServiceHealth> {
    const service = await managedContents(servicePath);
    const timer = await managedContents(timerPath);
    const loaded = (await options.run(options.managerExecutable, ["--user", "is-active", BURNBOOK_SYSTEMD_TIMER])).code === 0;
    if (!service && !timer) return health("not-installed", false, loaded, false, false, "Periodic background sync is not installed.");
    if (service === "unmanaged" || timer === "unmanaged") {
      return health("conflict", true, loaded, false, false, "A Burnbook systemd path contains an unmanaged unit.");
    }
    const current = service === expected.service && timer === expected.timer;
    return current && loaded
      ? health("installed", true, true, true, true, "Periodic background sync is loaded and current.")
      : health("needs-repair", true, loaded, true, current, "The systemd user timer needs repair.");
  }

  async function install(): Promise<BackgroundServiceChange> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(options.configDir, { recursive: true, mode: 0o700 });
    const service = await managedContents(servicePath);
    const timer = await managedContents(timerPath);
    if (service === "unmanaged" || timer === "unmanaged") {
      throw new Error("Refusing to replace an unmanaged systemd user unit.");
    }
    const current = service === expected.service && timer === expected.timer;
    await atomicWrite(servicePath, expected.service);
    await atomicWrite(timerPath, expected.timer);
    await requireSuccess(["--user", "daemon-reload"], "Could not reload the systemd user manager");
    await requireSuccess(["--user", "enable", "--now", BURNBOOK_SYSTEMD_TIMER], "Could not enable the Burnbook timer");
    return { changed: !current, detail: current ? "Periodic background sync is already installed." : "Installed periodic background sync." };
  }

  async function trigger(): Promise<boolean> {
    return (await options.run(options.managerExecutable, ["--user", "start", BURNBOOK_SYSTEMD_SERVICE])).code === 0;
  }

  async function remove(): Promise<BackgroundServiceChange> {
    const service = await managedContents(servicePath);
    const timer = await managedContents(timerPath);
    if (!service && !timer) return { changed: false, detail: "Periodic background sync is not installed." };
    if (service === "unmanaged" || timer === "unmanaged") {
      throw new Error("Refusing to remove an unmanaged systemd user unit.");
    }
    await options.run(options.managerExecutable, ["--user", "disable", "--now", BURNBOOK_SYSTEMD_TIMER]);
    await Promise.all([fs.unlink(servicePath).catch(missingOnly), fs.unlink(timerPath).catch(missingOnly)]);
    await requireSuccess(["--user", "daemon-reload"], "Could not reload the systemd user manager");
    return { changed: true, detail: "Removed periodic background sync." };
  }

  async function managedContents(file: string): Promise<string | "unmanaged" | undefined> {
    try {
      const value = await fs.readFile(file, "utf8");
      return value.startsWith(MARKER) ? value : "unmanaged";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function requireSuccess(args: string[], message: string): Promise<void> {
    const result = await options.run(options.managerExecutable, args);
    if (result.code !== 0) throw new Error(`${message}: ${result.stderr || result.stdout}`);
  }

  return { install, inspect, trigger, remove };
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

function systemdValue(value: string): string {
  if (!path.isAbsolute(value) && !value.startsWith("https://")) throw new Error("systemd paths must be absolute");
  if (/[\n\r\0]/.test(value)) throw new Error("invalid systemd value");
  return value.replace(/%/g, "%%").replace(/ /g, "\\x20");
}

function health(
  state: BackgroundServiceHealth["state"], installed: boolean, loaded: boolean,
  managed: boolean, current: boolean, detail: string,
): BackgroundServiceHealth {
  return { state, installed, loaded, managed, current, detail };
}

function missingOnly(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
