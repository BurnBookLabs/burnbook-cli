import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalApiOrigin } from "../core/api.js";
import type {
  BackgroundService,
  BackgroundServiceChange,
  BackgroundServiceHealth,
  CommandRunner,
} from "./background-service.js";

export const BURNBOOK_WINDOWS_TASK = "Burnbook Sync";
const MARKER = "<!-- Managed by Burnbook; do not edit. -->";

export interface WindowsTaskOptions {
  configDir: string;
  nodePath: string;
  burnbookPath: string;
  apiOrigin: string;
  managerExecutable: string;
  run: CommandRunner;
}

export function renderWindowsTask(options: Omit<WindowsTaskOptions, "run" | "managerExecutable">): string {
  for (const value of [options.configDir, options.nodePath, options.burnbookPath]) {
    if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) throw new Error("Windows task paths must be absolute");
  }
  const command = escapeXml(options.nodePath);
  const apiOrigin = canonicalApiOrigin(options.apiOrigin);
  const argumentsValue = escapeXml(
    `\"${options.burnbookPath}\" sync-worker --config-dir \"${options.configDir}\" --api-origin \"${apiOrigin}\"`,
  );
  const workdir = escapeXml(options.configDir);
  const api = escapeXml(apiOrigin);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${MARKER}\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo><Description>Burnbook content-free usage sync; API ${api}</Description></RegistrationInfo>\n  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>\n  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT5M</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>\n  <Actions Context="Author"><Exec><Command>${command}</Command><Arguments>${argumentsValue}</Arguments><WorkingDirectory>${workdir}</WorkingDirectory></Exec></Actions>\n</Task>\n`;
}

export function createWindowsTaskService(options: WindowsTaskOptions): BackgroundService {
  const definitionPath = path.join(options.configDir, "burnbook-sync-task.xml");
  const expected = renderWindowsTask(options);

  async function inspect(): Promise<BackgroundServiceHealth> {
    const definition = await readDefinition();
    const loaded = (await options.run(options.managerExecutable, ["/Query", "/TN", BURNBOOK_WINDOWS_TASK])).code === 0;
    if (!definition) return health("not-installed", false, loaded, false, false, "Periodic background sync is not installed.");
    if (!managedDefinition(definition)) return health("conflict", true, loaded, false, false, "The Burnbook task definition is unmanaged.");
    const current = definition === expected;
    return current && loaded
      ? health("installed", true, true, true, true, "Periodic background sync is loaded and current.")
      : health("needs-repair", true, loaded, true, current, "The current-user task needs repair.");
  }

  async function install(): Promise<BackgroundServiceChange> {
    await fs.mkdir(options.configDir, { recursive: true });
    const existing = await readDefinition();
    if (existing && !managedDefinition(existing)) throw new Error("Refusing to replace an unmanaged task definition.");
    await atomicWrite(definitionPath, expected);
    const result = await options.run(options.managerExecutable, ["/Create", "/F", "/TN", BURNBOOK_WINDOWS_TASK, "/XML", definitionPath]);
    if (result.code !== 0) throw new Error(`Could not install the Burnbook task: ${result.stderr || result.stdout}`);
    return { changed: existing !== expected, detail: existing === expected ? "Periodic background sync is already installed." : "Installed periodic background sync." };
  }

  async function trigger(): Promise<boolean> {
    return (await options.run(options.managerExecutable, ["/Run", "/TN", BURNBOOK_WINDOWS_TASK])).code === 0;
  }

  async function remove(): Promise<BackgroundServiceChange> {
    const existing = await readDefinition();
    if (!existing) return { changed: false, detail: "Periodic background sync is not installed." };
    if (!managedDefinition(existing)) throw new Error("Refusing to remove an unmanaged task definition.");
    const result = await options.run(options.managerExecutable, ["/Delete", "/F", "/TN", BURNBOOK_WINDOWS_TASK]);
    if (result.code !== 0 && !/cannot find/i.test(result.stderr)) throw new Error("Could not remove the Burnbook task.");
    await fs.unlink(definitionPath);
    return { changed: true, detail: "Removed periodic background sync." };
  }

  async function readDefinition(): Promise<string | undefined> {
    try {
      const stat = await fs.lstat(definitionPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return "unmanaged";
      return await fs.readFile(definitionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  return { install, inspect, trigger, remove };
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

function health(
  state: BackgroundServiceHealth["state"], installed: boolean, loaded: boolean,
  managed: boolean, current: boolean, detail: string,
): BackgroundServiceHealth {
  return { state, installed, loaded, managed, current, detail };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function managedDefinition(value: string): boolean {
  return value.slice(0, 256).includes(MARKER);
}
