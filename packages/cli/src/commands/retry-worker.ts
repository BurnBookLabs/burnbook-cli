import { loadConfig, type CliConfig } from "../core/config.js";
import { runRetryWorkerLoop } from "../core/retry-worker.js";
import { acquireUploadLease, type UploadLease } from "../core/upload-lease.js";
import { uploadPendingEvidence, uploadPendingEvidenceV3 } from "./sync.js";
import type { RetryProcessorResult } from "../core/retry-processor.js";

export interface RetryWorkerOptions {
  once?: boolean;
  intervalSeconds?: number;
  maxBatches?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  runtime?: Partial<RetryWorkerRuntime>;
}

interface RetryWorkerRuntime {
  loadConfig: () => Promise<CliConfig | undefined>;
  acquireLease: () => Promise<UploadLease | undefined>;
  upload: typeof uploadAllEvidence;
}

const DEFAULT_RUNTIME: RetryWorkerRuntime = {
  loadConfig,
  acquireLease: acquireUploadLease,
  upload: uploadAllEvidence,
};

async function uploadAllEvidence(
  config: CliConfig,
  options: Parameters<typeof uploadPendingEvidence>[1],
): Promise<RetryProcessorResult> {
  const legacy = await uploadPendingEvidence(config, options);
  const current = await uploadPendingEvidenceV3(config, options);
  const next = [legacy.nextAttemptAt, current.nextAttemptAt].filter((value): value is string => Boolean(value)).sort()[0];
  return {
    accepted: legacy.accepted + current.accepted,
    duplicates: legacy.duplicates + current.duplicates,
    failedBatches: legacy.failedBatches + current.failedBatches,
    quarantined: legacy.quarantined + current.quarantined,
    deferredBatches: legacy.deferredBatches + current.deferredBatches,
    ...(next ? { nextAttemptAt: next } : {}),
  };
}

/** Run the explicit foreground uploader. It never discovers or reads agent source files. */
export async function runRetryWorker(options: RetryWorkerOptions = {}): Promise<number> {
  const errorLog = options.errorLog ?? console.error;
  const intervalSeconds = options.intervalSeconds ?? 60;
  const maxBatches = options.maxBatches ?? 4;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) {
    errorLog("interval must be an integer between 10 and 3600 seconds");
    return 1;
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) {
    errorLog("max-batches must be an integer between 1 and 20");
    return 1;
  }

  const runtime = { ...DEFAULT_RUNTIME, ...options.runtime };
  if (!await runtime.loadConfig()) {
    errorLog("Not logged in. Run `burn login` first.");
    return 1;
  }
  const lease = await runtime.acquireLease();
  if (!lease) {
    errorLog("another Burnbook upload worker is already active");
    return 1;
  }

  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const shutdown = (): void => controller?.abort();
  if (controller) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  try {
    (options.log ?? console.log)(
      "retry worker started in the foreground; it uploads only sanitized evidence already in the spool",
    );
    const result = await runRetryWorkerLoop({
      once: options.once,
      intervalMs: intervalSeconds * 1000,
      signal,
      log: options.log,
      errorLog: options.errorLog,
      runPass: async () => {
        const config = await runtime.loadConfig();
        if (!config) throw new Error("device authorization is unavailable");
        return runtime.upload(config, { maxBatches, signal });
      },
    });
    return result.failedPasses > 0 ? 1 : 0;
  } finally {
    if (controller) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
    await lease.release();
  }
}
