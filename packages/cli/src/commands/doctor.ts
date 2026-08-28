import { promises as fs } from "node:fs";
import * as path from "node:path";
import { agentCompatibilityRegistry, type AgentId } from "@burnbook/schema";
import { getCollector, listCollectors } from "../collectors/registry.js";
import { collectorGateLabel, supportFor } from "../collectors/support.js";
import { loadConfig } from "../core/config.js";
import { inspectBackgroundState } from "../core/background-state.js";
import { configDir } from "../core/paths.js";
import { readPrivateFile } from "../core/private-files.js";
import { inspectSpool } from "../core/spool.js";
import { inspectSpoolV3 } from "../core/spool-v3.js";

export type DoctorCheckStatus = "ok" | "warning" | "error";
export type SchedulerInspectionStatus =
  | "enabled"
  | "disabled"
  | "unsupported"
  | "misconfigured"
  | "unavailable";

export interface SchedulerInspection {
  status: SchedulerInspectionStatus;
}

export interface BackgroundServiceInspection {
  state: "not-installed" | "installed" | "needs-repair" | "conflict";
}

export interface DoctorCheck {
  id: "authentication" | "permissions" | "scheduler" | "worker" | "spool" | "background";
  status: DoctorCheckStatus;
  code: string;
  count?: number;
  detail?: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  agent?: AgentId;
  root?: string;
  inspectScheduler?: () => Promise<SchedulerInspection | BackgroundServiceInspection>;
  now?: Date;
  staleAfterMs?: number;
  processIsAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export async function inspectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks = await Promise.all([
    inspectAuthentication(),
    inspectPermissions(),
    inspectScheduler(options.inspectScheduler),
    inspectWorker(options.processIsAlive ?? defaultProcessIsAlive),
    inspectLocalSpool(),
    inspectBackground(options.now ?? new Date(), options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
  ]);
  return { healthy: checks.every((check) => check.status !== "error"), checks };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog = options.errorLog ?? ((message: string) => console.error(message));
  const collectors = options.agent
    ? [getCollector(options.agent)].filter(Boolean)
    : [...listCollectors()];
  if (collectors.length === 0) {
    errorLog(`Unknown collector: ${options.agent}`);
    return 1;
  }

  log(
    `compatibility registry v${agentCompatibilityRegistry.registryVersion}; ` +
    `evidence schema v${agentCompatibilityRegistry.evidenceSchemaVersion}`,
  );
  let collectorError = false;
  for (const collector of collectors) {
    const detected = await collector!.detect({ root: options.root });
    const support = supportFor(collector!.agent)!;
    const output =
      `${support.displayName} [${support.supportTier}/collector gate: ` +
      `${collectorGateLabel(support.certification.status)}]: ${detected.status} — ${detected.detail}`;
    if (detected.status === "degraded") {
      collectorError = true;
      errorLog(output);
    } else {
      log(output);
    }
  }

  const report = await inspectDoctor(options);
  for (const check of report.checks) {
    const output = `${check.id}: ${messageFor(check)}${check.detail ? ` (${check.detail})` : ""}`;
    if (check.status === "error") errorLog(output);
    else log(output);
  }
  return report.healthy && !collectorError ? 0 : 1;
}

async function inspectAuthentication(): Promise<DoctorCheck> {
  try {
    return await loadConfig()
      ? { id: "authentication", status: "ok", code: "logged-in" }
      : { id: "authentication", status: "error", code: "login-required" };
  } catch {
    return { id: "authentication", status: "error", code: "config-unreadable" };
  }
}

async function inspectPermissions(): Promise<DoctorCheck> {
  try {
    const directoryMode = await modeOf(configDir());
    const configMode = await modeOf(path.join(configDir(), "config.json"));
    const keyMode = await modeOf(path.join(configDir(), "key.json"));
    if (configMode !== undefined && keyMode === undefined) {
      return { id: "permissions", status: "error", code: "key-missing" };
    }
    const modes = [directoryMode, configMode, keyMode]
      .filter((mode): mode is number => mode !== undefined);
    return modes.every((mode) => (mode & 0o077) === 0)
      ? { id: "permissions", status: "ok", code: "private" }
      : { id: "permissions", status: "error", code: "too-broad" };
  } catch {
    return { id: "permissions", status: "error", code: "unreadable" };
  }
}

async function inspectScheduler(inspector: DoctorOptions["inspectScheduler"]): Promise<DoctorCheck> {
  if (!inspector) return { id: "scheduler", status: "warning", code: "inspection-unavailable" };
  try {
    const inspection = await inspector();
    const code = "status" in inspection ? inspection.status : schedulerCode(inspection.state);
    return {
      id: "scheduler",
      status: code === "enabled" ? "ok" : code === "unsupported" ? "warning" : "error",
      code,
    };
  } catch {
    return { id: "scheduler", status: "error", code: "inspection-failed" };
  }
}

function schedulerCode(state: BackgroundServiceInspection["state"]): SchedulerInspectionStatus {
  if (state === "installed") return "enabled";
  if (state === "not-installed") return "disabled";
  return "misconfigured";
}

async function inspectWorker(processIsAlive: (pid: number) => boolean): Promise<DoctorCheck> {
  const workerPath = path.join(configDir(), "sync-worker.lock");
  let raw: string | undefined;
  try {
    raw = await readPrivateFile(workerPath);
  } catch {
    return { id: "worker", status: "error", code: "lock-unreadable" };
  }
  if (raw === undefined) return { id: "worker", status: "ok", code: "idle" };
  try {
    const mode = await modeOf(workerPath);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      return { id: "worker", status: "error", code: "lock-permissions-too-broad" };
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== "string") {
      return { id: "worker", status: "error", code: "lock-malformed" };
    }
    return processIsAlive(Number(value.pid))
      ? { id: "worker", status: "ok", code: "active" }
      : { id: "worker", status: "error", code: "lock-stale" };
  } catch {
    return { id: "worker", status: "error", code: "lock-malformed" };
  }
}

