import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertCliPackageFileList,
  assertCliPackageManifest,
  expectedCliPackageFiles,
  inspectExtractedCliPackage,
  verifyCliTarballChecksum,
  writeCliTarballChecksum,
} from "./inspect-cli-tarball.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI tarball inspection", () => {
  it("accepts only the exact public file allowlist", () => {
    assert.doesNotThrow(() => assertCliPackageFileList(expectedCliPackageFiles));
    assert.throws(
      () => assertCliPackageFileList([...expectedCliPackageFiles, "package/source.ts"]),
      /differs from the allowlist/,
    );
  });

  it("rejects private imports, missing origin, and credentials", () => {
    const privateImport = packageFixture(validManifest(), "import '@burnbook/schema'; https://burnbook.dev");
    assert.throws(() => inspectExtractedCliPackage(privateImport), /private schema/);

    const missingOrigin = packageFixture(validManifest(), "safe bundle");
    assert.throws(() => inspectExtractedCliPackage(missingOrigin), /production origin/);

    const credential = packageFixture(validManifest(), "https://burnbook.dev npm_abcdefghijklmnopqrstuvwxyz");
    assert.throws(() => inspectExtractedCliPackage(credential), /Credential-shaped/);
  });

  it("rejects executable, bundled, private, non-registry, and unexpected manifest data", () => {
    const cases = [
      [{ scripts: { ...validManifest().scripts, postinstall: "node steal.js" } }, /lifecycle script/],
      [{ bundledDependencies: ["zod"] }, /forbidden dependency section/],
      [{ dependencies: { ...validManifest().dependencies, "@burnbook/internal": "1.0.0" } }, /private runtime dependency/],
      [{ dependencies: { ...validManifest().dependencies, zod: "git+https://example.test/zod.git" } }, /non-registry dependency/],
      [{ bin: { burn: "./dist/other.js" } }, /exact release contract/],
      [{ repository: { type: "git", url: "https://example.test/repository.git" } }, /exact release contract/],
    ];
    for (const [override, expected] of cases) {
      assert.throws(() => assertCliPackageManifest(validManifest(override)), expected);
    }
  });

  it("accepts only the content-safe standalone manifest", () => {
    const directory = packageFixture(validManifest(), "https://burnbook.dev");
    assert.doesNotThrow(() => inspectExtractedCliPackage(directory));
  });

  it("keeps checksums valid when release artifacts move between runners", () => {
    const source = temporaryDirectory("burnbook-checksum-source-");
    const destination = temporaryDirectory("burnbook-checksum-destination-");
    const sourceTarball = join(source, "burnbook-0.1.0.tgz");
    const destinationTarball = join(destination, "burnbook-0.1.0.tgz");
    writeFileSync(sourceTarball, "reviewed candidate bytes");
    writeCliTarballChecksum(sourceTarball);
    copyFileSync(sourceTarball, destinationTarball);
    copyFileSync(`${sourceTarball}.sha256`, `${destinationTarball}.sha256`);
    rmSync(source, { recursive: true, force: true });
    assert.doesNotThrow(() => verifyCliTarballChecksum(destinationTarball, `${destinationTarball}.sha256`));
  });

  it("rejects absolute checksum paths and modified candidate bytes", () => {
    const directory = temporaryDirectory("burnbook-checksum-invalid-");
    const tarball = join(directory, "burnbook-0.1.0.tgz");
    writeFileSync(tarball, "reviewed candidate bytes");
    const checksum = writeCliTarballChecksum(tarball);
    writeFileSync(`${tarball}.sha256`, `${checksum}  ${tarball}\n`);
    assert.throws(() => verifyCliTarballChecksum(tarball, `${tarball}.sha256`), /basename only/);
    writeFileSync(`${tarball}.sha256`, `${checksum}  burnbook-0.1.0.tgz\n`);
    writeFileSync(tarball, "modified candidate bytes");
    assert.throws(() => verifyCliTarballChecksum(tarball, `${tarball}.sha256`), /checksum mismatch/);
  });
});

function packageFixture(manifest, bundle) {
  const root = temporaryDirectory("burnbook-cli-package-test-");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "LICENSE"), "MIT License");
  writeFileSync(join(root, "README.md"), "safe public readme");
  writeFileSync(join(root, "dist", "index.js"), bundle);
  return root;
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function validManifest(override = {}) {
  return {
    name: "burnbook",
    version: "0.1.0",
    description: "Count the tokens your AI coding agents burn, and prove it. CLI for burnbook.dev.",
    license: "MIT",
    author: "Burnbook Labs",
    homepage: "https://burnbook.dev",
    repository: { type: "git", url: "git+https://github.com/BurnBookLabs/burnbook-cli.git" },
    bugs: { url: "https://github.com/BurnBookLabs/burnbook-cli/issues" },
    keywords: ["claude-code", "codex", "tokens", "usage", "cli", "ai"],
    type: "module",
    bin: { burn: "./dist/index.js" },
    files: ["dist"],
    engines: { node: ">=20.0.0" },
    publishConfig: { access: "public", provenance: true },
    dependencies: { "@noble/ed25519": "^3.1.0", commander: "^15.0.0", zod: "^4.0.0" },
    devDependencies: {
      "@burnbook/schema": "0.0.0",
      "@types/node": "^20",
      esbuild: "^0.28.1",
      undici: "^7.16.0",
    },
    scripts: { build: "tsc -p tsconfig.json --noEmit && node build.mjs", test: "vitest run" },
    ...override,
  };
}
