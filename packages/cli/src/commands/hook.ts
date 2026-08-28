import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  backgroundAttempt,
  backgroundFailure,
  backgroundSuccess,
  loadBackgroundState,
  saveBackgroundState,
  type BackgroundFailureKind,
  type BackgroundState,
} from "../core/background-state.js";
import { runSync } from "./sync.js";

export interface EnqueueSyncOptions {
  spawnWorker?: () => void;
  /** Retained for source compatibility; assistant hooks never trigger the upload service. */
  triggerService?: () => Promise<boolean>;
}

export interface WorkerLaunch {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: true;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: "ignore";
  };
}

export function sanitizedWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

export function createWorkerLaunch(
  entry = process.argv[1],
  runtime = process.execPath,
  environment = process.env,
  home = os.homedir(),
): WorkerLaunch {
  if (!entry) throw new Error("Burnbook executable path is unavailable.");
  const resolvedEntry = realpathSync(entry);
  if (!path.isAbsolute(runtime) || !path.isAbsolute(resolvedEntry)) {
    throw new Error("Burnbook worker paths must be absolute.");
  }
  return {
    command: runtime,
    args: [resolvedEntry, "collect-worker"],
    options: {
      cwd: home,
      detached: true,
      env: sanitizedWorkerEnvironment(environment),
      shell: false,
      stdio: "ignore",
    },
  };
}

function spawnDetachedWorker(): void {
  const launch = createWorkerLaunch();
  const child = spawn(launch.command, launch.args, launch.options);
  child.once("error", () => {});
  child.unref();
}

export async function enqueueSync(opts: EnqueueSyncOptions = {}): Promise<boolean> {
  (opts.spawnWorker ?? spawnDetachedWorker)();
  return true;
}

export interface CollectWorkerOptions {
  sync?: typeof runSync;
}

/** Detached assistant-hook worker: local collection only, with no delivery capability. */
export async function runCollectWorker(options: CollectWorkerOptions = {}): Promise<number> {
  return (options.sync ?? runSync)({ quiet: true, background: true, deliver: false });
}

export interface SyncWorkerOptions {
  now?: () => Date;
  sync?: typeof runSync;
  loadState?: () => Promise<BackgroundState | undefined>;
  saveState?: (state: BackgroundState) => Promise<void>;
}

export async function runSyncWorker(options: SyncWorkerOptions = {}): Promise<number> {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  const now = options.now ?? (() => new Date());
  const sync = options.sync ?? runSync;
  const loadState = options.loadState ?? loadBackgroundState;
  const saveState = options.saveState ?? saveBackgroundState;
  const previous = await loadState();
  const startedAt = now();
  const paused = deliveryIsPaused(previous, startedAt);

  if (paused) {
    await sync({ quiet: true, background: true, deliver: false });
    return 0;
  }

  await saveState(backgroundAttempt(previous, startedAt));
  let failureKind: BackgroundFailureKind | undefined;
  let retryAfterSeconds: number | undefined;
  const code = await sync({
    quiet: true,
    background: true,
    onFailure: (kind, retryAfter) => {
      failureKind ??= kind;
      retryAfterSeconds ??= retryAfter;
    },
  });
  const finishedAt = now();
  if (code === 0) {
    await saveState(backgroundSuccess(await loadState(), finishedAt));
    return 0;
  }

  const current = await loadState();
  const kind = failureKind ?? "unknown";
  const nextAttempt = kind === "authentication"
    ? undefined
    : new Date(finishedAt.getTime() + backoffMs(current, kind, retryAfterSeconds));
  await saveState(backgroundFailure(current, kind, finishedAt, nextAttempt));
  return code;
}

function deliveryIsPaused(state: BackgroundState | undefined, now: Date): boolean {
  if (state?.status === "authentication-required") return true;
  if (!state?.nextAttemptAt) return false;
  return Date.parse(state.nextAttemptAt) > now.getTime();
}

function backoffMs(
  state: BackgroundState | undefined,
  kind: BackgroundFailureKind,
  retryAfterSeconds?: number,
): number {
  if (kind === "rate-limited" && retryAfterSeconds !== undefined) {
    return Math.min(60 * 60 * 1000, Math.max(60_000, retryAfterSeconds * 1000));
  }
  const base = kind === "local-io" ? 5 * 60_000 : 60_000;
  return Math.min(60 * 60 * 1000, base * 2 ** Math.min(state?.failureCount ?? 0, 6));
}
