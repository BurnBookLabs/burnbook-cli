import { describe, expect, it, vi } from "vitest";
import type { BackgroundService } from "../../src/platform/index.js";
import { runAutomation } from "../../src/commands/automation.js";

function service(overrides: Partial<BackgroundService> = {}): BackgroundService {
  return {
    install: vi.fn(async () => ({ changed: true, detail: "installed" })),
    inspect: vi.fn(async () => ({
      state: "installed", installed: true, loaded: true, managed: true, current: true, detail: "ok",
    })),
    trigger: vi.fn(async () => true),
    remove: vi.fn(async () => ({ changed: true, detail: "removed" })),
    ...overrides,
  };
}

describe("automation lifecycle", () => {
  it("configures hooks, installs the scheduler, and triggers the first run", async () => {
    const calls: string[] = [];
    const background = service({
      install: vi.fn(async () => { calls.push("install"); return { changed: true, detail: "installed" }; }),
      trigger: vi.fn(async () => { calls.push("trigger"); return true; }),
    });
    const code = await runAutomation({
      configureHooks: async () => { calls.push("hooks"); return 0; },
      resolveService: async () => ({ supported: true, service: background }),
      resetBackgroundState: async () => { calls.push("reset"); },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["hooks", "install", "reset", "trigger"]);
  });

  it("keeps Claude hooks usable on an unsupported platform", async () => {
    const logs: string[] = [];
    const code = await runAutomation({
      configureHooks: async () => 0,
      resolveService: async () => ({ supported: false, reason: "unsupported-platform" }),
      log: (message) => logs.push(message),
    });
    expect(code).toBe(0);
    expect(logs.join(" ")).toContain("not yet supported");
  });

  it("removes the scheduler before exact managed hooks", async () => {
    const calls: string[] = [];
    const background = service({
      remove: vi.fn(async () => { calls.push("scheduler"); return { changed: true, detail: "removed" }; }),
    });
    const code = await runAutomation({
      remove: true,
      configureHooks: async (remove) => { calls.push(remove ? "hooks" : "install-hooks"); return 0; },
      resolveService: async () => ({ supported: true, service: background }),
      resetBackgroundState: async () => {},
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["scheduler", "hooks"]);
  });

  it("does not claim success when scheduler installation fails", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const background = service({ install: vi.fn(async () => { calls.push("service-install"); throw new Error("failure"); }) });
    const code = await runAutomation({
      configureHooks: async (remove) => {
        calls.push(remove ? "hooks-remove" : "hooks-install");
        return { code: 0, changed: true };
      },
      resolveService: async () => ({ supported: true, service: background }),
      resetBackgroundState: async () => {},
      errorLog: (message) => errors.push(message),
    });
    expect(code).toBe(1);
    expect(calls).toEqual(["hooks-install", "service-install", "hooks-remove"]);
    expect(errors).toEqual(["Automatic sync setup failed. Run `burn doctor`, then `burn repair`."]);
  });

  it("rolls back a newly installed scheduler and hooks when the initial trigger fails", async () => {
    const calls: string[] = [];
    const background = service({
      install: vi.fn(async () => { calls.push("service-install"); return { changed: true, detail: "installed" }; }),
      trigger: vi.fn(async () => { calls.push("trigger"); return false; }),
      remove: vi.fn(async () => { calls.push("service-remove"); return { changed: true, detail: "removed" }; }),
    });
    expect(await runAutomation({
      configureHooks: async (remove) => {
        calls.push(remove ? "hooks-remove" : "hooks-install");
        return { code: 0, changed: true };
      },
      resolveService: async () => ({ supported: true, service: background }),
      resetBackgroundState: async () => { calls.push("reset"); },
      errorLog: () => {},
    })).toBe(1);
    expect(calls).toEqual([
      "hooks-install",
      "service-install",
      "reset",
      "trigger",
      "service-remove",
      "hooks-remove",
    ]);
  });

  it("does not touch the scheduler when hook installation fails atomically", async () => {
    let resolvedService = false;
    expect(await runAutomation({
      configureHooks: async () => ({ code: 1, changed: false }),
      resolveService: async () => {
        resolvedService = true;
        return { supported: true, service: service() };
      },
      errorLog: () => {},
    })).toBe(1);
    expect(resolvedService).toBe(false);
  });

  it("removes managed hook changes when a hook installer reports a partial failure", async () => {
    const calls: string[] = [];
    expect(await runAutomation({
      configureHooks: async (remove) => {
        calls.push(remove ? "hooks-remove" : "hooks-install");
        return remove ? { code: 0, changed: true } : { code: 1, changed: true };
      },
      resolveService: async () => {
        throw new Error("scheduler must not be reached");
      },
      errorLog: () => {},
    })).toBe(1);
    expect(calls).toEqual(["hooks-install", "hooks-remove"]);
  });
});
