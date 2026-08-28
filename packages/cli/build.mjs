/** Publish build for the `burn` binary. Why a bundler at all: the CLI imports `@burnbook/schema`, a workspace package that is deliberately never published. pnpm rewrites `workspace:*` to a concrete version at pack time, so a plain `tsc` build would ship a tarball whose dependency does not exist on the registry — `npx burnbook` would fail at install. Inlining it removes the dangling reference and leaves exactly one published artifact to defend. Why we do NOT bundle everything: declared runtime dependencies stay external so `npm audit`, Socket, Snyk, and Dependabot can still see the real dependency tree of the published package. Vendoring third-party code into dist/ would hide it from every one of those tools and freeze it out of security updates. Inlining is for our own unpublishable code only. Not minified, on purpose. The privacy claim — this binary never reads prompt content — is only credible if a reader can check it in the artifact they actually installed. */
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  // Anything declared as a runtime dep resolves from node_modules at runtime.
  // Anything not declared gets inlined — which is exactly @burnbook/schema.
  external: Object.keys(pkg.dependencies ?? {}),
  // Single source of truth for the version the binary reports about itself.
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
