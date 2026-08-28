import { usageEvidenceV3Schema, type AgentId, type UsageEvidenceV2 } from "@burnbook/schema";
import { getCollector } from "../collectors/registry.js";
import { appendEvidence, recordQuarantine } from "../core/spool.js";
import { loadState, saveState, sourceCursorKey } from "../core/state.js";
import { loadActiveProject } from "../core/project-state.js";
import { appendEvidenceV3 } from "../core/spool-v3.js";
import { acquireSyncLock, type SyncLock } from "../core/sync-lock.js";

const MAX_EVIDENCE_PER_RUN = 500;
const MAX_NEW_LINES_PER_RUN = 10_000;

export interface CollectOptions {
  agent: AgentId;
  root?: string;
  quiet?: boolean;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  lockHeld?: boolean;
}

/** Local-only collection entry point. It never performs a network request. */
export async function runCollect(options: CollectOptions): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog = options.errorLog ?? ((message: string) => console.error(message));
  const collector = getCollector(options.agent);
  if (!collector) {
    if (!options.quiet) errorLog(`No collector is available for ${options.agent}.`);
    return options.quiet ? 0 : 1;
  }
  let lock: SyncLock | undefined;
  try {
    if (!options.lockHeld) {
      lock = await acquireSyncLock();
      if (!lock) {
        if (!options.quiet) log("collection already running in another Burnbook process");
        return 0;
      }
    }
    const state = await loadState();
    const sourceCursors = { ...(state.sourceCursors ?? {}) };
    const resources = await collector.discoverResources({ root: options.root });
    const collected: UsageEvidenceV2[] = [];
    const diagnostics: string[] = [];
    let remainingEvidence = MAX_EVIDENCE_PER_RUN;
    let remainingLines = MAX_NEW_LINES_PER_RUN;
    for (const resource of resources) {
      if (remainingEvidence === 0 || remainingLines === 0) break;
      const key = sourceCursorKey(collector.agent, collector.surface, collector.source, resource);
      const legacyCursor = state.cursors[`${collector.agent}:${resource}`] ??
        (collector.agent === "claude-code" ? state.cursors[resource] : undefined);
      const cursor = sourceCursors[key] ?? legacyCursor ?? 0;
      let result = await collector.collectResource(resource, cursor, {
        maxEvidence: remainingEvidence,
        maxLines: remainingLines,
      });
      if (typeof cursor === "number" && cursor > 0 && result.lastLine < cursor) {
        result = await collector.collectResource(resource, 0, {
          maxEvidence: remainingEvidence,
          maxLines: remainingLines,
        });
      }
      const previousLine = typeof cursor === "number" ? cursor : cursor.line;
      const effectiveLine = result.lastLine < previousLine ? 0 : previousLine;
      const advancedLines = Math.max(0, result.lastLine - effectiveLine);
      if (result.evidence.length > remainingEvidence || advancedLines > remainingLines) {
        throw new Error(`Collector ${collector.agent} exceeded its local work budget.`);
      }
      collected.push(...result.evidence);
      diagnostics.push(...result.diagnostics);
      sourceCursors[key] = result.cursor ?? result.byteCursor ?? result.lastLine;
      remainingEvidence -= result.evidence.length;
      remainingLines -= advancedLines;
    }
    const activeProject = await loadActiveProject();
    const appended = activeProject
      ? await appendEvidenceV3(collected.map((record) => usageEvidenceV3Schema.parse({
        ...record,
        schemaVersion: 3,
        projectId: activeProject.projectId,
      })))
      : await appendEvidence(collected);
    if (resources.length > 0) await saveState({ ...state, sourceCursors });
    await recordQuarantine(options.agent, diagnostics.length);
    if (!options.quiet) {
      log(
        `collected ${appended.appended} ${options.agent} event(s)` +
          (appended.duplicates > 0 ? ` (${appended.duplicates} already spooled)` : ""),
      );
      for (const diagnostic of diagnostics) log(`warning: ${diagnostic}`);
    }
    return 0;
  } catch (error) {
    if (!options.quiet) errorLog(`collect failed: ${error instanceof Error ? error.message : String(error)}`);
    return options.quiet ? 0 : 1;
  } finally {
    await lock?.release();
  }
}
