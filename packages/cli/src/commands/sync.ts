import * as path from "node:path";
import type {
  SyncPayload,
  SyncPayloadV2,
  SyncPayloadV3,
  UsageEvidenceV2,
  UsageEvidenceV3,
  UsageTuple,
} from "@burnbook/schema";
import { discoverTranscripts, parseTranscript } from "../adapters/claude-code.js";
import { runCollect } from "./collect.js";
import { ApiError, ApiResponseError, postSync, postSyncV2, postSyncV3 } from "../core/api.js";
import type { BackgroundFailureKind } from "../core/background-state.js";
import { loadConfig, type CliConfig } from "../core/config.js";
import { signPayload } from "../core/keys.js";
import { loadState, saveState, type StoredCursor } from "../core/state.js";
import { readPendingEvidence } from "../core/spool.js";
import {
  processEvidenceSpoolRetries,
  type RetryProcessorResult,
} from "../core/retry-processor.js";
import { acquireUploadLease } from "../core/upload-lease.js";
import { acquireSyncLock } from "../core/sync-lock.js";
import { CLI_PACKAGE_VERSION } from "../version.js";
import {
  acknowledgeEvidenceV3,
  readPendingEvidenceV3Window,
  readRetryScheduleV3,
  recordDeliveryQuarantineV3,
  writeRetryScheduleV3,
  inspectSpoolV3,
} from "../core/spool-v3.js";

const MAX_SESSIONS_PER_PAYLOAD = 200;
const MAX_MESSAGES_PER_SESSION = 5000;
const MAX_MESSAGES_PER_PAYLOAD = 5000;
/** Operational batch-size target only. A single larger record is still sent and is never rejected for volume. */
const MAX_TOKENS_PER_PAYLOAD = 1_500_000_000;

