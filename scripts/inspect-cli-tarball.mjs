#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const expectedCliPackageFiles = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.js",
  "package/package.json",
];

const CREDENTIAL_PATTERN = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXPECTED_REPOSITORY = {
  type: "git",
  url: "git+https://github.com/BurnBookLabs/burnbook-cli.git",
};
const EXPECTED_DEPENDENCIES = {
  "@noble/ed25519": "^3.1.0",
  commander: "^15.0.0",
  zod: "^4.0.0",
};
const EXPECTED_DEV_DEPENDENCIES = {
  "@burnbook/schema": "0.0.0",
  "@types/node": "^20",
  esbuild: "^0.28.1",
  undici: "^7.16.0",
};
const EXPECTED_SCRIPTS = {
  build: "tsc -p tsconfig.json --noEmit && node build.mjs",
  test: "vitest run",
};
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const FORBIDDEN_DEPENDENCY_SECTIONS = [
  "bundleDependencies",
  "bundledDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function assertCliPackageFileList(files) {
  const actual = [...files].filter(Boolean).sort();
  const expected = [...expectedCliPackageFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`CLI package file list differs from the allowlist: ${actual.join(", ")}`);
  }
}

export function inspectExtractedCliPackage(packageDirectory) {
  const manifestText = readFileSync(join(packageDirectory, "package.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const bundle = readFileSync(join(packageDirectory, "dist", "index.js"), "utf8");
  assertCliPackageManifest(manifest);
  if (bundle.includes("@burnbook/schema")) {
    throw new Error("Bundle imports the private schema package");
  }
  if (!bundle.includes("https://burnbook.dev")) {
    throw new Error("Bundle does not contain the production origin");
  }

  for (const relativePath of ["LICENSE", "README.md", "package.json", join("dist", "index.js")]) {
    const content = readFileSync(join(packageDirectory, relativePath), "utf8");
    if (CREDENTIAL_PATTERN.test(content)) {
      throw new Error(`Credential-shaped value found in package/${relativePath}`);
    }
  }
}

export function assertCliPackageManifest(manifest) {
  if (!isPlainRecord(manifest) || !VERSION_PATTERN.test(String(manifest.version ?? ""))) {
    throw new Error("Packed manifest has an invalid package version");
  }
  if (!isPlainRecord(manifest.scripts)) {
    throw new Error("Packed manifest scripts differ from the release contract");
  }
  for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
    if (script in manifest.scripts) {
      throw new Error(`Packed manifest contains forbidden lifecycle script: ${script}`);
    }
  }
  for (const section of FORBIDDEN_DEPENDENCY_SECTIONS) {
    if (section in manifest) {
      throw new Error(`Packed manifest contains forbidden dependency section: ${section}`);
    }
  }
  if (isPlainRecord(manifest.dependencies)) {
    for (const [name, specifier] of Object.entries(manifest.dependencies)) {
      if (name.startsWith("@burnbook/")) {
        throw new Error(`Packed manifest contains private runtime dependency: ${name}`);
      }
      if (typeof specifier !== "string" || !/^[~^]?[0-9]/.test(specifier)) {
        throw new Error(`Packed manifest contains non-registry dependency specifier: ${name}`);
      }
    }
  }

  const expected = expectedManifest(manifest.version);
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("Packed manifest differs from the exact release contract");
  }
}

export function inspectCliTarball(target, options = {}) {
  const tarball = resolveTarball(target);
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assertCliPackageFileList(listing);

  const extracted = mkdtempSync(join(tmpdir(), "burnbook-cli-inspect-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extracted], { stdio: "pipe" });
    inspectExtractedCliPackage(join(extracted, "package"));
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }

  const checksum = writeCliTarballChecksum(tarball, options);
  return { tarball, checksum };
}

export function writeCliTarballChecksum(target, options = {}) {
  const tarball = resolve(target);
  const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (options.writeChecksum !== false) {
    writeFileSync(`${tarball}.sha256`, `${checksum}  ${basename(tarball)}\n`, { mode: 0o600 });
  }
  return checksum;
}

export function verifyCliTarballChecksum(target, checksumTarget) {
  const tarball = resolve(target);
  const record = readFileSync(resolve(checksumTarget), "utf8").trim();
  const match = /^([a-f0-9]{64}) {2}([^/\\\s]+)$/.exec(record);
  if (!match || match[2] !== basename(tarball)) {
    throw new Error("CLI checksum must contain the candidate basename only");
  }
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== match[1]) {
    throw new Error("CLI candidate checksum mismatch");
  }
  return actual;
}

function expectedManifest(version) {
  return {
    name: "burnbook",
    version,
    description: "Count the tokens your AI coding agents burn, and prove it. CLI for burnbook.dev.",
    license: "MIT",
    author: "Burnbook Labs",
    homepage: "https://burnbook.dev",
    repository: EXPECTED_REPOSITORY,
    bugs: { url: "https://github.com/BurnBookLabs/burnbook-cli/issues" },
    keywords: ["claude-code", "codex", "tokens", "usage", "cli", "ai"],
    type: "module",
    bin: { burn: "./dist/index.js" },
    files: ["dist"],
    engines: { node: ">=20.0.0" },
    publishConfig: { access: "public", provenance: true },
    dependencies: EXPECTED_DEPENDENCIES,
    devDependencies: EXPECTED_DEV_DEPENDENCIES,
    scripts: EXPECTED_SCRIPTS,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTarball(target) {
  const resolved = resolve(target);
  if (resolved.endsWith(".tgz")) return resolved;
  const candidates = readdirSync(resolved)
    .filter((entry) => /^burnbook-[0-9].*\.tgz$/.test(entry))
    .map((entry) => join(resolved, entry));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one burnbook tarball in ${resolved}; found ${candidates.length}`);
  }
  return candidates[0];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/inspect-cli-tarball.mjs <tarball-or-directory>");
    process.exitCode = 2;
  } else {
    try {
      const result = inspectCliTarball(target);
      console.log(`Inspected ${fileURLToPath(pathToFileURL(result.tarball))}`);
      console.log(`SHA-256 ${result.checksum}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "CLI package inspection failed");
      process.exitCode = 1;
    }
  }
}
