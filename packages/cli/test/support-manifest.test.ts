import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { agentSupportManifest } from "@burnbook/schema";
import { AGENT_SUPPORT } from "../src/collectors/support.js";
import { renderSupportTable } from "../src/collectors/support-markdown.js";

describe("agent support claims", () => {
  it("uses the shared schema manifest in the CLI", () => {
    expect(AGENT_SUPPORT).toBe(agentSupportManifest);
  });

  it("keeps the generated README compatibility block in sync", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const match = readme.match(/<!-- agent-support:start -->\n([\s\S]*?)\n<!-- agent-support:end -->/);
    expect(match?.[1]).toBe(renderSupportTable());
  });

  it("presents certification as a Burnbook collector gate", () => {
    const table = renderSupportTable();
    expect(table).toContain("| Collector gate |");
    expect(table).toContain("| Claude Code | supported | passed |");
    expect(table).toContain("| Codex | preview | preview |");
    expect(table).not.toContain("| Certification |");
  });
});
