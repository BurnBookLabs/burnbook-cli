import { execFile } from "node:child_process";
import * as os from "node:os";
import {
  ApiError,
  ApiResponseError,
  canonicalApiOrigin,
  postDeviceCode,
  postDeviceToken,
  postDevices,
} from "../core/api.js";
import { saveConfig, type CliConfig } from "../core/config.js";
import { ensureKeypair } from "../core/keys.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LOOPBACK_VERIFICATION_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type LoginFailureCode =
  | "device-code-request"
  | "invalid-device-code"
  | "invalid-verification-url"
  | "approval-timeout"
  | "approval-expired"
  | "token-poll"
  | "device-key"
  | "device-registration"
  | "config-write"
  | "unexpected";

export interface LoginDiagnostic {
  code: LoginFailureCode;
  category: "api" | "invalid-response" | "transport" | "local" | "validation" | "unknown";
  apiStatus?: number;
}

/** A bounded public error plus a content-free diagnostic code. */
export class LoginError extends Error {
  constructor(
    public readonly code: LoginFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LoginError";
  }
}

export interface LoginOptions {
  /** How often to poll device/token. Overridable for tests. */
  pollIntervalMs?: number;
  /** Give up waiting for approval after this long. Overridable for tests. */
  timeoutMs?: number;
  /** Injected browser-open function; defaults to `/usr/bin/open` on darwin. */
  openUrl?: (url: string) => void;
  log?: (message: string) => void;
  onDiagnostic?: (diagnostic: LoginDiagnostic) => void;
}

/* `burn login`: device-code flow. */
export async function login(opts: LoginOptions = {}): Promise<CliConfig> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const openUrl = opts.openUrl ?? createDefaultOpenUrl();
  const log = opts.log ?? ((message: string) => console.log(message));

  try {
    const apiOrigin = canonicalApiOrigin();
    const { code, pollSecret, verificationUrl } = await loginStage(
      "device-code-request",
      "Could not start device authorization. Try again.",
      () => postDeviceCode(apiOrigin),
    );
    const safeCode = validateDeviceCode(code);
    const safeVerificationUrl = sanitizeVerificationUrl(verificationUrl);
    log(`\nTo authorize this device, open:\n\n  ${safeVerificationUrl}\n`);
    log(`Then enter this one-time code:\n\n  ${safeCode}\n`);
    tryOpenBrowser(safeVerificationUrl, openUrl);

    const deviceToken = await pollForToken(
      safeCode,
      pollSecret,
      apiOrigin,
      pollIntervalMs,
      timeoutMs,
    );
    const { keyId, publicKeyB64 } = await loginStage(
      "device-key",
      "Could not prepare this device securely.",
      ensureKeypair,
    );
    const { deviceId } = await loginStage(
      "device-registration",
      "Device approval completed, but registration failed. Run `burn login` again.",
      () => postDevices(apiOrigin, deviceToken, { keyId, publicKeyB64, label: os.hostname() }),
    );

    const config: CliConfig = { deviceToken, deviceId, apiOrigin };
    await loginStage(
      "config-write",
      "Device registration completed, but credentials could not be saved safely.",
      () => saveConfig(config),
    );

    log("Logged in.");
    return config;
  } catch (error) {
    const loginError = error instanceof LoginError
      ? error
      : new LoginError("unexpected", "Device login failed. Try again.", { cause: error });
    try { opts.onDiagnostic?.(loginDiagnostic(loginError)); } catch { /* diagnostics never break login */ }
    throw loginError;
  }
}

async function pollForToken(
  code: string,
  pollSecret: string,
  apiOrigin: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const { deviceToken } = await postDeviceToken(code, pollSecret, apiOrigin);
      return deviceToken;
    } catch (err) {
      if (err instanceof ApiError && err.status === 428) {
        if (Date.now() >= deadline) {
          throw new LoginError("approval-timeout", "Timed out waiting for approval. Run `burn login` again.");
        }
        await sleep(intervalMs);
        continue;
      }
      if (err instanceof ApiError && err.status === 429) {
        if (Date.now() >= deadline) {
          throw new LoginError("approval-timeout", "Timed out waiting for approval. Run `burn login` again.");
        }
        const waitMs = err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : intervalMs * 1.5;
        await sleep(waitMs);
        continue;
      }
      if (err instanceof ApiError && err.status === 410) {
        throw new LoginError("approval-expired", "Device code expired or already used. Run `burn login` again.");
      }
      throw new LoginError("token-poll", "Could not check device approval. Try again.", { cause: err });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateDeviceCode(value: string): string {
  if (!/^[A-Za-z0-9-]{3,32}$/.test(value)) {
    throw new LoginError("invalid-device-code", "Burnbook returned an invalid device code.");
  }
  return value;
}

function sanitizeVerificationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoginError("invalid-verification-url", "Burnbook returned an invalid device verification URL.");
  }
  const secureTransport = url.protocol === "https:";
  const localDevelopment = url.protocol === "http:" && LOOPBACK_VERIFICATION_HOSTS.has(url.hostname);
  if ((!secureTransport && !localDevelopment) || url.username || url.password) {
    throw new LoginError("invalid-verification-url", "Burnbook returned an unsafe device verification URL.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function loginStage<T>(
  code: LoginFailureCode,
  publicMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError(code, publicMessage, { cause: error });
  }
}

export function loginDiagnostic(error: LoginError): LoginDiagnostic {
  const cause = error.cause;
  if (cause instanceof ApiError) return { code: error.code, category: "api", apiStatus: cause.status };
  if (cause instanceof ApiResponseError) return { code: error.code, category: "invalid-response" };
  if (cause instanceof TypeError) return { code: error.code, category: "transport" };
  if (error.code === "invalid-device-code" || error.code === "invalid-verification-url") {
    return { code: error.code, category: "validation" };
  }
  if (cause instanceof Error && "code" in cause) return { code: error.code, category: "local" };
  return { code: error.code, category: "unknown" };
}

/**
 * Create the default browser-open function (darwin only).
 * Respects BURNBOOK_NO_OPEN env var for CI/headless environments.
 */
function createDefaultOpenUrl(): (url: string) => void {
  return (url: string) => {
    if (process.env.BURNBOOK_NO_OPEN) return;
    if (process.platform !== "darwin") return;
    try {
      execFile("/usr/bin/open", [url], () => {
        // ignore result — the URL was already printed above.
      });
    } catch {
      // ignore — e.g. `open` not on PATH.
    }
  };
}

/** Best-effort only: never lets a failure to open a browser break login. */
function tryOpenBrowser(url: string, openUrl: (url: string) => void): void {
  try {
    openUrl(url);
  } catch {
    // ignore — injected function failure should not break login.
  }
}
