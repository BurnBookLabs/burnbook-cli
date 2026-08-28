import { claudeCodeCollector } from "./claude-code.js";
import { codexCollector } from "./codex.js";
import { geminiCliCollector } from "./gemini-cli.js";
import type { AgentCollector, AgentId } from "./types.js";

const COLLECTORS = [
  claudeCodeCollector,
  codexCollector,
  geminiCliCollector,
] as const satisfies readonly AgentCollector[];

export function listCollectors(): readonly AgentCollector[] {
  return COLLECTORS;
}

export function getCollector(agent: AgentId): AgentCollector | undefined {
  return COLLECTORS.find((collector) => collector.agent === agent);
}