export interface SyncOptions {
  /** Suppress all output and always exit 0 — for hook safety, never break a Claude session. */
  quiet?: boolean;
  /** discoverTranscripts root override. Tests must always pass an explicit tmpdir here. */
  root?: string;
  /** Skip delivery after durable local collection. */
  deliver?: boolean;
  /** Report failures to the detached worker instead of forcing hook-safe exit zero. */
  background?: boolean;
  onFailure?: (kind: BackgroundFailureKind, retryAfterSeconds?: number) => void;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

/** One chunk (≤5000 tuples, ≤MAX_TOKENS_PER_PAYLOAD tokens) of one file's new tuples, ready to go into a sync payload. `tokens` is the precomputed sum of this chunk's own tuples' token counts, so wave assembly doesn't have to re-walk `messages` for every batching decision. */
interface FileChunk {
  filePath: string;
  sessionId: string;
  messages: UsageTuple[];
  tokens: number;
}

function tupleTokens(t: UsageTuple): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

/** Greedily packs `items` into groups, starting a new group whenever adding the next item would push the running group past `maxCount` items or `maxTokens` total (per `tokensOf`). A single item that alone exceeds `maxTokens` still gets its own group rather than being dropped or looping forever — the budget is a batching target, not a hard per-item limit. */
function batchByBudget<T>(
  items: readonly T[],
  maxCount: number,
  maxTokens: number,
  tokensOf: (item: T) => number,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  for (const item of items) {
    const tokens = tokensOf(item);
    const wouldExceedCount = current.length + 1 > maxCount;
    const wouldExceedTokens = current.length > 0 && currentTokens + tokens > maxTokens;
    if (current.length > 0 && (wouldExceedCount || wouldExceedTokens)) {
      out.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function batchFileChunks(items: readonly FileChunk[]): FileChunk[][] {
  const batches: FileChunk[][] = [];
  let current: FileChunk[] = [];
  let tokens = 0;
  let messages = 0;
  for (const item of items) {
    const exceeds =
      current.length >= MAX_SESSIONS_PER_PAYLOAD ||
      messages + item.messages.length > MAX_MESSAGES_PER_PAYLOAD ||
      (current.length > 0 && tokens + item.tokens > MAX_TOKENS_PER_PAYLOAD);
    if (exceeds && current.length > 0) {
      batches.push(current);
      current = [];
      tokens = 0;
      messages = 0;
    }
    current.push(item);
    tokens += item.tokens;
    messages += item.messages.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Collect locally first, then upload from the durable Evidence V2 spool when requested. */
export async function runSync(opts: SyncOptions = {}): Promise<number> {
  const quiet = opts.quiet ?? false;
  const log = opts.log ?? ((message: string) => console.log(message));
  const errorLog = opts.errorLog ?? ((message: string) => console.error(message));
  const shouldDeliver = opts.deliver ?? (!quiet || opts.background === true);
  let lock: Awaited<ReturnType<typeof acquireSyncLock>> = undefined;

  try {
    lock = await acquireSyncLock();
    if (!lock) {
      if (!quiet) log("sync already running in the background");
      return 0;
    }
    await collectForSync(opts);
    if (!shouldDeliver) return 0;

    const config = await loadConfig();
    if (!config) {
      opts.onFailure?.("authentication");
      if (!quiet) errorLog("Not logged in. Run `burn login` first.");
      return quiet && !opts.background ? 0 : 1;
    }
    const pending = await readPendingEvidence(1);
    const pendingV3 = await inspectSpoolV3();
    if (pending.evidence.length === 0 && pendingV3.pending === 0) {
      if (!quiet) log("synced 0 new events (0 duplicates)");
      return 0;
    }
    return await syncV2(config, opts, quiet);
  } catch (error) {
    const failure = classifySyncFailure(error);
    opts.onFailure?.(failure.kind, failure.retryAfterSeconds);
    if (!quiet) errorLog(`sync failed: ${syncErrorCategory(error)}`);
    return quiet && !opts.background ? 0 : 1;
  } finally {
    await lock?.release();
  }
}

async function collectForSync(opts: SyncOptions): Promise<void> {
  const agents = opts.root
    ? (["claude-code"] as const)
    : (["claude-code", "codex", "gemini-cli"] as const);
  for (const agent of agents) {
    await runCollect({
      agent,
      ...(agent === "claude-code" && opts.root ? { root: opts.root } : {}),
      quiet: true,
      lockHeld: true,
    });
  }
}

/** Test harness preserving the already-published V1 client behavior. */
export async function runLegacySync(opts: SyncOptions = {}): Promise<number> {
  const quiet = opts.quiet ?? false;
  const errorLog = opts.errorLog ?? ((message: string) => console.error(message));

  const config = await loadConfig();
  if (!config) {
    opts.onFailure?.("authentication");
    if (quiet) return opts.background ? 1 : 0;
    errorLog("Not logged in. Run `burn login` first.");
    return 1;
  }

  try {
    return await doSync(config, opts, quiet);
  } catch (err) {
    const failure = classifySyncFailure(err);
    opts.onFailure?.(failure.kind, failure.retryAfterSeconds);
    if (quiet) {
      // In quiet mode, swallow API and network errors silently.
      // But for unexpected local errors, surface them once for debugging.
      if (err instanceof ApiError) {
        return opts.background ? 1 : 0;
      }
      if (err instanceof TypeError) {
        // Network-level fetch failures.
        return opts.background ? 1 : 0;
      }
      // Unexpected error type — log once and exit 0 to not break the hook.
      errorLog(`burn sync: ${syncErrorCategory(err)} (run 'burn doctor' for local diagnostics)`);
      return opts.background ? 1 : 0;
    }
    errorLog(`sync failed: ${syncErrorCategory(err)}`);
    return 1;
  }
}

async function syncV2(
  config: CliConfig,
  opts: SyncOptions,
  quiet: boolean,
): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const lease = await acquireUploadLease();
  if (!lease) {
    if (!quiet) log("another Burnbook upload is already active; pending evidence remains local");
    return 0;
  }
  let result: RetryProcessorResult;
  try {
    const legacy = await uploadPendingEvidence(config, {
      force: true,
      onFailure: opts.onFailure,
    });
    const current = await uploadPendingEvidenceV3(config, {
      force: true,
      onFailure: opts.onFailure,
    });
    result = combineRetryResults(legacy, current);
  } finally {
    await lease.release();
  }

  if (!quiet) {
    const summary = `synced ${result.accepted} new events (${result.duplicates} duplicates)`;
    log(
      result.failedBatches > 0
        ? `${summary}; ${result.failedBatches} batch(es) failed — retry metadata saved locally`
        : summary,
    );
  }
  if (quiet && !opts.background) return 0;
  return result.failedBatches > 0 ? 1 : 0;
}

function combineRetryResults(left: RetryProcessorResult, right: RetryProcessorResult): RetryProcessorResult {
  const attempts = [left.nextAttemptAt, right.nextAttemptAt].filter((value): value is string => Boolean(value)).sort();
  return {
    accepted: left.accepted + right.accepted,
    duplicates: left.duplicates + right.duplicates,
    failedBatches: left.failedBatches + right.failedBatches,
    quarantined: left.quarantined + right.quarantined,
    deferredBatches: left.deferredBatches + right.deferredBatches,
    ...(attempts[0] ? { nextAttemptAt: attempts[0] } : {}),
  };
}

export interface UploadPendingEvidenceOptions {
  force?: boolean;
  maxBatches?: number;
  signal?: AbortSignal;
  onFailure?: (kind: BackgroundFailureKind, retryAfterSeconds?: number) => void;
}

/** Upload only evidence already in the spool. Collection is deliberately separate. */
export async function uploadPendingEvidence(
  config: CliConfig,
  options: UploadPendingEvidenceOptions = {},
): Promise<RetryProcessorResult> {
  return processEvidenceSpoolRetries({
    force: options.force,
    maxBatches: options.maxBatches,
    uploadBatch: async (batch) => {
      const payload: SyncPayloadV2 = {
        schemaVersion: 2,
        clientVersion: CLI_PACKAGE_VERSION,
        deviceId: config.deviceId,
        sentAt: new Date().toISOString(),
        evidence: [...batch] as UsageEvidenceV2[],
      };
      const envelope = await signPayload(payload);
      try {
        const timeout = AbortSignal.timeout(30_000);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeout])
          : timeout;
        const response = await postSyncV2(config.apiOrigin, config.deviceToken, envelope, signal);
        return { status: "success" as const, response };
      } catch (error) {
        const failure = classifySyncFailure(error);
        options.onFailure?.(failure.kind, failure.retryAfterSeconds);
        if (error instanceof ApiError) {
          if (error.status === 400 || error.status === 422) {
            return { status: "permanent" as const, reason: "permanent_rejection" as const };
          }
          const retryAfterMs = error.retryAfterSeconds === undefined
            ? undefined
            : Math.min(Math.max(0, error.retryAfterSeconds * 1000), 60 * 60_000);
          return { status: "retry" as const, retryAfterMs };
        }
        if (error instanceof ApiResponseError || error instanceof TypeError || isAbortError(error)) {
          return { status: "retry" as const };
        }
        throw error;
      }
    },
  });
}

export async function uploadPendingEvidenceV3(
  config: CliConfig,
  options: UploadPendingEvidenceOptions = {},
): Promise<RetryProcessorResult> {
  return processEvidenceSpoolRetries({
    force: options.force,
    maxBatches: options.maxBatches,
    spool: {
      readWindow: async (limit) => readPendingEvidenceV3Window(limit),
      acknowledge: async (records) => acknowledgeEvidenceV3(records as UsageEvidenceV3[]),
      quarantine: async (records, code, digest) => recordDeliveryQuarantineV3(records as UsageEvidenceV3[], code, digest),
      readSchedule: readRetryScheduleV3,
      writeSchedule: writeRetryScheduleV3,
    },
    uploadBatch: async (batch) => {
      const payload: SyncPayloadV3 = {
        schemaVersion: 3,
        clientVersion: CLI_PACKAGE_VERSION,
        deviceId: config.deviceId,
        sentAt: new Date().toISOString(),
        evidence: [...batch] as UsageEvidenceV3[],
      };
      try {
        const response = await postSyncV3(
          config.apiOrigin,
          config.deviceToken,
          await signPayload(payload),
          options.signal,
        );
        return { status: "success" as const, response };
      } catch (error) {
        const failure = classifySyncFailure(error);
        options.onFailure?.(failure.kind, failure.retryAfterSeconds);
        if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
          return { status: "permanent" as const, reason: "permanent_rejection" as const };
        }
        if (error instanceof ApiError || error instanceof ApiResponseError || error instanceof TypeError || isAbortError(error)) {
          return { status: "retry" as const };
        }
        throw error;
      }
    },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function classifySyncFailure(error: unknown): {
  kind: BackgroundFailureKind;
  retryAfterSeconds?: number;
} {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return { kind: "authentication" };
    if (error.status === 429) {
      return { kind: "rate-limited", retryAfterSeconds: error.retryAfterSeconds };
    }
    return { kind: "server" };
  }
  if (error instanceof ApiResponseError) return { kind: "server" };
  if (error instanceof TypeError) return { kind: "network" };
  if (error instanceof Error && "code" in error) return { kind: "local-io" };
  return { kind: "unknown" };
}

export function syncErrorCategory(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "device authorization is no longer valid";
    if (error.status === 429) return "the service is rate limiting this device";
    return "the Burnbook service rejected the upload";
  }
  if (error instanceof ApiResponseError) return "the Burnbook service returned an invalid response";
  if (error instanceof TypeError) return "the Burnbook service is unreachable";
  if (error instanceof Error && "code" in error) return "local evidence could not be read safely";
  return "an unexpected local error occurred";
}

async function doSync(config: CliConfig, opts: SyncOptions, quiet: boolean): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));

