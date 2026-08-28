import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProgram, CLI_PACKAGE_VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const continuousSyncGuide = readFileSync(new URL("../../../docs/continuous-sync.md", import.meta.url), "utf8");

describe("burnbook cli", () => {
  // Under vitest we run from source, where esbuild's `define` has not been applied — so the fallback is what we should see. The real assertion (built binary reports the manifest version, which matches the git tag) lives in the release workflow, because it can only be made against dist/.
  it("falls back to a dev version when not built", () => {
    expect(CLI_PACKAGE_VERSION).toBe("0.0.0-dev");
  });

  // Guards the two manifest fields that silently break `npx burnbook`:
  // a bin target outside the files allowlist, or a non-semver version.
  it("declares a publishable manifest", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(pkg.bin).toEqual({ burn: "./dist/index.js" });
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.files).toContain("dist");
    expect(pkg.private).toBeUndefined();
  });

  it("uses burn as the canonical executable name", () => {
    expect(buildProgram().name()).toBe("burn");
  });

  it("documents the explicit login and automation lifecycle with the published binary", () => {
    for (const document of [readme, continuousSyncGuide]) {
      expect(document).not.toMatch(/`burnbook (?:login|repair|sync|status|doctor|init|uninstall)/);
    }
    expect(readme).toContain("`burn login` only authorizes the device");
    expect(readme).toContain("`burn repair` then installs or repairs");
    expect(continuousSyncGuide).toContain("`burn login` authorizes the device");
    expect(continuousSyncGuide).toContain("On supported desktops");
    expect(continuousSyncGuide).toContain("launchd, systemd, or Task Scheduler");
    expect(readme).not.toContain("../../docs/continuous-sync.md");
  });

  // The published tarball must not carry a dependency that only exists in
  // this workspace — pnpm would rewrite it to a version no registry has.
  it("declares no workspace dependencies at runtime", () => {
    const runtime = Object.values(pkg.dependencies ?? {}) as string[];
    expect(runtime.some((range) => range.startsWith("workspace:"))).toBe(false);
  });

  it("documents explicit resident service management in CLI help", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("retry-service");
    expect(help).toContain("per-user retry service");
  });
});
