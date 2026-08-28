#!/usr/bin/env node
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { agentIdSchema, type AgentId } from "@burnbook/schema";
import { runCollect } from "./commands/collect.js";
import { runDoctor } from "./commands/doctor.js";
import { runSync } from "./commands/sync.js";
import { runStatus } from "./commands/status.js";
import { runAutomation } from "./commands/automation.js";
import { enqueueSync, runCollectWorker, runSyncWorker } from "./commands/hook.js";
import { runOnboarding } from "./commands/onboarding.js";
import { runRetryWorker } from "./commands/retry-worker.js";
import { runRetryServiceCommand } from "./commands/retry-service.js";
import { runImport } from "./commands/import.js";
import { startProject, stopProject } from "./commands/project.js";
import { runReconcile } from "./commands/reconcile.js";
import { AGENT_SUPPORT } from "./collectors/support.js";
import { loadBackgroundState } from "./core/background-state.js";
import { loadConfig } from "./core/config.js";
import { configDir } from "./core/paths.js";
import { inspectSpool } from "./core/spool.js";
import { inspectSpoolV3 } from "./core/spool-v3.js";
import { resolveBackgroundService } from "./platform/index.js";
import { canonicalApiOrigin } from "./core/api.js";
export { CLI_PACKAGE_VERSION } from "./version.js";
import { CLI_PACKAGE_VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("burn").description("Burnbook CLI").version(CLI_PACKAGE_VERSION);

  program
    .command("login")
    .description("Authorize this device with Burnbook")
    .action(async () => {
      process.exitCode = await runOnboarding();
    });

  program
    .command("sync")
    .description("Sync supported local evidence to Burnbook")
    .option("--quiet", "suppress output and always exit 0 (safe for hooks)", false)
    .action(async (options: { quiet: boolean }) => {
      process.exitCode = await runSync({ quiet: options.quiet });
    });

  program
    .command("collect")
    .description("Collect content-free evidence locally without network access")
    .requiredOption(
      "--agent <agent>",
      `collector to run (${AGENT_SUPPORT.map((entry) => entry.agent).join(" or ")})`,
    )
    .option("--quiet", "suppress output and always exit 0 (safe for hooks)", false)
    .action(async (options: { agent: string; quiet: boolean }) => {
      const agent = parseAgent(options.agent);
      if (!agent) {
        if (!options.quiet) console.error(`Unknown agent: ${options.agent}`);
        process.exitCode = options.quiet ? 0 : 1;
        return;
      }
      process.exitCode = await runCollect({ agent, quiet: options.quiet });
    });

  program
    .command("import")
    .description("Import strict content-free usage JSONL as preview evidence")
    .requiredOption("--agent <agent>", "cursor or antigravity")
    .requiredOption("--file <path>", "content-free JSONL file")
    .action(async (options: { agent: string; file: string }) => {
      const agent = parseAgent(options.agent);
      if (!agent) {
        console.error(`Unknown agent: ${options.agent}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runImport({ agent, file: options.file });
    });

  const project = program.command("project").description("Manage privacy-preserving project attribution");
  project.command("start").argument("<slug>").action(async (slug: string) => {
    process.exitCode = await startProject(slug);
  });
  project.command("stop").action(async () => {
    process.exitCode = await stopProject();
  });

  program.command("reconcile")
    .description("Build a content-free legacy/server reconciliation ledger")
    .requiredOption("--local <jsonl>", "local legacy or evidence JSONL")
    .requiredOption("--server <jsonl>", "content-free server evidence export")
    .requiredOption("--out <json>", "new ledger output path")
    .option("--import-local-only", "append only local-only V2 evidence to the current spool", false)
    .action(async (options: { local: string; server: string; out: string; importLocalOnly: boolean }) => {
      process.exitCode = await runReconcile(options);
    });

  program
    .command("doctor")
    .description("Diagnose local collector compatibility and spool privacy")
    .option("--agent <agent>", "limit checks to one collector")
    .action(async (options: { agent?: string }) => {
      const agent = options.agent ? parseAgent(options.agent) : undefined;
      if (options.agent && !agent) {
        console.error(`Unknown agent: ${options.agent}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runDoctor({ agent, inspectScheduler });
    });

  program
    .command("status")
    .description("Show your Burnbook stats")
    .action(async () => {
      process.exitCode = await runStatus({ inspectAutomation: inspectAutomationStatus });
    });

  program
    .command("retry-worker")
    .description("Run the bounded spool uploader in the foreground")
    .option("--once", "perform one pass and exit", false)
    .option("--interval <seconds>", "poll interval from 10 to 3600 seconds", "60")
    .option("--max-batches <count>", "maximum upload batches per pass from 1 to 20", "4")
    .action(async (options: { once: boolean; interval: string; maxBatches: string }) => {
      process.exitCode = await runRetryWorker({
        once: options.once,
        intervalSeconds: Number(options.interval),
        maxBatches: Number(options.maxBatches),
      });
    });

  program
    .command("retry-service")
    .description("Manage an explicit per-user retry service (macOS or Linux)")
    .argument("<action>", "install, status, or remove")
    .option("--interval <seconds>", "poll interval from 10 to 3600 seconds", "60")
    .option("--max-batches <count>", "maximum upload batches per pass from 1 to 20", "4")
    .action(async (action: string, options: { interval: string; maxBatches: string }) => {
      process.exitCode = await runRetryServiceCommand({
        action,
        intervalSeconds: Number(options.interval),
        maxBatches: Number(options.maxBatches),
      });
    });

  program
    .command("repair")
    .description("Repair Claude hooks and automatic background sync")
    .action(async () => {
      process.exitCode = await runAutomation();
    });

  program
    .command("init")
    .description("Compatibility alias for `burn repair`")
    .option("--remove", "remove Burnbook hooks and automatic scheduling", false)
    .action(async (options: { remove: boolean }) => {
      process.exitCode = await runAutomation({ remove: options.remove });
    });

  program
    .command("uninstall")
    .description("Remove Burnbook automation while preserving local evidence and credentials")
    .action(async () => {
      process.exitCode = await runAutomation({ remove: true });
    });

  program
    .command("hook", { hidden: true })
    .action(async () => {
      try {
        await enqueueSync();
      } catch {
        process.exitCode = 0;
      }
    });

  program
    .command("collect-worker", { hidden: true })
    .action(async () => {
      process.exitCode = await runCollectWorker();
    });

  program
    .command("sync-worker", { hidden: true })
    .option("--config-dir <path>")
    .option("--api-origin <origin>")
    .action(async (options: { configDir?: string; apiOrigin?: string }) => {
      if (options.configDir) {
        if (!path.isAbsolute(options.configDir) || /[\0\r\n]/.test(options.configDir)) {
          process.exitCode = 1;
          return;
        }
        process.env.BURNBOOK_CONFIG_DIR = options.configDir;
      }
      if (options.apiOrigin) {
        try {
          process.env.BURNBOOK_API = canonicalApiOrigin(options.apiOrigin);
        } catch {
          process.exitCode = 1;
          return;
        }
      }
      process.exitCode = await runSyncWorker();
    });

  return program;
}

async function inspectScheduler() {
  const config = await loadConfig();
  if (!config) return { status: "unavailable" as const };
  const resolution = await resolveBackgroundService({
    configDir: configDir(),
    apiOrigin: config.apiOrigin,
  });
  if (!resolution.supported) return { status: "unsupported" as const };
  return resolution.service.inspect();
}

async function inspectAutomationStatus() {
  const config = await loadConfig();
  if (!config) throw new Error("device-origin-unavailable");
  const resolution = await resolveBackgroundService({
    configDir: configDir(),
    apiOrigin: config.apiOrigin,
  });
  const background = await loadBackgroundState();
  const spool = await inspectSpool();
  const spoolV3 = await inspectSpoolV3();
  const queue = {
    queued: spool.pending + spoolV3.pending,
    queueBytes: spool.queueBytes + spoolV3.queueBytes,
    quarantined: spool.quarantined + spoolV3.quarantined,
    oldestPendingAt: earliest(spool.oldestPendingAt, spoolV3.oldestPendingAt),
    lastAcknowledgedAt: latest(spool.lastAcknowledgedAt, spoolV3.lastAcknowledgedAt),
  };
  if (!resolution.supported) {
    return { scheduler: "unsupported" as const, lastSuccessAt: background?.lastSuccessAt, ...queue };
  }
  const inspection = await resolution.service.inspect();
  const scheduler = inspection.state === "installed"
    ? "enabled" as const
    : inspection.state === "not-installed"
      ? "disabled" as const
      : "needs-repair" as const;
  return { scheduler, lastSuccessAt: background?.lastSuccessAt, ...queue };
}

function earliest(left?: string, right?: string): string | undefined {
  return [left, right].filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(left?: string, right?: string): string | undefined {
  return [left, right].filter((value): value is string => Boolean(value)).sort().at(-1);
}

function parseAgent(value: string): AgentId | undefined {
  const parsed = agentIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// Only parse argv when this file is executed directly (the `burn` bin
// entry) — not when imported by tests. `argv[1]` is compared via its
// realpath because the installed bin is a symlink (e.g.
// node_modules/.bin/burn -> dist/index.js): Node resolves symlinks when
// loading the module, so import.meta.url is already the target's real
// path, but argv[1] is the symlink path until realpath'd here too.
if (isMainModule()) {
  await buildProgram().parseAsync(process.argv);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
