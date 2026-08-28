import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import {
  legacyEventIdentityInput,
  usageEvidenceV2Schema,
  usageEvidenceV3Schema,
  type UsageEvidenceV2,
  type UsageEvidenceV3,
} from "@burnbook/schema";
import { z } from "zod";
import { appendEvidence } from "../core/spool.js";
import { appendEvidenceV3 } from "../core/spool-v3.js";
import { acquireSyncLock, type SyncLock } from "../core/sync-lock.js";

const legacyMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  ts: z.string().datetime({ offset: true }),
  model: z.string().min(1).max(128),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
}).passthrough();

const legacySchema = legacyMessageSchema.extend({
  agent: z.string().optional(),
  sessionId: z.string().min(1).max(256),
});

const legacySpoolSchema = z.object({
  agent: z.string().optional(),
  sessionId: z.string().min(1).max(256),
  message: legacyMessageSchema,
}).passthrough();

export interface ReconcileOptions {
  local: string;
  server: string;
  out: string;
  importLocalOnly?: boolean;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

type Evidence = UsageEvidenceV2 | UsageEvidenceV3;
interface CanonicalRecord { evidence: Evidence; identity: string; accounting: string; sourceDigest: string }
interface NormalizedEvidence { evidence: Evidence; sourceEventId?: string; sourceSessionId?: string }

export async function runReconcile(options: ReconcileOptions): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  let lock: SyncLock | undefined;
  try {
    if (options.importLocalOnly) {
      lock = await acquireSyncLock();
      if (!lock) throw new Error("another Burnbook collection or sync process is active");
    }
    const local = await readCanonical(options.local);
    const server = await readCanonical(options.server);
    const localMap = groupByIdentity(local.valid);
    const serverMap = groupByIdentity(server.valid);
    const identities = [...new Set([...localMap.keys(), ...serverMap.keys()])].sort();
    const entries: Array<Record<string, unknown>> = [];
    const upload: Evidence[] = [];
    const counts = { matched: 0, localOnly: 0, serverOnly: 0, conflict: 0, invalid: local.invalid.length + server.invalid.length };

    for (const identity of identities) {
      const locals = localMap.get(identity) ?? [];
      const servers = serverMap.get(identity) ?? [];
      const localAccounting = new Set(locals.map((row) => row.accounting));
      const serverAccounting = new Set(servers.map((row) => row.accounting));
      const compatible = new Set([...localAccounting, ...serverAccounting]).size === 1;
      if (locals.length > 0 && servers.length > 0 && compatible) {
        counts.matched += 1;
        entries.push(ledgerEntry("matched", identity, locals, servers));
      } else if (locals.length > 0 && servers.length === 0 && localAccounting.size === 1) {
        counts.localOnly += locals.length;
        entries.push(ledgerEntry("local-only", identity, locals, servers));
        upload.push(preferredEvidence(locals));
      } else if (servers.length > 0 && locals.length === 0 && serverAccounting.size === 1) {
        counts.serverOnly += servers.length;
        entries.push(ledgerEntry("server-only", identity, locals, servers));
      } else {
        counts.conflict += locals.length + servers.length;
        entries.push(ledgerEntry("conflict", identity, locals, servers));
      }
    }
    entries.push(...local.invalid.map((digest) => ({ classification: "invalid", side: "local", sourceDigest: digest })));
    entries.push(...server.invalid.map((digest) => ({ classification: "invalid", side: "server", sourceDigest: digest })));
    const ledger = { version: 1, generatedAt: new Date().toISOString(), counts, entries };
    await fs.writeFile(options.out, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (options.importLocalOnly) {
      const v2 = await appendEvidence(upload.filter((row): row is UsageEvidenceV2 => row.schemaVersion === 2));
      const v3 = await appendEvidenceV3(upload.filter((row): row is UsageEvidenceV3 => row.schemaVersion === 3));
      log(`imported ${v2.appended + v3.appended} local-only event(s); source files were preserved`);
    }
    log(`reconciliation complete: ${counts.matched} matched, ${counts.localOnly} local-only, ${counts.serverOnly} server-only, ${counts.conflict} conflict, ${counts.invalid} invalid`);
    return counts.conflict + counts.invalid > 0 ? 2 : 0;
  } catch (error) {
    errorLog(`reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await lock?.release();
  }
}

async function readCanonical(file: string): Promise<{ valid: CanonicalRecord[]; invalid: string[] }> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 * 1024) throw new Error("reconciliation input must be a regular file no larger than 2 GiB");
  const valid: CanonicalRecord[] = [];
  const invalid: string[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const sourceDigest = digest(line);
    try {
      const raw = JSON.parse(line) as unknown;
      const normalized = normalizeEvidence(raw);
      if (!normalized) { invalid.push(sourceDigest); continue; }
      const { evidence, sourceEventId, sourceSessionId } = normalized;
      const eventIdentity = sourceEventId ?? evidence.eventId;
      const sessionIdentity = sourceEventId || !evidence.eventId.startsWith("v1-")
        ? sourceSessionId ?? evidence.sessionId ?? ""
        : "";
      const identity = digest(JSON.stringify([
        evidence.agent, evidence.surface, sessionIdentity, eventIdentity,
      ]));
      const accounting = digest(JSON.stringify([
        evidence.model,
        String(evidence.inputTokens),
        String(evidence.cacheReadTokens),
        String(evidence.cacheWriteTokens),
        (BigInt(evidence.outputTokens) + BigInt(evidence.reasoningTokens)).toString(),
        String(evidence.toolInputTokens),
        String(evidence.totalTokens),
      ]));
      valid.push({ evidence, identity, accounting, sourceDigest });
    } catch { invalid.push(sourceDigest); }
  }
  return { valid, invalid };
}

function normalizeEvidence(raw: unknown): NormalizedEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = { ...(raw as Record<string, unknown>) };
  const sourceEventId = validSourceEventId(value.sourceEventId) ? value.sourceEventId : undefined;
  delete value.sourceEventId;
  value.agent = canonicalAgent(value.agent);
  const current = usageEvidenceV2Schema.safeParse(value);
  if (current.success) return {
    evidence: current.data,
    ...(sourceEventId ? { sourceEventId } : {}),
  };
  const v3 = usageEvidenceV3Schema.safeParse(value);
  if (v3.success) return {
    evidence: v3.data,
    ...(sourceEventId ? { sourceEventId } : {}),
  };
  const legacy = legacySchema.safeParse(value);
  const spooled = legacySpoolSchema.safeParse(value);
  let row: z.infer<typeof legacySchema>;
  if (legacy.success) {
    row = legacy.data;
  } else if (spooled.success) {
    row = {
      ...spooled.data.message,
      agent: spooled.data.agent,
      sessionId: spooled.data.sessionId,
    };
  } else {
    return undefined;
  }
  const agent = canonicalAgent(row.agent) ?? "claude-code";
  if (agent !== "claude-code" && agent !== "codex") return undefined;
  const eventId = `v1-${createHash("md5")
    .update(legacyEventIdentityInput(row.sessionId, row.messageId, row.requestId))
    .digest("hex")}`;
  const total = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens + row.outputTokens;
  const evidence = usageEvidenceV2Schema.parse({
    schemaVersion: 2,
    agent,
    surface: "cli",
    source: "transcript",
    sourceVersion: agent === "codex" ? "codex-rollout-token-count-v1" : "claude-transcript-v1",
    collectorVersion: "1",
    normalizerVersion: 1,
    evidenceClass: "agent-local",
    supportTier: agent === "claude-code" ? "supported" : "preview",
    eventId,
    sessionId: digest(row.sessionId),
    occurredAt: row.ts,
    timeBasis: "provider",
    model: canonicalModel(row.model),
    inputTokens: row.inputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheCreationTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: 0,
    toolInputTokens: 0,
    totalTokens: total,
  });
  return agent === "codex"
    ? { evidence, sourceEventId: row.messageId, sourceSessionId: row.sessionId }
    : { evidence };
}

function validSourceEventId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function canonicalModel(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:+~-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128);
  return normalized || "unknown";
}

function canonicalAgent(value: unknown): string | undefined {
  if (value === "codex" || value === "openai-codex" || value === "codex-cli") return "codex";
  if (value === "claude-code" || value === "claude" || value === "anthropic-claude-code" || value === undefined) return "claude-code";
  return typeof value === "string" ? value : undefined;
}

function groupByIdentity(rows: CanonicalRecord[]) {
  const map = new Map<string, CanonicalRecord[]>();
  for (const row of rows) map.set(row.identity, [...(map.get(row.identity) ?? []), row]);
  return map;
}

function ledgerEntry(classification: string, identity: string, local: CanonicalRecord[], server: CanonicalRecord[]) {
  return {
    classification,
    identity,
    local: local.map((row) => ({ accounting: row.accounting, sourceDigest: row.sourceDigest })),
    server: server.map((row) => ({ accounting: row.accounting, sourceDigest: row.sourceDigest })),
  };
}

function preferredEvidence(records: CanonicalRecord[]): Evidence {
  return [...records].sort((left, right) => {
    const currentIdentity = Number(!right.evidence.eventId.startsWith("v1-")) -
      Number(!left.evidence.eventId.startsWith("v1-"));
    if (currentIdentity !== 0) return currentIdentity;
    return right.evidence.schemaVersion - left.evidence.schemaVersion;
  })[0].evidence;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
