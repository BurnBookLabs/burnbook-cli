import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  ApiResponseError,
  ApiTimeoutError,
  DEFAULT_API_ORIGIN,
  canonicalApiOrigin,
  getMeSummary,
  postDeviceCode,
  postDeviceToken,
  postDevices,
  postSync,
} from "../../src/core/api.js";
import { getOriginalDispatcher, setupMockFetch, teardownMockFetch } from "../helpers/mockFetch.js";

const ORIGINAL_API = process.env.BURNBOOK_API;
let mockAgent: ReturnType<typeof setupMockFetch>;
let originalDispatcher: ReturnType<typeof getOriginalDispatcher>;

beforeEach(() => {
  process.env.BURNBOOK_API = "https://api.test";
  originalDispatcher = getOriginalDispatcher();
  mockAgent = setupMockFetch();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (ORIGINAL_API === undefined) {
    delete process.env.BURNBOOK_API;
  } else {
    process.env.BURNBOOK_API = ORIGINAL_API;
  }
  teardownMockFetch(mockAgent, originalDispatcher);
});

function envelopeWithMessages(count: number) {
  const payload = {
    deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
    agent: "claude-code",
    sentAt: "2026-08-03T00:00:00.000Z",
    sessions: [{
      sessionId: "session-1",
      messages: Array.from({ length: count }, (_, index) => ({ messageId: `m-${index}` })),
    }],
  };
  return {
    payloadB64: Buffer.from(JSON.stringify(payload)).toString("base64"),
    signatureB64: "signature",
    keyId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
  };
}

describe("api", () => {
  it("postDeviceCode returns the parsed response on 200", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, {
        code: "ABCD-1234",
        pollSecret: "A".repeat(43),
        verificationUrl: "https://api.test/device?code=ABCD-1234",
        expiresIn: 900,
      });

    const result = await postDeviceCode();
    expect(result).toEqual({
      code: "ABCD-1234",
      pollSecret: "A".repeat(43),
      verificationUrl: "https://api.test/device?code=ABCD-1234",
      expiresIn: 900,
    });
  });

  it("postDeviceToken throws ApiError(428) while pending", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(428, { error: "pending" });

    await expect(postDeviceToken("ABCD-1234", "A".repeat(43))).rejects.toMatchObject({ status: 428 });
  });

  it("postDeviceToken throws ApiError(410) once expired/used", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(410, { error: "gone" });

    const err = await postDeviceToken("ABCD-1234", "A".repeat(43)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(410);
  });

  it("postDeviceToken throws ApiError(429) with retryAfterSeconds parsed from the header", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(429, { error: "rate limit exceeded" }, { headers: { "retry-after": "5" } });

    const err = await postDeviceToken("ABCD-1234", "A".repeat(43)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it("postDeviceToken returns the deviceToken on 200", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(200, { deviceToken: "raw-token-abc" });

    const result = await postDeviceToken("ABCD-1234", "A".repeat(43));
    expect(result).toEqual({ deviceToken: "raw-token-abc" });
  });

  it("postDevices sends a Bearer header and returns deviceId", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/devices", method: "POST", headers: { authorization: "Bearer raw-token-abc" } })
      .reply(200, { deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    const result = await postDevices("https://api.test", "raw-token-abc", { keyId: "k1", publicKeyB64: "pk" });
    expect(result).toEqual({ deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });
  });

  it("postSync surfaces a 500 as ApiError", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(500, { error: "internal error" });

    const err = await postSync("https://api.test", "tok", { payloadB64: "x", signatureB64: "y", keyId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  it("rejects a successful response with unknown fields", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, { handle: "burnbooklabs", totalTokens: 1, todayTokens: 1, streakDays: 1, prompt: "private" });

    await expect(getMeSummary("https://api.test", "tok")).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("requires accepted and duplicate counts to reconcile exactly", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(200, { accepted: 1, duplicates: 0 });

    await expect(postSync("https://api.test", "tok", envelopeWithMessages(2))).rejects.toThrow(/inconsistent sync acknowledgement/);
  });

  it("accepts an exact accepted plus duplicates acknowledgement", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/sync", method: "POST" })
      .reply(200, { accepted: 1, duplicates: 1 });

    await expect(postSync("https://api.test", "tok", envelopeWithMessages(2))).resolves.toEqual({ accepted: 1, duplicates: 1 });
  });

  it("aborts a request that exceeds the bounded timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    const result = expect(postDeviceCode()).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    await result;
  });

  it("getMeSummary returns the parsed summary", async () => {
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, { handle: "burnbooklabs", totalTokens: 100, todayTokens: 10, streakDays: 3 });

    const result = await getMeSummary("https://api.test", "tok");
    expect(result).toEqual({ handle: "burnbooklabs", totalTokens: 100, todayTokens: 10, streakDays: 3 });
  });
});

describe("api base url", () => {
  // The published binary has no .env and no config for this — whatever the
  // default is, is where every `npx burnbook` user's traffic goes. It shipped
  // as http://localhost:3000 once; that must not regress.
  it("defaults to the production origin over https", async () => {
    delete process.env.BURNBOOK_API;
    mockAgent
      .get("https://burnbook.dev")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, { handle: "burnbooklabs", totalTokens: 1, todayTokens: 1, streakDays: 1 });

    await expect(getMeSummary(DEFAULT_API_ORIGIN, "tok")).resolves.toMatchObject({ handle: "burnbooklabs" });
  });

  it("refuses plaintext to a non-loopback host", async () => {
    await expect(getMeSummary("http://evil.example", "tok")).rejects.toThrow(/must use HTTPS/);
  });

  it("still allows plaintext to localhost for the docker stack", async () => {
    process.env.BURNBOOK_API = "http://localhost:3010";
    mockAgent
      .get("http://localhost:3010")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, { handle: "dev", totalTokens: 0, todayTokens: 0, streakDays: 0 });

    await expect(getMeSummary("http://localhost:3010", "tok")).resolves.toMatchObject({ handle: "dev" });
  });

  it("tolerates a trailing slash without doubling it into the path", async () => {
    process.env.BURNBOOK_API = "https://api.test/";
    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, { handle: "burnbooklabs", totalTokens: 0, todayTokens: 0, streakDays: 0 });

    await expect(getMeSummary("https://api.test/", "tok")).resolves.toMatchObject({ handle: "burnbooklabs" });
  });

  it("rejects a malformed override rather than silently falling back", async () => {
    await expect(getMeSummary("not-a-url", "tok")).rejects.toThrow(/origin is invalid/);
  });

  it("rejects credentials, paths, queries, and fragments without reflecting secrets", () => {
    const unsafe = "https://private-token@api.test/internal?secret=hidden#credential";
    let message = "";
    try {
      canonicalApiOrigin(unsafe);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must not contain credentials");
    expect(message).not.toContain("private-token");
    expect(message).not.toContain("internal");
    expect(message).not.toContain("hidden");
  });
});
