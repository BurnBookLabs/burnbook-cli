import { agentSupportManifest, type AgentId } from "@burnbook/schema";

export const AGENT_SUPPORT = agentSupportManifest;
export type AgentSupport = (typeof AGENT_SUPPORT)[number];

export function supportFor(agent: AgentId): AgentSupport | undefined {
  return AGENT_SUPPORT.find((entry) => entry.agent === agent);
}

export function collectorGateLabel(
  status: AgentSupport["certification"]["status"],
): "passed" | "preview" | "not passed" {
  if (status === "certified") return "passed";
  if (status === "preview") return "preview";
  return "not passed";
}
