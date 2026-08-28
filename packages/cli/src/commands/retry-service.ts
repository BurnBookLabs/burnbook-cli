import { loadConfig, type CliConfig } from "../core/config.js";
import {
  manageRetryService,
  type RetryServiceAction,
  type RetryServiceRuntime,
} from "../core/retry-service.js";
import { DEFAULT_API_ORIGIN } from "../core/api.js";

const ACTIONS = new Set<RetryServiceAction>(["install", "status", "remove"]);

export interface RetryServiceCommandOptions {
  action: string;
  intervalSeconds?: number;
  maxBatches?: number;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  runtime?: Partial<RetryServiceCommandRuntime>;
}

interface RetryServiceCommandRuntime {
  loadConfig: () => Promise<CliConfig | undefined>;
  manage: (
    action: RetryServiceAction,
    settings: { intervalSeconds: number; maxBatches: number },
    apiOrigin: string,
  ) => Promise<{ exitCode: number; message: string }>;
}

const DEFAULT_RUNTIME: RetryServiceCommandRuntime = {
  loadConfig,
  manage: (action, settings, apiOrigin) => manageRetryService(action, settings, { apiOrigin }),
};

export async function runRetryServiceCommand(
  options: RetryServiceCommandOptions,
): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  if (!isRetryServiceAction(options.action)) {
    errorLog("action must be install, status, or remove");
    return 1;
  }

  const settings = {
    intervalSeconds: options.intervalSeconds ?? 60,
    maxBatches: options.maxBatches ?? 4,
  };
  if (!validInterval(settings.intervalSeconds)) {
    errorLog("interval must be an integer between 10 and 3600 seconds");
    return 1;
  }
  if (!validBatchCount(settings.maxBatches)) {
    errorLog("max-batches must be an integer between 1 and 20");
    return 1;
  }

  const runtime = { ...DEFAULT_RUNTIME, ...options.runtime };
  const config = await runtime.loadConfig();
  if (options.action === "install" && !config) {
    errorLog("Not logged in. Run `burn login` before installing the retry service.");
    return 1;
  }

  try {
    const result = await runtime.manage(
      options.action,
      settings,
      config?.apiOrigin ?? DEFAULT_API_ORIGIN,
    );
    (result.exitCode === 0 ? log : errorLog)(result.message);
    return result.exitCode;
  } catch (error) {
    errorLog(error instanceof Error ? error.message : "retry service operation failed");
    return 1;
  }
}

export function createRetryServiceManager(
  runtime: Partial<RetryServiceRuntime>,
): RetryServiceCommandRuntime["manage"] {
  return (action, settings, apiOrigin) => manageRetryService(action, settings, {
    ...runtime,
    apiOrigin,
  });
}

function isRetryServiceAction(value: string): value is RetryServiceAction {
  return ACTIONS.has(value as RetryServiceAction);
}

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10 && value <= 3600;
}

function validBatchCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 20;
}
