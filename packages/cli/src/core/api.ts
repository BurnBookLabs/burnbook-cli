import {
  syncResponseV2Schema,
  tokenTotalsSchema,
  type SignedEnvelope,
  type SyncResponseV2,
} from "@burnbook/schema";
import { z } from "zod";

export const DEFAULT_API_ORIGIN = "https://burnbook.dev";
export const API_REQUEST_TIMEOUT_MS = 30_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function canonicalApiOrigin(raw = process.env.BURNBOOK_API ?? DEFAULT_API_ORIGIN): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Burnbook API origin is invalid.");
  }
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Burnbook API origin must use HTTPS; HTTP is allowed for loopback development only.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Burnbook API origin must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Burnbook API origin must not contain credentials, paths, queries, or fragments.");
  }
  return url.origin;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

export class ApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export class ApiTimeoutError extends TypeError {
  constructor() {
    super("Burnbook API request timed out");
    this.name = "ApiTimeoutError";
  }
}

async function request<T>(origin: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) onAbort();
  else init?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${canonicalApiOrigin(origin)}${path}`, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader === null ? undefined : Number(retryAfterHeader);
      throw new ApiError(
        response.status,
        body,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiResponseError("Burnbook API returned an invalid response");
    return parsed.data;
  } catch (error) {
    if (timedOut) throw new ApiTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onAbort);
  }
}

function jsonHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

export interface DeviceCodeResponse {
  code: string;
  pollSecret: string;
  verificationUrl: string;
  expiresIn: number;
}

const deviceCodeResponseSchema = z.object({
  code: z.string().min(1),
  pollSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verificationUrl: z.string().url(),
  expiresIn: z.number().int().positive(),
}).strict();

export function postDeviceCode(origin = canonicalApiOrigin()): Promise<DeviceCodeResponse> {
  return request(origin, "/api/v1/device/code", deviceCodeResponseSchema, { method: "POST" });
}

export interface DeviceTokenResponse {
  deviceToken: string;
}

const deviceTokenResponseSchema = z.object({ deviceToken: z.string().min(1) }).strict();

export function postDeviceToken(
  code: string,
  pollSecret: string,
  origin = canonicalApiOrigin(),
): Promise<DeviceTokenResponse> {
  return request(origin, "/api/v1/device/token", deviceTokenResponseSchema, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ code, pollSecret }),
  });
}

export interface RegisterDeviceInput {
  keyId: string;
  publicKeyB64: string;
  label?: string;
}

export interface RegisterDeviceResponse {
  deviceId: string;
}

const registerDeviceResponseSchema = z.object({ deviceId: z.string().uuid() }).strict();

export function postDevices(
  origin: string,
  deviceToken: string,
  input: RegisterDeviceInput,
): Promise<RegisterDeviceResponse> {
  return request(origin, "/api/v1/devices", registerDeviceResponseSchema, {
    method: "POST",
    headers: jsonHeaders(deviceToken),
    body: JSON.stringify(input),
  });
}

export interface SyncResponse {
  accepted: number;
  duplicates: number;
}

const syncResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
}).strict();

export async function postSync(
  origin: string,
  deviceToken: string,
  envelope: SignedEnvelope,
): Promise<SyncResponse> {
  const response = await request(origin, "/api/v1/sync", syncResponseSchema, {
    method: "POST",
    headers: jsonHeaders(deviceToken),
    body: JSON.stringify(envelope),
  });
  const expected = envelopeMessageCount(envelope);
  if (expected !== undefined && response.accepted + response.duplicates !== expected) {
    throw new ApiResponseError("Burnbook API returned an inconsistent sync acknowledgement");
  }
  return response;
}

export async function postSyncV2(
  origin: string,
  deviceToken: string,
  envelope: SignedEnvelope,
  signal?: AbortSignal,
): Promise<SyncResponseV2> {
  return request(origin, "/api/v2/sync", syncResponseV2Schema, {
    method: "POST",
    headers: jsonHeaders(deviceToken),
    body: JSON.stringify(envelope),
    signal,
  });
}

export async function postSyncV3(
  origin: string,
  deviceToken: string,
  envelope: SignedEnvelope,
  signal?: AbortSignal,
): Promise<SyncResponseV2> {
  return request(origin, "/api/v3/sync", syncResponseV2Schema, {
    method: "POST",
    headers: jsonHeaders(deviceToken),
    body: JSON.stringify(envelope),
    signal,
  });
}

const publicSnapshotSchema = z.object({
  score: z.number(),
  grade: z.string(),
  tier: z.string(),
  lifetimeTokens: z.number().int().nonnegative(),
  formulaVersion: z.string(),
  evidenceCoverage: z.number().nonnegative(),
  population: z.number().int().nonnegative(),
  seasonId: z.string(),
  supportTier: z.literal("supported"),
  integrityStatus: z.enum(["active", "cleared"]),
  leaderboardEligible: z.boolean(),
  computedAt: z.string().datetime({ offset: true }),
}).strict();

const summaryResponseSchema = z.object({
  handle: z.string().min(1),
  totalTokens: z.number().int().nonnegative(),
  todayTokens: z.number().int().nonnegative(),
  tokenTotals: tokenTotalsSchema.optional(),
  todayTokenTotals: tokenTotalsSchema.optional(),
  streakDays: z.number().int().nonnegative(),
  publicSnapshot: publicSnapshotSchema.nullable().optional(),
}).strict();

export type SummaryResponse = z.infer<typeof summaryResponseSchema>;

export function getMeSummary(origin: string, deviceToken: string): Promise<SummaryResponse> {
  return request(origin, "/api/v1/me/summary", summaryResponseSchema, {
    method: "GET",
    headers: jsonHeaders(deviceToken),
  });
}

const ownedProjectSchema = z.object({
  project: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    public: z.boolean(),
    verificationStatus: z.enum(["unverified", "pending", "verified", "rejected"]),
  }).strict(),
}).strict();

export function getOwnedProject(origin: string, deviceToken: string, slug: string) {
  return request(origin, `/api/v1/me/projects/${encodeURIComponent(slug)}`, ownedProjectSchema, {
    method: "GET",
    headers: jsonHeaders(deviceToken),
  });
}

function envelopeMessageCount(envelope: SignedEnvelope): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(envelope.payloadB64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) return undefined;
  let total = 0;
  for (const session of payload.sessions) {
    if (!isRecord(session) || !Array.isArray(session.messages)) return undefined;
    total += session.messages.length;
  }
  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
