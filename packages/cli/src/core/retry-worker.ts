import type { RetryProcessorResult } from "./retry-processor.js";

const MIN_DELAY_MS = 1_000;
const ERROR_BACKOFF_BASE_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;

export interface RetryWorkerLoopOptions {
  runPass: () => Promise<RetryProcessorResult>;
  once?: boolean;
  intervalMs: number;
  signal: AbortSignal;
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export interface RetryWorkerLoopResult {
  passes: number;
  failedPasses: number;
  stopped: "once" | "signal";
}

/** Run foreground upload passes until --once completes or a shutdown signal arrives. */
export async function runRetryWorkerLoop(
  options: RetryWorkerLoopOptions,
): Promise<RetryWorkerLoopResult> {
  assertInterval(options.intervalMs);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog = options.errorLog ?? ((message: string) => console.error(message));
  let passes = 0;
  let failedPasses = 0;
  let consecutiveErrors = 0;

  while (!options.signal.aborted) {
    let waitMs = options.intervalMs;
    try {
      const result = await options.runPass();
      passes += 1;
      consecutiveErrors = 0;
      log(formatPassSummary(result));
      waitMs = nextDelay(result.nextAttemptAt, now(), options.intervalMs);
    } catch {
      passes += 1;
      failedPasses += 1;
      consecutiveErrors += 1;
      errorLog("retry worker pass failed locally; no evidence details were logged");
      waitMs = errorDelay(consecutiveErrors, random());
    }

    if (options.once) return { passes, failedPasses, stopped: "once" };
    if (options.signal.aborted) break;
    await sleep(waitMs, options.signal);
  }

  return { passes, failedPasses, stopped: "signal" };
}

function formatPassSummary(result: RetryProcessorResult): string {
  return [
    "retry worker pass:",
    `${result.accepted} accepted,`,
    `${result.duplicates} duplicates,`,
    `${result.failedBatches} failed batch(es),`,
    `${result.quarantined} quarantined event(s),`,
    `${result.deferredBatches} deferred batch(es)`,
  ].join(" ");
}

function nextDelay(nextAttemptAt: string | undefined, now: number, intervalMs: number): number {
  if (!nextAttemptAt) return intervalMs;
  const untilRetry = Date.parse(nextAttemptAt) - now;
  if (!Number.isFinite(untilRetry)) return intervalMs;
  return Math.max(MIN_DELAY_MS, Math.min(intervalMs, untilRetry));
}

function errorDelay(consecutiveErrors: number, random: number): number {
  const exponential = Math.min(
    ERROR_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveErrors - 1, 8),
    ERROR_BACKOFF_MAX_MS,
  );
  const boundedRandom = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
  return Math.round(exponential * (0.8 + 0.2 * boundedRandom));
}

function assertInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 60 * 60_000) {
    throw new Error("interval must be between 10 and 3600 seconds");
  }
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
