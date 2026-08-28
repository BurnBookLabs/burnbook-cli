import { getMeSummary, type SummaryResponse } from "../core/api.js";
import { loadConfig } from "../core/config.js";

export interface StatusOptions {
  inspectAutomation?: () => Promise<AutomationStatus>;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export interface AutomationStatus {
  scheduler: "enabled" | "needs-repair" | "disabled" | "unsupported";
  lastSuccessAt?: string;
  queued?: number;
  queueBytes?: number;
  quarantined?: number;
  oldestPendingAt?: string;
  lastAcknowledgedAt?: string;
}

/** `burn status`: render private totals, the public snapshot, and local automation health. */
export async function runStatus(opts: StatusOptions = {}): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const errorLog = opts.errorLog ?? ((message: string) => console.error(message));

  const config = await loadConfig();
  if (!config) {
    errorLog("Not logged in. Run `burn login` first.");
    return 1;
  }

  let automation: string | undefined;
  if (opts.inspectAutomation) {
    try { automation = renderAutomation(await opts.inspectAutomation()); } catch { automation = "  auto    status unavailable"; }
  }

  try {
    const summary = await getMeSummary(config.apiOrigin, config.deviceToken);
    log([renderCard(summary), automation].filter(Boolean).join("\n"));
    return 0;
  } catch (err) {
    if (automation) log(automation);
    errorLog(`status failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function renderAutomation(status: AutomationStatus): string {
  const scheduler = status.scheduler === "enabled"
    ? "enabled"
    : status.scheduler === "unsupported"
      ? "unsupported"
      : "needs repair";
  const details = [status.lastSuccessAt ? `last success ${status.lastSuccessAt}` : undefined]
    .concat(status.queued ? `${status.queued} queued` : [])
    .concat(status.queueBytes ? `${formatBytes(status.queueBytes)} local queue` : [])
    .concat(status.quarantined ? `${status.quarantined} quarantined` : [])
    .concat(status.oldestPendingAt ? `oldest pending ${status.oldestPendingAt}` : [])
    .concat(status.lastAcknowledgedAt ? `last ack ${status.lastAcknowledgedAt}` : [])
    .filter(Boolean)
    .join("; ");
  return `  auto    ${scheduler}${details ? ` (${details})` : ""}`;
}

export function renderCard(s: SummaryResponse): string {
  const streakLabel = `${s.streakDays} day${s.streakDays === 1 ? "" : "s"}`;
  const lines = [
    "burnbook",
    `  @${s.handle}`,
    `  today   ${formatTokens(s.todayTokens)} tokens`,
    `  total   ${formatTokens(s.totalTokens)} tokens`,
    `  streak  ${streakLabel}`,
  ];
  if (s.tokenTotals) {
    const cacheRate = s.tokenTotals.cacheHitRate === null
      ? "—"
      : `${Math.round(s.tokenTotals.cacheHitRate * 100)}%`;
    lines.splice(
      4,
      0,
      `  fresh   ${formatTokens(s.tokenTotals.freshTokens)} tokens`,
      `  cache   ${formatTokens(s.tokenTotals.cacheReadTokens)} read · ${cacheRate} hit rate`,
    );
  }
  if (s.publicSnapshot) {
    lines.push(
      "  public",
      `    fluency   ${s.publicSnapshot.score} (${s.publicSnapshot.grade})`,
      `    tokens    ${formatTokens(s.publicSnapshot.lifetimeTokens)} supported`,
      `    evidence  ${s.publicSnapshot.evidenceCoverage}% · ${s.publicSnapshot.formulaVersion}`,
      `    season    ${s.publicSnapshot.seasonId}`,
    );
  }
  return lines.join("\n");
}

function formatTokens(n: number | string): string {
  return BigInt(n).toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
