import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStatus } from "../../src/commands/status.js";
import { saveConfig } from "../../src/core/config.js";
import { getOriginalDispatcher, setupMockFetch, teardownMockFetch } from "../helpers/mockFetch.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
const ORIGINAL_API = process.env.BURNBOOK_API;
let tmpDir: string;
let mockAgent: ReturnType<typeof setupMockFetch>;
let originalDispatcher: ReturnType<typeof getOriginalDispatcher>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-status-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
  process.env.BURNBOOK_API = "https://api.test";

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
  teardownMockFetch(mockAgent, originalDispatcher);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("status", () => {
  it("returns 1 and does not call the API when not logged in", async () => {
    const errors: string[] = [];
    const code = await runStatus({ errorLog: (m) => errors.push(m) });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("burn login"))).toBe(true);
  });

  it("renders a card with handle, today, total, and streak", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(200, {
        handle: "burnbooklabs",
        totalTokens: 123456,
        todayTokens: 789,
        streakDays: 5,
        publicSnapshot: {
          score: 73,
          grade: "A",
          tier: "silver",
          lifetimeTokens: 120000,
          formulaVersion: "fluency-v1",
          evidenceCoverage: 88,
          population: 101,
          seasonId: "founding",
          supportTier: "supported",
          integrityStatus: "active",
          leaderboardEligible: true,
          computedAt: "2026-08-03T06:00:00.000Z",
        },
      });

    const logs: string[] = [];
    const code = await runStatus({ log: (m) => logs.push(m) });

    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("burnbooklabs");
    expect(output).toContain("123,456");
    expect(output).toContain("789");
    expect(output).toContain("5 days");
    expect(output).toContain("73 (A)");
    expect(output).toContain("120,000 supported");
    expect(output).toContain("88% · fluency-v1");
    expect(output).toContain("founding");
  });

  it("returns 1 on API failure", async () => {
    await saveConfig({ deviceToken: "tok", deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    mockAgent
      .get("https://api.test")
      .intercept({ path: "/api/v1/me/summary", method: "GET" })
      .reply(500, { error: "internal error" });

    const errors: string[] = [];
    const code = await runStatus({ errorLog: (m) => errors.push(m) });
    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
