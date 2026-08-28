import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderLinuxSystemdUnits } from "../../src/platform/linux-systemd.js";
import { renderWindowsTask } from "../../src/platform/windows-task.js";

describe("cross-platform background definitions", () => {
  it("renders a persistent, hardened systemd user timer", () => {
    const units = renderLinuxSystemdUnits({
      homeDir: "/home/alice",
      configDir: "/home/alice/.config/burnbook",
      nodePath: "/usr/bin/node",
      burnbookPath: "/usr/lib/node_modules/burnbook/dist/index.js",
      apiOrigin: "https://burnbook.dev",
    });
    expect(units.timer).toContain("Persistent=true");
    expect(units.timer).toContain("OnUnitActiveSec=60s");
    expect(units.service).toContain("NoNewPrivileges=true");
    expect(units.service).toContain("ProtectSystem=strict");
    expect(units.service).not.toContain("deviceToken");
  });

  it("renders a least-privilege current-user Windows task", () => {
    const xml = renderWindowsTask({
      configDir: path.resolve("C:/Users/Alice/AppData/Local/Burnbook"),
      nodePath: path.resolve("C:/Program Files/nodejs/node.exe"),
      burnbookPath: path.resolve("C:/Users/Alice/AppData/Roaming/npm/node_modules/burnbook/dist/index.js"),
      apiOrigin: "https://burnbook.dev",
    });
    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true);
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("--config-dir &quot;");
    expect(xml).toContain("--api-origin &quot;https://burnbook.dev&quot;");
    expect(xml).not.toContain("deviceToken");
  });
});
