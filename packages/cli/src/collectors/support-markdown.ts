import { AGENT_SUPPORT, collectorGateLabel } from "./support.js";

export function renderSupportTable(): string {
  const rows = AGENT_SUPPORT.map((entry) =>
    `| ${entry.displayName} | ${entry.supportTier} | ${collectorGateLabel(entry.certification.status)} | ${entry.sourceVersion} | ${entry.collectorVersion} | ${entry.normalizerVersion} | ${entry.coverage} |`,
  );
  return [
    "| Agent | Tier | Collector gate | Source version | Collector | Normalizer | Coverage |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
