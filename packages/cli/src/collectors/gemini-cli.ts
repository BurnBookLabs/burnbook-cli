import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { usageEvidenceV2Schema, type UsageEvidenceV2 } from "@burnbook/schema";
import { readJsonlTail, type JsonlByteCursor } from "../core/jsonl-tail.js";
import { AGENT_SUPPORT } from "./support.js";
import type {
  AgentCollector,
  CollectionCursor,
  CollectionInput,
  CollectionLimits,
  CollectionResult,
} from "./types.js";

const MAX_BYTES_PER_COLLECT = 4 * 1024 * 1024;
const SUPPORT = AGENT_SUPPORT.find((entry) => entry.agent === "gemini-cli")!;

export const geminiCliCollector: AgentCollector = {
  agent: "gemini-cli",
  surface: "cli",
  source: "otel",

  async detect(input?: CollectionInput) {
    const privacy = await geminiTelemetryConfig(input?.root);
    if (!privacy.safe) return { status: "degraded", detail: privacy.detail };
    try {
      const stat = await fs.stat(privacy.file);
      return stat.isFile()
        ? { status: "available", detail: "privacy-safe local Gemini telemetry is available" }
        : { status: "unavailable", detail: "Gemini telemetry output is not a regular file" };
    } catch {
      return { status: "unavailable", detail: "Gemini telemetry output has not been created yet" };
    }
  },

  async collect(input?: CollectionInput): Promise<CollectionResult> {
    const resources = await this.discoverResources(input);
    if (resources.length === 0) return { evidence: [], lastLine: 0, diagnostics: [] };
    return this.collectResource(resources[0], input?.afterLine ?? 0);
  },

  async discoverResources(input?: CollectionInput): Promise<string[]> {
    const privacy = await geminiTelemetryConfig(input?.root);
    if (!privacy.safe) return [];
    try {
      return (await fs.stat(privacy.file)).isFile() ? [privacy.file] : [];
    } catch {
      return [];
    }
  },

  async collectResource(
    resource: string,
    cursor: CollectionCursor,
    limits?: CollectionLimits,
  ): Promise<CollectionResult> {
    const tail = await readJsonlTail(resource, {
      ...(typeof cursor === "number" || !cursor ? {} : { cursor: cursor as JsonlByteCursor }),
      maxBytes: MAX_BYTES_PER_COLLECT,
    });
    const evidence: UsageEvidenceV2[] = [];
    const diagnostics: string[] = [];
    let processedLine = tail.lines[0]?.line ? tail.lines[0].line - 1 : tail.cursor.line;
    let processed = 0;
    for (const line of tail.lines) {
      if (limits && processed >= limits.maxLines) break;
      processed += 1;
      processedLine = line.line;
      const parsed = parseGeminiTelemetry(line.value);
      if (parsed === "invalid") {
        diagnostics.push("Ignored a Gemini API response whose counters did not reconcile.");
      } else if (parsed) {
        evidence.push(parsed);
        if (limits && evidence.length >= limits.maxEvidence) break;
      }
    }
    const stoppedEarly = processedLine < tail.cursor.line;
    const resultCursor = stoppedEarly
      ? { ...tail.cursor, line: processedLine }
      : tail.cursor;
    return {
      evidence,
      diagnostics,
      lastLine: processedLine,
      cursor: resultCursor,
      byteCursor: resultCursor,
    };
  },
};

type GeminiTelemetryConfig =
  | { safe: true; file: string; detail: string }
  | { safe: false; detail: string };

