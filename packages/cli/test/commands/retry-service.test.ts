import { describe, expect, it, vi } from "vitest";
import { runRetryServiceCommand } from "../../src/commands/retry-service.js";

const CONFIG = {
  deviceId: "device-1",
  deviceToken: "private-device-token",
  apiOrigin: "https://staging.burnbook.dev",
};

describe("retry-service command", () => {
  it("requires an explicit supported action", async () => {
    const manage = vi.fn();
    const errors: string[] = [];
    expect(await runRetryServiceCommand({
      action: "start",
      errorLog: (message) => errors.push(message),
      runtime: { manage },
    })).toBe(1);
    expect(manage).not.toHaveBeenCalled();
    expect(errors).toEqual(["action must be install, status, or remove"]);
  });

  it("requires login only when the user explicitly installs persistence", async () => {
    const manage = vi.fn();
    const errors: string[] = [];
    expect(await runRetryServiceCommand({
      action: "install",
      errorLog: (message) => errors.push(message),
      runtime: { loadConfig: async () => undefined, manage },
    })).toBe(1);
    expect(manage).not.toHaveBeenCalled();
    expect(errors[0]).toContain("burn login");
  });

  it("passes bounded settings to the injected service manager", async () => {
    const manage = vi.fn(async () => ({ exitCode: 0, message: "installed" }));
    const logs: string[] = [];
    expect(await runRetryServiceCommand({
      action: "install",
      intervalSeconds: 90,
      maxBatches: 3,
      log: (message) => logs.push(message),
      runtime: { loadConfig: async () => CONFIG, manage },
    })).toBe(0);
    expect(manage).toHaveBeenCalledWith(
      "install",
      { intervalSeconds: 90, maxBatches: 3 },
      "https://staging.burnbook.dev",
    );
    expect(logs).toEqual(["installed"]);
  });

  it("rejects invalid bounds before reading config or touching a manager", async () => {
    const loadConfig = vi.fn();
    const manage = vi.fn();
    expect(await runRetryServiceCommand({
      action: "install",
      intervalSeconds: 9,
      runtime: { loadConfig, manage },
    })).toBe(1);
    expect(await runRetryServiceCommand({
      action: "install",
      maxBatches: 21,
      runtime: { loadConfig, manage },
    })).toBe(1);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
  });

  it("uses the production origin to inspect or remove a legacy definition without config", async () => {
    const loadConfig = vi.fn();
    const manage = vi.fn(async () => ({ exitCode: 0, message: "not installed" }));
    await runRetryServiceCommand({ action: "status", runtime: { loadConfig, manage } });
    await runRetryServiceCommand({ action: "remove", runtime: { loadConfig, manage } });
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(manage).toHaveBeenCalledTimes(2);
    expect(manage).toHaveBeenNthCalledWith(1, "status", expect.any(Object), "https://burnbook.dev");
    expect(manage).toHaveBeenNthCalledWith(2, "remove", expect.any(Object), "https://burnbook.dev");
  });
});
