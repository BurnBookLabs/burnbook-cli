import { createHash } from "node:crypto";
import { legacyEventIdentityInput, type UsageEvidenceV2 } from "@burnbook/schema";
import { discoverTranscripts, parseTranscript } from "../adapters/claude-code.js";
import { AGENT_SUPPORT } from "./support.js";
import type { AgentCollector, CollectionInput, CollectionResult } from "./types.js";

const SUPPORT = AGENT_SUPPORT.find((entry) => entry.agent === "claude-code")!;

function eventId(sessionId: string, messageId: string, requestId: string): string {
  return `v1-${createHash("md5")
    .update(legacyEventIdentityInput(sessionId, messageId, requestId))
    .digest("hex")}`;
}

function modelId(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:+~-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128);
  return normalized || "unknown";
}

export const claudeCodeCollector: AgentCollector = {
  agent: "claude-code",
  surface: "cli",
  source: "transcript",

  async detect(input?: CollectionInput) {
    const files = await discoverTranscripts(input?.root);
    return files.length > 0
      ? { status: "available", detail: `${files.length} persisted transcript file(s) found` }
      : { status: "unavailable", detail: SUPPORT.coverage };
  },

  async collect(input?: CollectionInput): Promise<CollectionResult> {
    const evidence: UsageEvidenceV2[] = [];
    const diagnostics: string[] = [];
    let lastLine = 0;
    const files = await discoverTranscripts(input?.root);

    for (const filePath of files) {
      const parsed = await parseTranscript(filePath, input?.afterLine ?? 0);
      lastLine = Math.max(lastLine, parsed.lastLine);
      const sessionId = parsed.sessionId;
      if (!sessionId && parsed.tuples.length > 0) {
        diagnostics.push("A Claude transcript contained usage without a session identifier.");
        continue;
      }
      for (const tuple of parsed.tuples) {
        const totalTokens =
          tuple.inputTokens +
          tuple.cacheReadTokens +
          tuple.cacheCreationTokens +
          tuple.outputTokens;
        evidence.push({
          schemaVersion: 2,
          agent: "claude-code",
          surface: "cli",
          source: "transcript",
          sourceVersion: SUPPORT.sourceVersion,
          collectorVersion: SUPPORT.collectorVersion,
          normalizerVersion: SUPPORT.normalizerVersion,
          evidenceClass: SUPPORT.evidenceClass,
          supportTier: SUPPORT.supportTier,
          eventId: eventId(sessionId!, tuple.messageId, tuple.requestId),
          sessionId: sessionId!,
          occurredAt: tuple.ts,
          timeBasis: "provider",
          model: modelId(tuple.model),
          inputTokens: tuple.inputTokens,
          cacheReadTokens: tuple.cacheReadTokens,
          cacheWriteTokens: tuple.cacheCreationTokens,
          outputTokens: tuple.outputTokens,
          reasoningTokens: 0,
          toolInputTokens: 0,
          totalTokens,
        });
      }
    }

    return { evidence, lastLine, diagnostics };
  },

  discoverResources(input?: CollectionInput) {
    return discoverTranscripts(input?.root);
  },

  async collectResource(resource: string, afterLine: number, limits): Promise<CollectionResult> {
    const parsed = await parseTranscript(
      resource,
      afterLine,
      limits ? { maxTuples: limits.maxEvidence, maxLines: limits.maxLines } : undefined,
    );
    const sessionId = parsed.sessionId;
    if (!sessionId && parsed.tuples.length > 0) {
      return {
        evidence: [],
        lastLine: parsed.lastLine,
        cursor: parsed.byteCursor ?? parsed.lastLine,
        diagnostics: ["A Claude transcript contained usage without a session identifier."],
      };
    }
    const evidence = parsed.tuples.map((tuple): UsageEvidenceV2 => {
      const totalTokens = tuple.inputTokens + tuple.cacheReadTokens + tuple.cacheCreationTokens + tuple.outputTokens;
      return {
        schemaVersion: 2,
        agent: "claude-code",
        surface: "cli",
        source: "transcript",
        sourceVersion: SUPPORT.sourceVersion,
        collectorVersion: SUPPORT.collectorVersion,
        normalizerVersion: SUPPORT.normalizerVersion,
        evidenceClass: SUPPORT.evidenceClass,
        supportTier: SUPPORT.supportTier,
        eventId: eventId(sessionId!, tuple.messageId, tuple.requestId),
        sessionId: sessionId!,
        occurredAt: tuple.ts,
        timeBasis: "provider",
        model: modelId(tuple.model),
        inputTokens: tuple.inputTokens,
        cacheReadTokens: tuple.cacheReadTokens,
        cacheWriteTokens: tuple.cacheCreationTokens,
        outputTokens: tuple.outputTokens,
        reasoningTokens: 0,
        toolInputTokens: 0,
        totalTokens,
      };
    });
    return {
      evidence,
      lastLine: parsed.lastLine,
      cursor: parsed.byteCursor ?? parsed.lastLine,
      diagnostics: [],
    };
  },
};
