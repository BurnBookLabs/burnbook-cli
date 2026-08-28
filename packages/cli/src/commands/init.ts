import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { claudeDir } from "../core/paths.js";

const LEGACY_COMMANDS = new Set([
  "burn hook",
  "burn sync --quiet",
  "burn collect --agent claude-code --quiet",
  "burnbook hook",
]);

/** Claude Code events we hook: one run at the end of every turn, one at session end. */
const HOOK_EVENTS = ["Stop", "SessionEnd"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: unknown;
  [key: string]: unknown;
}

/** Loosely-typed on-disk shape: we only ever touch `hooks`, everything else passes through untouched. */
type Settings = Record<string, unknown>;

export interface InitOptions {
  /** Uninstall our hooks instead of installing them. */
  remove?: boolean;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  onChange?: (changed: boolean) => void;
  hookCommand?: string;
}

function settingsFilePath(): string {
  return path.join(claudeDir(), "settings.json");
}

interface LoadedSettings {
  /** False when the file didn't exist — treated as `{}`, and never gets a `.bak`. */
  existed: boolean;
  /** Raw pre-modify file content, used verbatim as the `.bak` payload. */
  raw: string;
  settings: Settings;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/* Read and parse `filePath`. */
async function loadSettings(filePath: string): Promise<LoadedSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { existed: false, raw: "", settings: {} };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${filePath} contains invalid JSON — aborting without changes.`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON object — aborting without changes.`);
  }

  const settings = parsed as Settings;
  if ("hooks" in settings && asHooksSection(settings.hooks) === undefined) {
    throw new Error(`${filePath}'s "hooks" key is not an object — aborting without changes.`);
  }

  return { existed: true, raw, settings };
}

async function writeOwnerOnly(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(tmpPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    try { await fs.unlink(tmpPath); } catch { /* best effort */ }
    throw error;
  }
}

async function writeSettings(filePath: string, loaded: LoadedSettings, newContent: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (loaded.existed) {
    await writeOwnerOnly(`${filePath}.bak`, loaded.raw);
  }
  await writeOwnerOnly(filePath, newContent);
}

function asHooksSection(value: unknown): Record<string, HookGroup[]> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, HookGroup[]>;
  }
  return undefined;
}

function groupHasOurCommand(group: HookGroup, command: string): boolean {
  return Array.isArray(group.hooks) && group.hooks.some((h: HookEntry) => h && h.command === command);
}

function withoutLegacyCommands(group: HookGroup): { group: HookGroup; changed: boolean } {
  if (!Array.isArray(group.hooks)) return { group, changed: false };
  const hooks = group.hooks.filter((hook: HookEntry) => !(hook && LEGACY_COMMANDS.has(String(hook.command))));
  return { group: { ...group, hooks }, changed: hooks.length !== group.hooks.length };
}

/** Mutates `settings.hooks[event]` in place, appending our group where absent. */
function install(settings: Settings, command: string): { changed: boolean; installedEvents: HookEvent[] } {
  const hooks = asHooksSection(settings.hooks) ?? {};
  const installedEvents: HookEvent[] = [];

  for (const event of HOOK_EVENTS) {
    // If hooks[event] exists but is not an array, abort just like loadSettings would.
    if (event in hooks && !Array.isArray(hooks[event])) {
      throw new Error(`settings.json's "hooks.${event}" is not an array — aborting without changes.`);
    }

    let groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    let changed = false;
    groups = groups.flatMap((group) => {
      const migrated = withoutLegacyCommands(group);
      changed ||= migrated.changed;
      return Array.isArray(migrated.group.hooks) && migrated.group.hooks.length === 0 ? [] : [migrated.group];
    });

    if (groups.some((group) => groupHasOurCommand(group, command))) {
      if (changed) {
        hooks[event] = groups;
        installedEvents.push(event);
      }
      continue;
    }

    hooks[event] = [...groups, { hooks: [{ type: "command", command }] }];
    installedEvents.push(event);
  }

  if (installedEvents.length > 0) {
    settings.hooks = hooks;
  }

  return { changed: installedEvents.length > 0, installedEvents };
}

/* Mutates `settings.hooks` in place, removing exactly our command entries. */
function remove(settings: Settings, command: string): { changed: boolean; removedEvents: HookEvent[] } {
  const managedCommands = new Set([command, ...LEGACY_COMMANDS]);
  const hooks = asHooksSection(settings.hooks);
  const removedEvents: HookEvent[] = [];
  if (!hooks) {
    return { changed: false, removedEvents };
  }

  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;

    let removedFromThisEvent = false;
    const keptGroups: HookGroup[] = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((h: HookEntry) => !(h && managedCommands.has(String(h.command))));
      if (keptHooks.length !== group.hooks.length) {
        removedFromThisEvent = true;
      }
      if (keptHooks.length === 0) {
        // We emptied this matcher-group — drop it rather than leave `{hooks: []}` behind.
        continue;
      }
      keptGroups.push({ ...group, hooks: keptHooks });
    }

    if (removedFromThisEvent) {
      removedEvents.push(event);
      if (keptGroups.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = keptGroups;
      }
    }
  }

  if (removedEvents.length === 0) {
    return { changed: false, removedEvents };
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  return { changed: true, removedEvents };
}

/* Repair or remove Burnbook's automatic Claude Code hooks. */
export async function runInit(opts: InitOptions = {}): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const errorLog = opts.errorLog ?? ((message: string) => console.error(message));

  let hookCommand: string;
  try {
    hookCommand = opts.hookCommand ?? await absoluteHookCommand();
  } catch (err) {
    errorLog(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const filePath = settingsFilePath();
  let loaded: LoadedSettings;
  try {
    loaded = await loadSettings(filePath);
  } catch (err) {
    errorLog(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (opts.remove) {
    const { changed, removedEvents } = remove(loaded.settings, hookCommand);
    if (!changed) {
      opts.onChange?.(false);
      log("nothing to remove");
      return 0;
    }
    await writeSettings(filePath, loaded, JSON.stringify(loaded.settings, null, 2));
    opts.onChange?.(true);
    log("removed");
    return 0;
  }

  let result: { changed: boolean; installedEvents: HookEvent[] };
  try {
    result = install(loaded.settings, hookCommand);
  } catch (err) {
    errorLog(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!result.changed) {
    opts.onChange?.(false);
    log("already installed");
    return 0;
  }
  await writeSettings(filePath, loaded, JSON.stringify(loaded.settings, null, 2));
  opts.onChange?.(true);
  log(
    result.installedEvents.length === HOOK_EVENTS.length
      ? "installed Stop + SessionEnd hooks"
      : `installed ${result.installedEvents.join(" + ")} hook${result.installedEvents.length > 1 ? "s" : ""}`,
  );
  return 0;
}

async function absoluteHookCommand(): Promise<string> {
  const entry = process.argv[1];
  if (!entry) throw new Error("Burnbook's executable path is unavailable.");
  const nodePath = await fs.realpath(path.resolve(process.execPath));
  const burnbookPath = await fs.realpath(path.resolve(entry));
  return `${shellArgument(nodePath)} ${shellArgument(burnbookPath)} hook`;
}

function shellArgument(value: string): string {
  if (/\0|\r|\n/.test(value)) throw new Error("Burnbook hook paths contain invalid characters.");
  if (process.platform === "win32") {
    if (value.includes('"')) throw new Error("Burnbook hook paths contain invalid characters.");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
