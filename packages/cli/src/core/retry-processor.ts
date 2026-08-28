import { createHash } from "node:crypto";
import type { SyncResponseV2, UsageEvidenceV2, UsageEvidenceV3 } from "@burnbook/schema";
import {
  acknowledgeEvidence,
  readPendingEvidenceWindow,
  readRetrySchedule,
  recordDeliveryQuarantine,
  writeRetrySchedule,
  type SpoolRetryEntry,
} from "./spool.js";

const MAX_EVIDENCE_PER_BATCH = 5000;
const MAX_TOKENS_PER_BATCH = 1_500_000_000;
const DEFAULT_MAX_BATCHES = 20;
const MAX_BATCHES_PER_PASS = 20;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MIN_RETRY_JITTER = 0.8;

export type RetryUploadResult =
  | { status: "success"; response: SyncResponseV2 }
  | { status: "retry"; retryAfterMs?: number }
  | { status: "permanent"; reason: "permanent_rejection" };

export interface RetryProcessorOptions {
  uploadBatch: (evidence: readonly RetryEvidence[]) => Promise<RetryUploadResult>;
  spool?: RetrySpool;
  force?: boolean;
  maxBatches?: number;
  now?: () => Date;
  random?: () => number;
}

export type RetryEvidence = UsageEvidenceV2 | UsageEvidenceV3;
export interface RetrySpool {
  readWindow(limit: number): Promise<{ evidence: RetryEvidence[]; malformed: number; hasMore: boolean }>;
  acknowledge(records: readonly RetryEvidence[]): Promise<void>;
  quarantine(records: readonly RetryEvidence[], code: "permanent_rejection" | "invalid_acknowledgement", digest: string): Promise<void>;
  readSchedule(): Promise<SpoolRetryEntry[]>;
  writeSchedule(entries: readonly SpoolRetryEntry[]): Promise<void>;
}

export interface RetryProcessorResult {
  accepted: number;
  duplicates: number;
  failedBatches: number;
  quarantined: number;
  deferredBatches: number;
  nextAttemptAt?: string;
}

/** One bounded retry pass. Transport is injected, so this module has no network capability. */
export async function processEvidenceSpoolRetries(
  options: RetryProcessorOptions,
): Promise<RetryProcessorResult> {
  const now = options.now?.() ?? new Date();
  const maximum = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BATCHES_PER_PASS) {
    throw new Error(`maxBatches must be an integer between 1 and ${MAX_BATCHES_PER_PASS}`);
  }

  const spool = options.spool ?? defaultSpool;
  const pending = await spool.readWindow(maximum * MAX_EVIDENCE_PER_BATCH);
  const batches = buildBatches(pending.evidence);
  const schedule = new Map((await spool.readSchedule()).map((entry) => [entry.batchDigest, entry]));
  const activeDigests = new Set(batches.map(batchDigest));
  if (!pending.hasMore) {
    for (const digest of schedule.keys()) {
      if (!activeDigests.has(digest)) schedule.delete(digest);
    }
  }

  let accepted = 0;
  let duplicates = 0;
  let failedBatches = 0;
  let deferredBatches = 0;
  let quarantined = 0;
  let attempted = 0;

  const queue = [...batches];
  while (queue.length > 0) {
    const batch = queue.shift()!;
    const digest = batchDigest(batch);
    const retry = schedule.get(digest);
    if (!options.force && retry && Date.parse(retry.nextAttemptAt) > now.getTime()) {
      deferredBatches += 1;
      continue;
    }
    if (attempted >= maximum) {
      deferredBatches += 1;
      continue;
    }
    attempted += 1;

    const result = await options.uploadBatch(batch);
    if (result.status === "permanent") {
      schedule.delete(digest);
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(middle), batch.slice(0, middle));
        continue;
      }
      await spool.quarantine(batch, result.reason, digest);
      await spool.acknowledge(batch);
      quarantined += 1;
      continue;
    }
    if (result.status === "retry") {
      failedBatches += 1;
      const attempts = Math.min((retry?.attempts ?? 0) + 1, 100);
      schedule.set(digest, {
        batchDigest: digest,
        attempts,
        nextAttemptAt: new Date(
          now.getTime() + retryDelay(
            attempts,
            options.random?.() ?? Math.random(),
            result.retryAfterMs,
          ),
        ).toISOString(),
      });
      continue;
    }
    if (!isConsistentAcknowledgement(batch, result.response)) {
      failedBatches += 1;
      const attempts = Math.min((retry?.attempts ?? 0) + 1, 100);
      schedule.set(digest, {
        batchDigest: digest,
        attempts,
        nextAttemptAt: new Date(
          now.getTime() + retryDelay(
            attempts,
            options.random?.() ?? Math.random(),
          ),
        ).toISOString(),
      });
      continue;
    }

    const acknowledged = new Set([
      ...result.response.acceptedEventIds,
      ...result.response.duplicateEventIds,
    ]);
    await spool.acknowledge(batch.filter((record) => acknowledged.has(record.eventId)));
    accepted += result.response.acceptedEventIds.length;
    duplicates += result.response.duplicateEventIds.length;
    schedule.delete(digest);
  }
  if (pending.hasMore) deferredBatches += 1;

  const remaining = [...schedule.values()].sort((left, right) =>
    left.nextAttemptAt.localeCompare(right.nextAttemptAt),
  );
  await spool.writeSchedule(remaining);
  return {
    accepted,
    duplicates,
    failedBatches,
    quarantined,
    deferredBatches,
    ...(remaining[0] ? { nextAttemptAt: remaining[0].nextAttemptAt } : {}),
  };
}