  const files = await discoverTranscripts(opts.root);
  const state = await loadState();
  const cursors = { ...state.cursors };

  // Per file: its ordered ≤5000-message chunks (usually just one), plus
  // bookkeeping to decide whether that file's cursor is safe to advance
  // once all payloads are attempted.
  const fileChunks = new Map<string, FileChunk[]>();
  const fileLastLine = new Map<string, StoredCursor>();

  for (const filePath of files) {
    const cursor = cursors[filePath] ?? 0;
    let result = await parseTranscript(filePath, cursor);

    // File-shrink guard: when `cursor` is past the file's current end,
    // parseTranscript's `lineNo <= afterLine` check is true for every line
    // in the file, so it never attempts a JSON parse and returns
    // `lastLine === <the file's actual total line count>` — necessarily
    // less than `cursor`. That's a free signal (no extra file read) that the file was truncated/rewritten since we last read it (e.g. the transcript was regenerated). Re-ingesting from 0 is safe — the server dedups on (agent, sessionId, messageId, requestId).
    if (typeof cursor === "number" && cursor > 0 && result.lastLine < cursor) {
      result = await parseTranscript(filePath, 0);
    }

    const nextCursor = result.cursor ?? result.byteCursor ?? result.lastLine;

    if (result.tuples.length === 0) {
      // Nothing new was produced, so nothing depends on a server ack —
      // safe to advance immediately.
      cursors[filePath] = nextCursor;
      continue;
    }

    const sessionId = result.sessionId ?? path.basename(filePath, ".jsonl");
    const tupleChunks = batchByBudget(result.tuples, MAX_MESSAGES_PER_SESSION, MAX_TOKENS_PER_PAYLOAD, tupleTokens);
    fileLastLine.set(filePath, nextCursor);
    fileChunks.set(
      filePath,
      tupleChunks.map((messages) => ({
        filePath,
        sessionId,
        messages,
        tokens: messages.reduce((sum, t) => sum + tupleTokens(t), 0),
      })),
    );
  }

