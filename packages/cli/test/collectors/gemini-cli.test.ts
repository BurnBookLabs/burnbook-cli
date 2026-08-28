import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geminiCliCollector } from "../../src/collectors/gemini-cli.js";

let root: string;
const original = { file: process.env.BURNBOOK_GEMINI_TELEMETRY_FILE, prompts: process.env.GEMINI_TELEMETRY_LOG_PROMPTS, traces: process.env.GEMINI_TELEMETRY_TRACES_ENABLED };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-gemini-"));
  process.env.BURNBOOK_GEMINI_TELEMETRY_FILE = path.join(root, "otel.jsonl");
  process.env.GEMINI_TELEMETRY_LOG_PROMPTS = "false";
  process.env.GEMINI_TELEMETRY_TRACES_ENABLED = "false";
});

afterEach(async () => {
  for (const [key, value] of Object.entries({ BURNBOOK_GEMINI_TELEMETRY_FILE: original.file, GEMINI_TELEMETRY_LOG_PROMPTS: original.prompts, GEMINI_TELEMETRY_TRACES_ENABLED: original.traces })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("Gemini CLI collector", () => {
  it("extracts only documented token metadata and separates cached context", async () => {
    const file = process.env.BURNBOOK_GEMINI_TELEMETRY_FILE!;
    await fs.writeFile(file, `${JSON.stringify({
      name: "gemini_cli.api_response",
      timestamp: "2026-08-25T10:00:00.000Z",
      attributes: {
        model: "gemini-2.5-pro",
        prompt_id: "private-provider-id",
        input_token_count: 1000,
        cached_content_token_count: 970,
        output_token_count: 10,
        thoughts_token_count: 5,
        tool_token_count: 2,
        prompt: "must never leave this file",
      },
    })}\n`);
    const result = await geminiCliCollector.collectResource(file, 0);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ inputTokens: 30, cacheReadTokens: 970, outputTokens: 10, reasoningTokens: 5, toolInputTokens: 2, totalTokens: 1017 });
    expect(JSON.stringify(result.evidence)).not.toContain("must never leave");
    expect(JSON.stringify(result.evidence)).not.toContain("private-provider-id");
  });

  it("fails closed when prompt logging is enabled", async () => {
    process.env.GEMINI_TELEMETRY_LOG_PROMPTS = "true";
    await fs.writeFile(process.env.BURNBOOK_GEMINI_TELEMETRY_FILE!, "");
    await expect(geminiCliCollector.detect()).resolves.toMatchObject({ status: "degraded" });
    await expect(geminiCliCollector.discoverResources()).resolves.toEqual([]);
  });
});