function buildBatches(evidence: readonly RetryEvidence[]): RetryEvidence[][] {
  const groups = new Map<string, RetryEvidence[]>();
  for (const record of evidence) {
    const key = [
      record.agent,
      record.surface,
      record.source,
      record.sourceVersion,
      record.collectorVersion,
      record.normalizerVersion,
      record.supportTier,
      record.evidenceClass,
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const batches: RetryEvidence[][] = [];
  for (const group of groups.values()) {
    let current: RetryEvidence[] = [];
    let tokens = BigInt(0);
    for (const record of group) {
      if (
        current.length > 0 &&
        (current.length >= MAX_EVIDENCE_PER_BATCH || tokens + BigInt(record.totalTokens) > BigInt(MAX_TOKENS_PER_BATCH))
      ) {
        batches.push(current);
        current = [];
        tokens = BigInt(0);
      }
      current.push(record);
      tokens += BigInt(record.totalTokens);
    }
    if (current.length > 0) batches.push(current);
  }
  return batches;
}

function batchDigest(batch: readonly RetryEvidence[]): string {
  const identities = batch.map((record) => [record.agent, record.surface, record.eventId]);
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

function isConsistentAcknowledgement(
  batch: readonly RetryEvidence[],
  response: SyncResponseV2,
): boolean {
  const batchIds = new Set(batch.map((record) => record.eventId));
  const accepted = new Set(response.acceptedEventIds);
  const duplicates = new Set(response.duplicateEventIds);
  const responseIds = [...accepted, ...duplicates];
  return (
    responseIds.length === batch.length &&
    responseIds.every((eventId) => batchIds.has(eventId)) &&
    [...accepted].every((eventId) => !duplicates.has(eventId))
  );
}

const defaultSpool: RetrySpool = {
  readWindow: async (limit) => readPendingEvidenceWindow(limit),
  acknowledge: async (records) => acknowledgeEvidence(records as UsageEvidenceV2[]),
  quarantine: async (records, code, digest) => recordDeliveryQuarantine(records as UsageEvidenceV2[], code, digest),
  readSchedule: readRetrySchedule,
  writeSchedule: writeRetrySchedule,
};

function retryDelay(attempts: number, random: number, retryAfterMs?: number): number {
  const boundedRandom = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
  const exponential = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.min(attempts - 1, 10),
    MAX_RETRY_DELAY_MS,
  );
  const serverFloor = Number.isFinite(retryAfterMs)
    ? Math.min(Math.max(0, retryAfterMs as number), MAX_RETRY_DELAY_MS)
    : 0;
  const jittered = Math.round(exponential * (MIN_RETRY_JITTER + (1 - MIN_RETRY_JITTER) * boundedRandom));
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(serverFloor, jittered));
}
