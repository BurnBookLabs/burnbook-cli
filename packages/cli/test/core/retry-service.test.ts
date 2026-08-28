import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildServiceDefinition,
  manageRetryService,
  type RetryServiceRuntime,
} from "../../src/core/retry-service.js";

const temporaryRoots: string[] = [];
const SETTINGS = { intervalSeconds: 60, maxBatches: 4 };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resident retry service", () => {
  it("renders launchd arguments as XML values without shell interpolation", async () => {
    const runtime = await testRuntime("darwin", async () => ({ code: 1 }), {
      cliEntry: "/Applications/Burn & Book/<cli>.js",
      apiOrigin: "https://staging.burnbook.dev",
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    expect(definition.contents).toContain("<!-- Managed by Burnbook retry-service; do not edit. -->");
    expect(definition.contents).toContain("<string>/Applications/Burn &amp; Book/&lt;cli&gt;.js</string>");
    expect(definition.contents).toContain("<string>https://staging.burnbook.dev</string>");
    expect(definition.contents).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(definition.contents).not.toContain("sh -c");
  });

  it("renders a hardened systemd user unit with escaped specifiers", async () => {
    const runtime = await testRuntime("linux", async () => ({ code: 1 }), {
      cliEntry: "/home/person/Burn Book/$HOME/100%/burn\"cli.js",
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    expect(definition.contents).toContain("ExecStart=:\"");
    expect(definition.contents).toContain("100%%/burn\\\"cli.js");
    expect(definition.contents).toContain("$HOME");
    expect(definition.contents).toContain("NoNewPrivileges=true");
    expect(definition.contents).toContain("ProtectSystem=strict");
    expect(definition.contents).toContain("ProtectHome=read-only");
    expect(definition.contents).not.toContain("sh -c");
  });

  it("uses an injected trusted absolute systemctl location without a shell", async () => {
    const runtime = await testRuntime("linux", async () => ({ code: 1 }), {
      systemctlExecutable: "/run/current-system/sw/bin/systemctl",
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    expect(definition.managerExecutable).toBe("/run/current-system/sw/bin/systemctl");
  });

  it("rejects unsupported platforms and unsafe values", async () => {
    const runtime = await testRuntime("darwin", async () => ({ code: 1 }));
    expect(() => buildServiceDefinition(
      { ...runtime, platform: "win32" } as RetryServiceRuntime,
      SETTINGS,
    )).toThrow("not supported on win32");
    expect(() => buildServiceDefinition(
      { ...runtime, cliEntry: "/safe/path\nExecStart=/evil" } as RetryServiceRuntime,
      SETTINGS,
    )).toThrow("unsafe value");
  });

  it("installs, reports, updates, and removes one launchd agent", async () => {
    let active = false;
    const calls: Array<[string, readonly string[]]> = [];
    const runtime = await testRuntime("darwin", async (executable, args) => {
      calls.push([executable, args]);
      if (args[0] === "print") return { code: active ? 0 : 1 };
      if (args[0] === "bootstrap") active = true;
      if (args[0] === "bootout") active = false;
      return { code: 0 };
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    expect((await manageRetryService("install", SETTINGS, runtime)).exitCode).toBe(0);
    expect((await fs.stat(definition.target)).mode & 0o777).toBe(0o600);
    expect((await manageRetryService("status", SETTINGS, runtime)).exitCode).toBe(0);
    expect((await manageRetryService("install", { intervalSeconds: 90, maxBatches: 2 }, runtime)).exitCode).toBe(0);
    expect(await fs.readFile(definition.target, "utf8")).toContain("<string>90</string>");
    expect((await manageRetryService("remove", SETTINGS, runtime)).exitCode).toBe(0);
    await expect(fs.lstat(definition.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.every(([executable]) => executable === "/bin/launchctl")).toBe(true);
    expect(calls.some(([, args]) => args[0] === "bootout")).toBe(true);
  });

  it("uses only systemctl user commands and reverses its Linux unit", async () => {
    let known = false;
    let active = false;
    let enabled = false;
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runtime = await testRuntime("linux", async (executable, args) => {
      expect(executable).toBe("/usr/bin/systemctl");
      mutableCalls.push([...args]);
      if (args[1] === "cat") return { code: known ? 0 : 1 };
      if (args[1] === "is-active") return { code: active ? 0 : 1 };
      if (args[1] === "is-enabled") return { code: enabled ? 0 : 1 };
      if (args[1] === "enable") enabled = true;
      if (args[1] === "restart") {
        known = true;
        active = true;
      }
      if (args[1] === "disable") {
        enabled = false;
        active = false;
      }
      return { code: 0 };
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    await manageRetryService("install", SETTINGS, runtime);
    expect(await fs.readFile(definition.target, "utf8")).toContain("WantedBy=default.target");
    expect((await manageRetryService("status", SETTINGS, runtime)).exitCode).toBe(0);
    await manageRetryService("remove", SETTINGS, runtime);
    await expect(fs.lstat(definition.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutableCalls).toContainEqual(["--user", "enable", "burnbook-retry-worker.service"]);
    expect(mutableCalls).toContainEqual(["--user", "disable", "--now", "burnbook-retry-worker.service"]);
    expect(mutableCalls.every((args) => !args.includes("sudo"))).toBe(true);
  });

  it("rolls back a new definition when activation fails", async () => {
    const runtime = await testRuntime("darwin", async (_executable, args) => ({
      code: args[0] === "bootstrap" ? 1 : 1,
    }));
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow(
      "launchd could not activate",
    );
    await expect(fs.lstat(definition.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores an active launchd definition when an update write fails", async () => {
    let active = true;
    const runtime = await testRuntime("darwin", async (_executable, args) => {
      if (args[0] === "print") return { code: active ? 0 : 1 };
      if (args[0] === "bootout") active = false;
      if (args[0] === "bootstrap") active = true;
      return { code: 0 };
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    await fs.mkdir(definition.directory, { recursive: true });
    await fs.writeFile(definition.target, definition.contents, { mode: 0o600 });
    let failed = false;

    await expect(manageRetryService("install", SETTINGS, {
      ...runtime,
      open: async (target, flags, mode) => {
        if (typeof flags === "string" && flags === "wx" && !failed) {
          failed = true;
          throw new Error("simulated write failure");
        }
        return fs.open(target, flags, mode);
      },
    })).rejects.toThrow("simulated write failure");
    expect(active).toBe(true);
    expect(await fs.readFile(definition.target, "utf8")).toBe(definition.contents);
  });

  it("reports nonzero rollback lifecycle commands without hiding the activation error", async () => {
    let daemonReloads = 0;
    const runtime = await testRuntime("linux", async (_executable, args) => {
      if (args[1] === "cat" || args[1] === "is-active" || args[1] === "is-enabled") {
        return { code: 1 };
      }
      if (args[1] === "daemon-reload") {
        daemonReloads += 1;
        return { code: daemonReloads === 1 ? 1 : 0 };
      }
      if (args[1] === "disable") return { code: 1 };
      return { code: 0 };
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow(
      "systemd could not reload the user service manager; rollback failed: prepare manager: systemd could not prepare rollback",
    );
    await expect(fs.lstat(definition.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the file and manager state when Linux removal cannot reload", async () => {
    let known = false;
    let active = false;
    let enabled = false;
    let failRemovalReload = false;
    const runtime = await testRuntime("linux", async (_executable, args) => {
      if (args[1] === "cat") return { code: known ? 0 : 1 };
      if (args[1] === "is-active") return { code: active ? 0 : 1 };
      if (args[1] === "is-enabled") return { code: enabled ? 0 : 1 };
      if (args[1] === "disable") {
        enabled = false;
        active = false;
      }
      if (args[1] === "enable") enabled = true;
      if (args[1] === "restart") {
        known = true;
        active = true;
      }
      if (args[1] === "daemon-reload" && failRemovalReload) {
        failRemovalReload = false;
        return { code: 1 };
      }
      return { code: 0 };
    });
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    await manageRetryService("install", SETTINGS, runtime);
    const previous = await fs.readFile(definition.target, "utf8");
    failRemovalReload = true;

    await expect(manageRetryService("remove", SETTINGS, runtime)).rejects.toThrow(
      "systemd could not reload the user service manager",
    );
    expect(await fs.readFile(definition.target, "utf8")).toBe(previous);
    expect({ known, active, enabled }).toEqual({ known: true, active: true, enabled: true });
  });

  it("never replaces or removes an unmanaged regular file", async () => {
    const run = vi.fn(async () => ({ code: 1 }));
    const runtime = await testRuntime("darwin", run);
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    await fs.mkdir(definition.directory, { recursive: true });
    await fs.writeFile(definition.target, "unrelated launch agent", { mode: 0o600 });

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow("unmanaged");
    await expect(manageRetryService("remove", SETTINGS, runtime)).rejects.toThrow("unmanaged");
    expect(await fs.readFile(definition.target, "utf8")).toBe("unrelated launch agent");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses symlinked service directories and targets", async () => {
    const run = vi.fn(async () => ({ code: 1 }));
    const runtime = await testRuntime("darwin", run);
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    const redirected = path.join(runtime.homeDir!, "redirected");
    await fs.mkdir(redirected);
    await fs.mkdir(path.dirname(definition.directory), { recursive: true });
    await fs.symlink(redirected, definition.directory);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow("contains a link");
    expect(run).not.toHaveBeenCalled();

    await fs.unlink(definition.directory);
    await fs.mkdir(definition.directory);
    const outside = path.join(redirected, "outside.plist");
    await fs.writeFile(outside, definition.contents, { mode: 0o600 });
    await fs.symlink(outside, definition.target);
    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow("non-regular");
  });

  it("refuses a service path writable by another user", async () => {
    const run = vi.fn(async () => ({ code: 1 }));
    const runtime = await testRuntime("darwin", run);
    await fs.chmod(runtime.homeDir!, 0o777);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow(
      "writable by another user",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an existing managed definition writable by another user", async () => {
    const run = vi.fn(async () => ({ code: 1 }));
    const runtime = await testRuntime("darwin", run);
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    await fs.mkdir(definition.directory, { recursive: true });
    await fs.writeFile(definition.target, definition.contents, { mode: 0o622 });
    await fs.chmod(definition.target, 0o622);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow(
      "service file is writable by another user",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("reads an existing definition from a no-follow descriptor during a path swap", async () => {
    const runtime = await testRuntime("darwin", async (_executable, args) => ({
      code: args[0] === "print" ? 0 : 1,
    }));
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);
    await fs.mkdir(definition.directory, { recursive: true });
    await fs.writeFile(definition.target, definition.contents, { mode: 0o600 });
    const replacement = path.join(runtime.homeDir!, "replacement.plist");
    const original = `${definition.target}.original`;
    await fs.writeFile(replacement, "unmanaged replacement", { mode: 0o600 });
    let swapped = false;

    const result = await manageRetryService("status", SETTINGS, {
      ...runtime,
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        if (target === definition.target && typeof flags === "number" && !swapped) {
          swapped = true;
          await fs.rename(definition.target, original);
          await fs.symlink(replacement, definition.target);
        }
        return handle;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(swapped).toBe(true);
  });

  it("pins Linux definitions outside environment-configurable config roots", async () => {
    const runtime = await testRuntime("linux", async () => ({ code: 1 }));
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    expect(definition.target).toBe(
      path.join(runtime.homeDir!, ".local", "share", "systemd", "user", "burnbook-retry-worker.service"),
    );
  });

  it("refuses a manager collision before writing a new definition", async () => {
    const runtime = await testRuntime("darwin", async (_executable, args) => ({
      code: args[0] === "print" ? 0 : 1,
    }));
    const definition = buildServiceDefinition(runtime as RetryServiceRuntime, SETTINGS);

    await expect(manageRetryService("install", SETTINGS, runtime)).rejects.toThrow(
      "from another location",
    );
    await expect(fs.lstat(definition.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function testRuntime(
  platform: "darwin" | "linux",
  run: RetryServiceRuntime["run"],
  overrides: Partial<RetryServiceRuntime> = {},
): Promise<Partial<RetryServiceRuntime>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-retry-service-"));
  temporaryRoots.push(root);
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".config", "burnbook");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  let suffix = 0;
  return {
    platform,
    uid: process.getuid?.() ?? 0,
    homeDir,
    configDir: stateDir,
    nodeExecutable: "/usr/bin/node",
    cliEntry: "/opt/burnbook/dist/index.js",
    systemctlExecutable: platform === "linux" ? "/usr/bin/systemctl" : undefined,
    processId: 1234,
    randomSuffix: () => `test-${suffix++}`,
    run,
    ...overrides,
  };
}