  // Batch into payloads "wave by wave": wave i holds every file's i-th chunk (if it has one). A file whose tuples needed splitting (whether by the 5000-message cap or the token budget) therefore always has its chunks land in *different* payloads/POSTs, never bundled back together into one call — each wave is then itself sub-batched by both MAX_SESSIONS_PER_PAYLOAD and MAX_TOKENS_PER_PAYLOAD in case a wave alone has more files, or more total tokens, than those caps allow.
  const maxChunksPerFile = Math.max(0, ...[...fileChunks.values()].map((c) => c.length));
  const payloadBatches: FileChunk[][] = [];
  for (let waveIndex = 0; waveIndex < maxChunksPerFile; waveIndex++) {
    const wave: FileChunk[] = [];
    for (const chunks of fileChunks.values()) {
      const chunk = chunks[waveIndex];
      if (chunk) wave.push(chunk);
    }
    payloadBatches.push(...batchFileChunks(wave));
  }

  const fileChunkTotal = new Map<string, number>([...fileChunks].map(([f, c]) => [f, c.length]));
  const succeededChunkCount = new Map<string, number>();
  let totalAccepted = 0;
  let totalDuplicates = 0;
  let anyFailure = false;
  let failedPayloadCount = 0;

  for (const batch of payloadBatches) {
    const payload: SyncPayload = {
      deviceId: config.deviceId,
      agent: "claude-code",
      sentAt: new Date().toISOString(),
      sessions: batch.map((c) => ({ sessionId: c.sessionId, messages: c.messages })),
    };

    try {
      const envelope = await signPayload(payload);
      const result = await postSync(config.apiOrigin, config.deviceToken, envelope);
      totalAccepted += result.accepted;
      totalDuplicates += result.duplicates;
      for (const c of batch) {
        succeededChunkCount.set(c.filePath, (succeededChunkCount.get(c.filePath) ?? 0) + 1);
      }
    } catch (err) {
      // ApiError and network-level fetch failures are expected and safe to
      // mark as failure and continue. Anything else (local corruption,
      // unexpected bugs) should propagate up.
      if (err instanceof ApiError) {
        anyFailure = true;
        failedPayloadCount++;
      } else if (err instanceof TypeError) {
        // Network-level fetch failures.
        anyFailure = true;
        failedPayloadCount++;
      } else {
        // Unexpected error — rethrow for the outer handler to deal with.
        throw err;
      }
      const failure = classifySyncFailure(err);
      opts.onFailure?.(failure.kind, failure.retryAfterSeconds);
      // Leave this batch's files' cursors untouched — see fileChunkTotal
      // reconciliation below.
    }
  }

  for (const [filePath, total] of fileChunkTotal) {
    if (succeededChunkCount.get(filePath) === total) {
      cursors[filePath] = fileLastLine.get(filePath)!;
    }
  }

  await saveState({ ...state, cursors });

  if (!quiet) {
    const summary = `synced ${totalAccepted} new messages (${totalDuplicates} duplicates)`;
    log(
      anyFailure
        ? `${summary}; ${failedPayloadCount} payload(s) failed — run again to retry`
        : summary,
    );
  }

  if (quiet && !opts.background) return 0;
  return anyFailure ? 1 : 0;
}
