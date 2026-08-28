import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import {
  evidenceIdentifierSchema,
  modelIdentifierSchema,
  usageEvidenceV2Schema,
  type AgentId,
  type UsageEvidenceV2,
} from "@burnbook/schema";
import { z } from "zod";
import { appendEvidence, recordQuarantine } from "../core/spool.js";

const IMPORT_AGENTS = new Set<AgentId>(["cursor", "antigravity"]);
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const MAX_IMPORT_LINES = 100_000;
const token = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const importRecordSchema = z.object({
  sourceEventId: evidenceIdentifierSchema.optional(),
  sessionId: evidenceIdentifierSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  model: modelIdentifierSchema,
  inputTokens: token,
  cacheReadTokens: token.default(0),
  cacheWriteTokens: token.default(0),
  outputTokens: token,
  reasoningTokens: token.default(0),
  toolInputTokens: token.default(0),
  totalTokens: token.optional(),
}).strict();

export interface ImportOptions {
  agent: AgentId;
  file: string;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export async function runImport(options: ImportOptions): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  if (!IMPORT_AGENTS.has(options.agent)) {
    errorLog("Content-free import is currently available for cursor and antigravity.");
    return 1;
  }

  try {
    const stat = await fs.stat(options.file);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
      throw new Error("Import must be a regular JSONL file no larger than 128 MiB.");
    }
    const records: UsageEvidenceV2[] = [];
    let rejected = 0;
    let lineNumber = 0;
    const input = createReadStream(options.file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (lineNumber > MAX_IMPORT_LINES) {
          throw new Error("Import contains more than 100,000 lines.");
        }
        if (!line.trim()) continue;
        const parsed = parseImportLine(line);
        if (!parsed) {
          rejected += 1;
          continue;
        }
        const total = parsed.inputTokens + parsed.cacheReadTokens +
          parsed.cacheWriteTokens + parsed.outputTokens +
          parsed.reasoningTokens + parsed.toolInputTokens;
        if (parsed.totalTokens !== undefined && parsed.totalTokens !== total) {
          rejected += 1;
          continue;
        }
        const identity = [
          options.agent,
          parsed.sourceEventId,
          parsed.sessionId,
          parsed.occurredAt,
          parsed.model,
          total,
        ];
        const sessionId = parsed.sessionId
          ? hashIdentifier("session", parsed.sessionId)
          : undefined;
        records.push(usageEvidenceV2Schema.parse({
          schemaVersion: 2,
          agent: options.agent,
          surface: "ide",
          source: "import",
          sourceVersion: "burnbook-import-v1",
          collectorVersion: "1",
          normalizerVersion: 1,
          evidenceClass: "agent-local",
          supportTier: "preview",
          eventId: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
          ...(sessionId ? { sessionId } : {}),
          occurredAt: parsed.occurredAt,
          timeBasis: "provider",
          model: parsed.model,
          inputTokens: parsed.inputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
          outputTokens: parsed.outputTokens,
          reasoningTokens: parsed.reasoningTokens,
          toolInputTokens: parsed.toolInputTokens,
          totalTokens: total,
        }));
      }
    } finally {
      lines.close();
      input.destroy();
    }

    const result = await appendEvidence(records);
    await recordQuarantine(options.agent, rejected);
    log(
      `imported ${result.appended} ${options.agent} event(s)` +
      (result.duplicates ? ` (${result.duplicates} already spooled)` : "") +
      (rejected ? `; ${rejected} invalid line(s) quarantined` : ""),
    );
    return rejected > 0 ? 1 : 0;
  } catch (error) {
    errorLog(`import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function parseImportLine(line: string): z.infer<typeof importRecordSchema> | undefined {
  try {
    const parsed = importRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function hashIdentifier(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
}