async function geminiTelemetryConfig(root?: string): Promise<GeminiTelemetryConfig> {
  const configuredFile = root ?? process.env.BURNBOOK_GEMINI_TELEMETRY_FILE ??
    process.env.GEMINI_TELEMETRY_OUTFILE;
  const envPrivacy = process.env.GEMINI_TELEMETRY_LOG_PROMPTS;
  const envTraces = process.env.GEMINI_TELEMETRY_TRACES_ENABLED;
  if (
    configuredFile &&
    (envPrivacy === "0" || envPrivacy === "false") &&
    (envTraces === undefined || envTraces === "0" || envTraces === "false")
  ) {
    return path.isAbsolute(configuredFile)
      ? { safe: true, file: configuredFile, detail: "Gemini prompt logging is disabled" }
      : { safe: false, detail: "Gemini telemetry output must use an absolute path" };
  }

  const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const telemetry = objectValue(settings.telemetry);
    const outfile = stringValue(telemetry?.outfile);
    if (telemetry?.logPrompts !== false || telemetry?.traces === true) {
      return {
        safe: false,
        detail: "Set Gemini telemetry.logPrompts=false and telemetry.traces=false before collection",
      };
    }
    if (!outfile || !path.isAbsolute(outfile)) {
      return { safe: false, detail: "Configure an absolute Gemini telemetry.outfile path" };
    }
    return { safe: true, file: outfile, detail: "Gemini prompt logging is disabled" };
  } catch {
    return {
      safe: false,
      detail: "Configure Gemini local telemetry with prompt logging disabled",
    };
  }
}

function parseGeminiTelemetry(line: string): UsageEvidenceV2 | "invalid" | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const name = eventName(record);
  if (name !== "gemini_cli.api_response") return undefined;
  const attributes = attributeMap(record.attributes ?? objectValue(record.body)?.attributes);
  const model = stringValue(attributes.model);
  const promptId = stringValue(attributes.prompt_id);
  const occurredAt = timestamp(record);
  const inputTotal = integer(attributes.input_token_count);
  const output = integer(attributes.output_token_count);
  const cacheRead = integer(attributes.cached_content_token_count) ?? 0;
  const reasoning = integer(attributes.thoughts_token_count) ?? 0;
  const toolInput = integer(attributes.tool_token_count) ?? 0;
  if (!model || !promptId || !occurredAt || inputTotal === undefined || output === undefined) {
    return "invalid";
  }
  if (cacheRead > inputTotal) return "invalid";
  const input = inputTotal - cacheRead;
  const total = input + cacheRead + output + reasoning + toolInput;
  const candidate = {
    schemaVersion: 2,
    agent: "gemini-cli",
    surface: "cli",
    source: "otel",
    sourceVersion: SUPPORT.sourceVersion,
    collectorVersion: SUPPORT.collectorVersion,
    normalizerVersion: SUPPORT.normalizerVersion,
    evidenceClass: SUPPORT.evidenceClass,
    supportTier: SUPPORT.supportTier,
    eventId: createHash("sha256")
      .update(JSON.stringify([promptId, occurredAt, model, total]))
      .digest("hex"),
    sessionId: `prompt-${createHash("sha256").update(promptId).digest("hex")}`,
    occurredAt,
    timeBasis: "provider",
    model,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: reasoning,
    toolInputTokens: toolInput,
    totalTokens: total,
  };
  const parsed = usageEvidenceV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : "invalid";
}

function eventName(record: Record<string, unknown>): string | undefined {
  return stringValue(record.name) ??
    stringValue(record.eventName) ??
    stringValue(record.body) ??
    stringValue(objectValue(record.body)?.stringValue);
}

function attributeMap(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      const item = objectValue(entry);
      const key = stringValue(item?.key);
      if (!key) return [];
      const wrapped = objectValue(item?.value);
      return [[key, wrapped?.intValue ?? wrapped?.stringValue ?? item?.value]];
    }));
  }
  return objectValue(value) ?? {};
}

function timestamp(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.timestamp) ?? stringValue(record.time);
  if (direct && Number.isFinite(Date.parse(direct))) return new Date(direct).toISOString();
  const nanos = stringValue(record.timeUnixNano);
  if (nanos && /^[0-9]+$/.test(nanos)) {
    return new Date(Number(BigInt(nanos) / BigInt(1_000_000))).toISOString();
  }
  return undefined;
}

function integer(value: unknown): number | undefined {
  const candidate = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
