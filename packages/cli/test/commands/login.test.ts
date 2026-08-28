import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { login, LoginError } from "../../src/commands/login.js";
import { loadConfig } from "../../src/core/config.js";
import { getOriginalDispatcher, setupMockFetch, teardownMockFetch } from "../helpers/mockFetch.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
const ORIGINAL_API = process.env.BURNBOOK_API;
const ORIGINAL_NO_OPEN = process.env.BURNBOOK_NO_OPEN;
const POLL_SECRET = "A".repeat(43);
let tmpDir: string;
let mockAgent: ReturnType<typeof setupMockFetch>;
let originalDispatcher: ReturnType<typeof getOriginalDispatcher>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-login-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
  process.env.BURNBOOK_API = "https://api.test";
  // Prevent tests from popping a real browser.
  process.env.BURNBOOK_NO_OPEN = "1";

  originalDispatcher = getOriginalDispatcher();
  mockAgent = setupMockFetch();
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.BURNBOOK_CONFIG_DIR;
  } else {
    process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
  if (ORIGINAL_API === undefined) {
    delete process.env.BURNBOOK_API;
  } else {
    process.env.BURNBOOK_API = ORIGINAL_API;
  }
  if (ORIGINAL_NO_OPEN === undefined) {
    delete process.env.BURNBOOK_NO_OPEN;
  } else {
    process.env.BURNBOOK_NO_OPEN = ORIGINAL_NO_OPEN;
  }
  teardownMockFetch(mockAgent, originalDispatcher);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("login", () => {
  it("polls through a 428, then registers the device and writes config.json (mode 0600)", async () => {
    const pool = mockAgent.get("https://api.test");

    pool
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, {
        code: "ABCD-1234",
        pollSecret: POLL_SECRET,
        verificationUrl: "https://api.test/device?code=ABCD-1234#approval",
        expiresIn: 900,
      });

    // First poll: still pending.
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(428, { error: "pending" });
    // Second poll: approved.
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(200, { deviceToken: "raw-device-token" });

    pool
      .intercept({ path: "/api/v1/devices", method: "POST", headers: { authorization: "Bearer raw-device-token" } })
      .reply(200, { deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    const logs: string[] = [];
    const openUrlCalls: string[] = [];
    const result = await login({
      pollIntervalMs: 1,
      openUrl: (url) => openUrlCalls.push(url),
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({
      deviceToken: "raw-device-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: "https://api.test",
    });
    const output = logs.join("\n");
    expect(output).toContain("  https://api.test/device");
    expect(output).toContain("  ABCD-1234");
    expect(output).not.toContain("device?");
    expect(openUrlCalls).toEqual(["https://api.test/device"]);
    expect(new URL(openUrlCalls[0]).search).toBe("");
    expect(openUrlCalls[0]).not.toContain("ABCD-1234");

    const configPath = path.join(tmpDir, "config.json");
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const loaded = await loadConfig();
    expect(loaded).toEqual({
      deviceToken: "raw-device-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: "https://api.test",
    });
  });

  it("classifies a registration response mismatch without exposing response details", async () => {
    const pool = mockAgent.get("https://api.test");
    pool.intercept({ path: "/api/v1/device/code", method: "POST" }).reply(200, {
      code: "ABCD-1234",
      pollSecret: POLL_SECRET,
      verificationUrl: "https://api.test/device",
      expiresIn: 900,
    });
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(200, {
      deviceToken: "raw-device-token",
    });
    pool.intercept({ path: "/api/v1/devices", method: "POST" }).reply(200, {
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      unexpectedInternalField: "must-not-leak",
    });
    const diagnostics: unknown[] = [];

    await expect(login({
      openUrl: () => {},
      log: () => {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).rejects.toThrow("Device approval completed, but registration failed");
    expect(diagnostics).toEqual([{
      code: "device-registration",
      category: "invalid-response",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
    expect(await loadConfig()).toBeUndefined();
  });

  it("survives a 429 (rate limited) poll and completes successfully", async () => {
    const pool = mockAgent.get("https://api.test");

    pool
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, { code: "ABCD-1234", pollSecret: POLL_SECRET, verificationUrl: "https://api.test/device", expiresIn: 900 });

    // First poll: rate limited (transient, must not kill the flow).
    pool
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(429, { error: "rate limit exceeded" }, { headers: { "retry-after": "0" } });
    // Second poll: still pending.
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(428, { error: "pending" });
    // Third poll: approved.
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(200, { deviceToken: "raw-device-token" });

    pool
      .intercept({ path: "/api/v1/devices", method: "POST", headers: { authorization: "Bearer raw-device-token" } })
      .reply(200, { deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    const result = await login({
      pollIntervalMs: 1,
      openUrl: () => {},
      log: () => {},
    });

    expect(result).toEqual({
      deviceToken: "raw-device-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: "https://api.test",
    });
  });

  it("fails cleanly with LoginError when the device code is gone (410)", async () => {
    const pool = mockAgent.get("https://api.test");

    pool
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, { code: "ABCD-1234", pollSecret: POLL_SECRET, verificationUrl: "https://api.test/device", expiresIn: 900 });

    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(410, { error: "gone" });

    await expect(login({ pollIntervalMs: 1, openUrl: () => {}, log: () => {} })).rejects.toThrow(LoginError);

    expect(await loadConfig()).toBeUndefined();
  });

  it("rejects unsafe verification URLs before opening or polling", async () => {
    mockAgent.get("https://api.test")
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, {
        code: "ABCD-1234",
        pollSecret: POLL_SECRET,
        verificationUrl: "file:///tmp/untrusted#ABCD-1234",
        expiresIn: 900,
      });
    const opened: string[] = [];

    await expect(login({ openUrl: (url) => opened.push(url), log: () => {} }))
      .rejects.toThrow("unsafe device verification URL");
    expect(opened).toEqual([]);
    expect(await loadConfig()).toBeUndefined();
  });

  it.each([
    "http://verification.example/device?code=ABCD-1234",
    "http://localhost.example/device?code=ABCD-1234",
    "http://127.0.0.2/device?code=ABCD-1234",
  ])("rejects remote HTTP verification URL %s before opening or polling", async (verificationUrl) => {
    mockAgent.get("https://api.test")
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, {
        code: "ABCD-1234",
        pollSecret: POLL_SECRET,
        verificationUrl,
        expiresIn: 900,
      });
    const opened: string[] = [];

    await expect(login({ openUrl: (url) => opened.push(url), log: () => {} }))
      .rejects.toThrow("unsafe device verification URL");
    expect(opened).toEqual([]);
    expect(await loadConfig()).toBeUndefined();
  });

  it.each([
    "http://localhost:3000/device?code=ABCD-1234",
    "http://127.0.0.1:3000/device?code=ABCD-1234",
    "http://[::1]:3000/device?code=ABCD-1234",
  ])("allows loopback HTTP verification URL %s", async (verificationUrl) => {
    const pool = mockAgent.get("https://api.test");
    pool
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, { code: "ABCD-1234", pollSecret: POLL_SECRET, verificationUrl, expiresIn: 900 });
    pool.intercept({ path: "/api/v1/device/token", method: "POST" }).reply(200, { deviceToken: "raw-device-token" });
    pool
      .intercept({ path: "/api/v1/devices", method: "POST", headers: { authorization: "Bearer raw-device-token" } })
      .reply(200, { deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });
    const opened: string[] = [];

    await login({ openUrl: (url) => opened.push(url), log: () => {} });

    expect(opened).toEqual([verificationUrl.replace("?code=ABCD-1234", "")]);
  });

  it("rejects device codes containing terminal control characters", async () => {
    mockAgent.get("https://api.test")
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, {
        code: "ABCD\nTOKEN",
        pollSecret: POLL_SECRET,
        verificationUrl: "https://api.test/device",
        expiresIn: 900,
      });

    await expect(login({ openUrl: () => {}, log: () => {} }))
      .rejects.toThrow("invalid device code");
    expect(await loadConfig()).toBeUndefined();
  });

  it("times out waiting for approval after timeoutMs elapses (428 always)", async () => {
    const pool = mockAgent.get("https://api.test");

    pool
      .intercept({ path: "/api/v1/device/code", method: "POST" })
      .reply(200, { code: "ABCD-1234", pollSecret: POLL_SECRET, verificationUrl: "https://api.test/device", expiresIn: 900 });

    // Always return 428 (pending) — the polling will timeout.
    // Use .times() to allow many polls before the timeout kicks in.
    pool
      .intercept({ path: "/api/v1/device/token", method: "POST" })
      .reply(428, { error: "pending" })
      .times(100);

    try {
      await login({ timeoutMs: 30, pollIntervalMs: 1, openUrl: () => {}, log: () => {} });
      expect.fail("Expected login to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LoginError);
      expect((err as LoginError).message).toContain("Timed out waiting for approval");
    }

    expect(await loadConfig()).toBeUndefined();
  });
});
