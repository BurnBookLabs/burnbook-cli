import { promises as fs } from "node:fs";
import * as path from "node:path";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

export const BACKGROUND_STATE_VERSION = 1 as const;

export type BackgroundSyncStatus =
  | "idle"
  | "running"
  | "healthy"
  | "backoff"
  | "authentication-required";

export type BackgroundFailureKind =
  | "network"
  | "rate-limited"
  | "authentication"
  | "server"
  | "local-io"
  | "unknown";

export interface BackgroundState {
  version: typeof BACKGROUND_STATE_VERSION;
  status: BackgroundSyncStatus;
  failureCount: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  nextAttemptAt?: string;
  failureKind?: BackgroundFailureKind;
}

export interface BackgroundStateInspection {
  status: "missing" | "valid" | "invalid";
  privatePermissions: boolean;
  state?: BackgroundState;
}

const statuses = new Set<BackgroundSyncStatus>([
  "idle",
  "running",
  "healthy",
  "backoff",
  "authentication-required",
]);
const failureKinds = new Set<BackgroundFailureKind>([
  "network",
  "rate-limited",
  "authentication",
  "server",
  "local-io",
  "unknown",
]);
const allowedKeys = new Set([
  "version",
  "status",
  "failureCount",
  "lastAttemptAt",
  "lastSuccessAt",
  "lastFailureAt",
  "nextAttemptAt",
  "failureKind",
]);

function statePath(): string {
  return path.join(configDir(), "background-state.json");
}

export async function loadBackgroundState(): Promise<BackgroundState | undefined> {
  return (await inspectBackgroundState()).state;
}

export async function inspectBackgroundState(): Promise<BackgroundStateInspection> {
  let raw: string;
  let mode = 0;
  try {
    const [content, stat] = await Promise.all([readPrivateFile(statePath()), fs.lstat(statePath())]);
    if (content === undefined) return { status: "missing", privatePermissions: true };
    raw = content;
    mode = stat.mode;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { status: "missing", privatePermissions: true };
    throw error;
  }

  const privatePermissions = (mode & 0o077) === 0;
  try {
    const state = parseBackgroundState(JSON.parse(raw));
    return state
      ? { status: "valid", privatePermissions, state }
      : { status: "invalid", privatePermissions };
  } catch {
    return { status: "invalid", privatePermissions };
  }
}

export async function saveBackgroundState(state: BackgroundState): Promise<void> {
  const validated = parseBackgroundState(state);
  if (!validated) throw new Error("Invalid background state.");

  await writePrivateFile(statePath(), `${JSON.stringify(validated, null, 2)}\n`);
}

export function backgroundAttempt(previous: BackgroundState | undefined, at: Date): BackgroundState {
  return {
    version: BACKGROUND_STATE_VERSION,
    status: "running",
    failureCount: previous?.failureCount ?? 0,
    lastAttemptAt: at.toISOString(),
    ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
  };
}

export function backgroundReady(previous: BackgroundState | undefined): BackgroundState {
  return {
    version: BACKGROUND_STATE_VERSION,
    status: "idle",
    failureCount: 0,
    ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
  };
}

export function backgroundSuccess(previous: BackgroundState | undefined, at: Date): BackgroundState {
  return {
    version: BACKGROUND_STATE_VERSION,
    status: "healthy",
    failureCount: 0,
    lastAttemptAt: previous?.lastAttemptAt ?? at.toISOString(),
    lastSuccessAt: at.toISOString(),
  };
}

export function backgroundFailure(
  previous: BackgroundState | undefined,
  kind: BackgroundFailureKind,
  at: Date,
  nextAttemptAt?: Date,
): BackgroundState {
  const authenticationRequired = kind === "authentication";
  return {
    version: BACKGROUND_STATE_VERSION,
    status: authenticationRequired ? "authentication-required" : "backoff",
    failureCount: Math.min((previous?.failureCount ?? 0) + 1, 1_000_000),
    lastAttemptAt: at.toISOString(),
    ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
    lastFailureAt: at.toISOString(),
    failureKind: kind,
    ...(!authenticationRequired && nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
  };
}

function parseBackgroundState(value: unknown): BackgroundState | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (value.version !== BACKGROUND_STATE_VERSION || !statuses.has(value.status as BackgroundSyncStatus)) return undefined;
  if (!Number.isSafeInteger(value.failureCount) || Number(value.failureCount) < 0 || Number(value.failureCount) > 1_000_000) return undefined;
  if (!optionalTimestamp(value.lastAttemptAt) || !optionalTimestamp(value.lastSuccessAt)) return undefined;
  if (!optionalTimestamp(value.lastFailureAt) || !optionalTimestamp(value.nextAttemptAt)) return undefined;
  if (value.failureKind !== undefined && !failureKinds.has(value.failureKind as BackgroundFailureKind)) return undefined;

  return value as unknown as BackgroundState;
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
