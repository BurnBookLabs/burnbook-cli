import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_API_ORIGIN } from "../../src/core/api.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
const ORIGINAL_API = process.env.BURNBOOK_API;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-config-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
  delete process.env.BURNBOOK_API;
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("loadConfig returns undefined when no config file exists", async () => {
    expect(await loadConfig()).toBeUndefined();
  });

  it("round-trips a credential bound to its canonical API origin, file mode 0600", async () => {
    await saveConfig({ deviceToken: "tok-123", deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });

    const configPath = path.join(tmpDir, "config.json");
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const dirStat = await fs.stat(tmpDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const loaded = await loadConfig();
    expect(loaded).toEqual({
      deviceToken: "tok-123",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: DEFAULT_API_ORIGIN,
    });
  });

  it("loadConfig returns undefined for a malformed config file", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.json"), "not json", "utf8");
    expect(await loadConfig()).toBeUndefined();
  });

  it("replaces a config symlink without modifying its target", async () => {
    const sentinel = path.join(tmpDir, "sentinel");
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(sentinel, "untouched");
    await fs.symlink(sentinel, configPath);

    await saveConfig({ deviceToken: "tok", deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f" });
    expect(await fs.readFile(sentinel, "utf8")).toBe("untouched");
    expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(false);
  });

  it("loads a legacy production config without accepting an alternate-origin override", async () => {
    await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify({
      deviceToken: "legacy-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
    }));

    await expect(loadConfig()).resolves.toEqual({
      deviceToken: "legacy-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: DEFAULT_API_ORIGIN,
    });

    process.env.BURNBOOK_API = "https://staging.burnbook.dev";
    await expect(loadConfig()).rejects.toThrow("does not match the origin bound to this device");
  });

  it("rejects a mismatched ambient override without exposing either origin", async () => {
    await saveConfig({
      deviceToken: "private-token",
      deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
      apiOrigin: "https://staging.burnbook.dev",
    });
    process.env.BURNBOOK_API = "https://attacker.example/private?token=secret";

    const error = await loadConfig().catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("private-token");
    expect(error.message).not.toContain("attacker.example");
    expect(error.message).not.toContain("secret");
  });
});
