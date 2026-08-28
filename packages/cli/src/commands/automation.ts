import { configDir } from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { DEFAULT_API_ORIGIN } from "../core/api.js";
import {
  resolveBackgroundService,
  type BackgroundService,
  type BackgroundServiceResolution,
} from "../platform/index.js";
import { runInit } from "./init.js";
import {
  backgroundReady,
  loadBackgroundState,
  saveBackgroundState,
} from "../core/background-state.js";

export interface AutomationStepResult {
  code: number;
  changed: boolean;
}

export interface AutomationOptions {
  remove?: boolean;
  configureHooks?: (remove: boolean) => Promise<number | AutomationStepResult>;
  resolveService?: () => Promise<BackgroundServiceResolution>;
  resetBackgroundState?: () => Promise<void>;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export async function runAutomation(options: AutomationOptions = {}): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog = options.errorLog ?? ((message: string) => console.error(message));
  const configureHooks = options.configureHooks ?? defaultHookConfiguration(errorLog);
  const resolveService = options.resolveService ?? (async () => {
    const config = await loadConfig();
    return resolveBackgroundService({
      configDir: configDir(),
      apiOrigin: config?.apiOrigin ?? DEFAULT_API_ORIGIN,
    });
  });
  const resetBackgroundState = options.resetBackgroundState ?? (async () => {
    await saveBackgroundState(backgroundReady(await loadBackgroundState()));
  });

  if (options.remove) return removeAutomation(configureHooks, resolveService, log, errorLog);
  return installAutomation(configureHooks, resolveService, resetBackgroundState, log, errorLog);
}

async function installAutomation(
  configureHooks: NonNullable<AutomationOptions["configureHooks"]>,
  resolveService: () => Promise<BackgroundServiceResolution>,
  resetBackgroundState: NonNullable<AutomationOptions["resetBackgroundState"]>,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  let hooks: AutomationStepResult;
  try {
    hooks = normalizeStep(await configureHooks(false));
  } catch {
    errorLog("Claude hook setup failed without enabling automatic sync.");
    return 1;
  }
  if (hooks.code !== 0) {
    const rollbackFailed = hooks.changed
      ? normalizeStep(await configureHooks(true).catch(() => ({ code: 1, changed: false }))).code !== 0
      : false;
    errorLog(
      rollbackFailed
        ? "Claude hook setup failed and rollback needs repair. Run `burn doctor`."
        : "Claude hook setup failed without enabling automatic sync.",
    );
    return 1;
  }

  let service: BackgroundService | undefined;
  let serviceChanged = false;
  try {
    const resolution = await resolveService();
    if (!resolution.supported) {
      log("Claude hooks are configured. Periodic sync is not yet supported on this platform.");
      return 0;
    }
    service = resolution.service;
    serviceChanged = (await service.install()).changed;
    await resetBackgroundState();
    if (!await service.trigger()) throw new Error("initial-trigger-failed");
    log("Automatic sync is enabled. Completed Claude and Codex usage will sync about every 60 seconds.");
    return 0;
  } catch (error) {
    const rollbackFailed = await rollbackInstall({
      configureHooks,
      hooksChanged: hooks.changed,
      service,
      serviceChanged,
    });
    errorLog(
      rollbackFailed
        ? "Automatic sync setup failed and rollback needs repair. Run `burn doctor`."
        : automationError(error),
    );
    return 1;
  }
}

async function rollbackInstall(options: {
  configureHooks: NonNullable<AutomationOptions["configureHooks"]>;
  hooksChanged: boolean;
  service?: BackgroundService;
  serviceChanged: boolean;
}): Promise<boolean> {
  let failed = false;
  if (options.service && options.serviceChanged) {
    try { await options.service.remove(); } catch { failed = true; }
  }
  if (options.hooksChanged) {
    try {
      if (normalizeStep(await options.configureHooks(true)).code !== 0) failed = true;
    } catch {
      failed = true;
    }
  }
  return failed;
}

async function removeAutomation(
  configureHooks: NonNullable<AutomationOptions["configureHooks"]>,
  resolveService: () => Promise<BackgroundServiceResolution>,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  let failed = false;
  try {
    const resolution = await resolveService();
    if (resolution.supported) await resolution.service.remove();
  } catch {
    failed = true;
    errorLog("Automatic sync could not be removed safely.");
  }

  try {
    const hooks = normalizeStep(await configureHooks(true));
    if (hooks.code !== 0) {
      failed = true;
      errorLog("Claude hooks could not be removed safely.");
    }
  } catch {
    failed = true;
    errorLog("Claude hooks could not be removed safely.");
  }
  if (!failed) log("Burnbook automation was removed. Login, cursors, and queued usage were preserved.");
  return failed ? 1 : 0;
}

function defaultHookConfiguration(
  errorLog: (message: string) => void,
): NonNullable<AutomationOptions["configureHooks"]> {
  return async (remove) => {
    let changed = false;
    const code = await runInit({
      remove,
      log: () => {},
      errorLog,
      onChange: (value) => { changed = value; },
    });
    return { code, changed };
  };
}

function normalizeStep(result: number | AutomationStepResult): AutomationStepResult {
  return typeof result === "number"
    ? { code: result, changed: result === 0 }
    : result;
}

function automationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("transient")) {
    return "Automatic sync needs a stable install. Run `npm install -g burnbook`, then `burn repair`.";
  }
  return "Automatic sync setup failed. Run `burn doctor`, then `burn repair`.";
}