async function inspectLocalSpool(): Promise<DoctorCheck> {
  try {
    const spool = await inspectSpool();
    const spoolV3 = await inspectSpoolV3();
    const queued = spool.pending + spoolV3.pending;
    const details = [
      `${spool.queueBytes + spoolV3.queueBytes} bytes`,
      `${spool.quarantined + spoolV3.quarantined} quarantined`,
      earliest(spool.oldestPendingAt, spoolV3.oldestPendingAt) ?
        `oldest ${earliest(spool.oldestPendingAt, spoolV3.oldestPendingAt)}` : undefined,
      latest(spool.lastAcknowledgedAt, spoolV3.lastAcknowledgedAt) ?
        `last ack ${latest(spool.lastAcknowledgedAt, spoolV3.lastAcknowledgedAt)}` : undefined,
    ].filter(Boolean).join("; ");
    if (!spool.privatePermissions || !spoolV3.privatePermissions) {
      return { id: "spool", status: "error", code: "permissions-too-broad", count: spool.pending };
    }
    if (spool.malformed + spoolV3.malformed > 0) {
      return { id: "spool", status: "error", code: "malformed", count: spool.malformed + spoolV3.malformed };
    }
    return queued > 0
      ? { id: "spool", status: "warning", code: "pending", count: queued, detail: details }
      : { id: "spool", status: "ok", code: "empty", count: 0 };
  } catch {
    return { id: "spool", status: "error", code: "unreadable" };
  }
}

function earliest(left?: string, right?: string): string | undefined {
  return [left, right].filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(left?: string, right?: string): string | undefined {
  return [left, right].filter((value): value is string => Boolean(value)).sort().at(-1);
}

async function inspectBackground(now: Date, staleAfterMs: number): Promise<DoctorCheck> {
  try {
    const inspection = await inspectBackgroundState();
    if (!inspection.privatePermissions) {
      return { id: "background", status: "error", code: "permissions-too-broad" };
    }
    if (inspection.status === "invalid") {
      return { id: "background", status: "error", code: "state-invalid" };
    }
    if (!inspection.state?.lastSuccessAt) {
      return { id: "background", status: "error", code: "never-succeeded" };
    }
    if (inspection.state.status === "authentication-required") {
      return { id: "background", status: "error", code: "authentication-required" };
    }
    const age = now.getTime() - Date.parse(inspection.state.lastSuccessAt);
    if (!Number.isFinite(age) || age < 0) {
      return { id: "background", status: "error", code: "state-invalid" };
    }
    if (age > staleAfterMs) {
      return { id: "background", status: "error", code: "last-success-stale" };
    }
    if (inspection.state.status === "backoff") {
      return { id: "background", status: "warning", code: "retry-scheduled" };
    }
    return { id: "background", status: "ok", code: "recent-success" };
  } catch {
    return { id: "background", status: "error", code: "state-unreadable" };
  }
}

function messageFor(check: DoctorCheck): string {
  const messages: Record<string, string> = {
    "logged-in": "device credentials are available",
    "login-required": "login required; run `burn login`",
    "config-unreadable": "device configuration is unreadable",
    private: "local files are owner-only",
    "key-missing": "the device key is missing; run `burn login`",
    "too-broad": "local file permissions are too broad",
    unreadable: "local files are unreadable",
    enabled: "automatic sync is enabled",
    disabled: "automatic sync is disabled; run `burn repair`",
    unsupported: "automatic sync is unsupported on this platform",
    misconfigured: "automatic sync needs repair; run `burn repair`",
    unavailable: "automatic sync status is unavailable",
    "inspection-unavailable": "automatic sync inspection is unavailable",
    "inspection-failed": "automatic sync inspection failed",
    idle: "no sync worker is active",
    active: "a sync worker is active",
    "lock-unreadable": "sync worker state is unreadable",
    "lock-malformed": "sync worker state is invalid; run `burn repair`",
    "lock-permissions-too-broad": "sync worker state permissions need repair",
    "lock-stale": "a stale sync worker lock needs repair",
    empty: "delivery queue is empty",
    pending: `${check.count ?? 0} event(s) are queued for delivery`,
    malformed: "the delivery queue contains malformed records",
    "permissions-too-broad": "owner-only permissions need repair",
    "state-invalid": "background sync health state is invalid",
    "state-unreadable": "background sync health state is unreadable",
    "never-succeeded": "background sync has not completed yet",
    "authentication-required": "background delivery needs a new login",
    "last-success-stale": "the last successful background sync is stale",
    "retry-scheduled": "delivery retry is scheduled",
    "recent-success": "background sync completed recently",
  };
  return messages[check.code] ?? "check failed";
}

async function modeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.lstat(filePath)).mode;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
