import * as os from "node:os";
import * as path from "node:path";

/** Root directory for all Burnbook CLI state: cursors (state.json), the device keypair (key.json), and login config (config.json). Overridable via `BURNBOOK_CONFIG_DIR` so tests never touch the real `~/.config/burnbook`. */
export function configDir(): string {
  if (process.env.BURNBOOK_CONFIG_DIR) return process.env.BURNBOOK_CONFIG_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Burnbook");
  }
  return path.join(os.homedir(), ".config", "burnbook");
}

/** Directory holding Claude Code's own `settings.json`. Overridable via `BURNBOOK_CLAUDE_DIR` so tests never touch the real `~/.claude`. */
export function claudeDir(): string {
  return process.env.BURNBOOK_CLAUDE_DIR ?? path.join(os.homedir(), ".claude");
}
