import * as path from "node:path";
import { z } from "zod";
import { canonicalApiOrigin, DEFAULT_API_ORIGIN } from "./api.js";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

/** On-disk shape of `<configDir>/config.json`, written once by `burn login` and read by every other command. `deviceToken` is the CLI's long-lived sync credential (Bearer auth for /sync and /me/summary); `deviceId` is the server-assigned id for the device row (which, per the server's contract, equals the CLI-generated keyId). */
export interface CliConfig {
  deviceToken: string;
  deviceId: string;
  apiOrigin: string;
}

const cliConfigSchema = z.object({
  deviceToken: z.string().min(1).max(4096),
  deviceId: z.string().uuid(),
  apiOrigin: z.string().min(1).max(2048),
}).strict();

const legacyCliConfigSchema = cliConfigSchema.omit({ apiOrigin: true }).strict();

function configFilePath(): string {
  return path.join(configDir(), "config.json");
}

/** Load the login config. Returns `undefined` if the config file doesn't exist, or is present but malformed — both cases mean "not logged in" to callers, which should tell the user to run `burn login`. */
export async function loadConfig(): Promise<CliConfig | undefined> {
  const raw = await readPrivateFile(configFilePath());
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const current = cliConfigSchema.safeParse(parsed);
  const legacy = current.success ? undefined : legacyCliConfigSchema.safeParse(parsed);
  if (!current.success && !legacy?.success) return undefined;
  let config: CliConfig;
  if (current.success) {
    config = { ...current.data, apiOrigin: canonicalApiOrigin(current.data.apiOrigin) };
  } else if (legacy?.success) {
    config = { ...legacy.data, apiOrigin: DEFAULT_API_ORIGIN };
  } else {
    return undefined;
  }
  const override = process.env.BURNBOOK_API;
  if (override && canonicalApiOrigin(override) !== config.apiOrigin) {
    throw new Error("BURNBOOK_API does not match the origin bound to this device. Run `burn login` to relink it.");
  }
  return config;
}

/** Persist the login config to `<config dir>/config.json`. Creates the config directory recursively (mode 0700) if needed, and ensures the config file itself is mode 0600 (owner read/write only) — it carries the device's long-lived sync credential. */
export async function saveConfig(
  config: Omit<CliConfig, "apiOrigin"> & { apiOrigin?: string },
): Promise<void> {
  const validated = cliConfigSchema.parse({
    ...config,
    apiOrigin: canonicalApiOrigin(config.apiOrigin),
  });
  await writePrivateFile(configFilePath(), `${JSON.stringify(validated, null, 2)}\n`);
}
