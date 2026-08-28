import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCompatibilityRegistry, usageEvidenceV2Schema } from "@burnbook/schema";
import { claudeCodeCollector } from "../../src/collectors/claude-code.js";
import { parseCodexRollout } from "../../src/collectors/codex.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(testDirectory, "../..");

interface CertificationArtifact {
  certificationVersion: 1;
  suite: string;
  agent: string;
  fixture: string;
  fixtureSha256: string;
  expectedEvidenceSha256: string;
  expectedEvidenceCount: number;
  expectedEventIds: string[];
  forbiddenSentinels: string[];
}

describe("collector certification", () => {
  it("certifies Claude deterministically against the declared content-free fixture", async () => {
    const artifactPath = path.join(packageDirectory, "certification", "claude-code-v1.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as CertificationArtifact;
    const fixturePath = path.resolve(path.dirname(artifactPath), artifact.fixture);
    const fixture = await readFile(fixturePath);
    const result = await claudeCodeCollector.collectResource(fixturePath, 0, {
      maxEvidence: 500,
      maxLines: 10_000,
    });

    expect(artifact).toMatchObject({ certificationVersion: 1, agent: "claude-code" });
    expect(agentCompatibilityRegistry.agents.find((entry) => entry.agent === artifact.agent))
      .toMatchObject({ certification: { status: "certified", suite: artifact.suite } });
    expect(sha256(fixture)).toBe(artifact.fixtureSha256);
    expect(result.evidence).toHaveLength(artifact.expectedEvidenceCount);
    expect(result.evidence.map((entry) => entry.eventId)).toEqual(artifact.expectedEventIds);
    expect(sha256(JSON.stringify(result.evidence))).toBe(artifact.expectedEvidenceSha256);
    expect(result.evidence.every((entry) => usageEvidenceV2Schema.safeParse(entry).success)).toBe(true);
    expect(result.diagnostics).toEqual([]);

    const serialized = JSON.stringify(result);
    for (const sentinel of artifact.forbiddenSentinels) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("keeps every content category out of the Codex preview fixture output", async () => {
    const fixturePath = path.join(
      packageDirectory,
      "test",
      "fixtures",
      "certification",
      "codex-privacy-v1.jsonl",
    );
    const result = await parseCodexRollout(fixturePath);
    const serialized = JSON.stringify(result);

    expect(agentCompatibilityRegistry.agents.find((entry) => entry.agent === "codex"))
      .toMatchObject({ certification: { status: "preview", suite: "codex-privacy-v1" } });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      agent: "codex",
      supportTier: "preview",
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 130,
    });
    for (const category of [
      "PRIVATE_PROMPT_SENTINEL",
      "PRIVATE_RESPONSE_SENTINEL",
      "PRIVATE_COMMAND_SENTINEL",
      "PRIVATE_CODE_SENTINEL",
      "PRIVATE_PATH_SENTINEL",
      "PRIVATE_DIFF_SENTINEL",
      "PRIVATE_REASONING_SENTINEL",
      "PRIVATE_TOOL_SENTINEL",
    ]) {
      expect(serialized).not.toContain(category);
    }
  });
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
