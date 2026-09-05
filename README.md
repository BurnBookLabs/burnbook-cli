# Burnbook CLI

Public, reviewable source for the burn CLI published as
[burnbook](https://www.npmjs.com/package/burnbook).

The hosted Burnbook application remains in a separate private repository.
This repository contains only the CLI, its content-free wire schema, tests,
and release workflow.

See [packages/cli/README.md](packages/cli/README.md) for installation, privacy
boundaries, supported collectors, and local state.

## Release approval

The release workflow builds and verifies the CLI package, then submits the reviewed
tarball to npm staging with provenance. A successful workflow does not make the
version available for installation. Staging requires npm 11.15.0 or later and
Node.js 22.14.0 or later; the workflow checks npm before submission.

The package owner reviews the staged version and its provenance on npm's Staged
Packages tab, or with `npm stage list burnbook` and `npm stage view <stage-id>`.
Download the staged tarball with `npm stage download <stage-id>` and verify its
SHA-256 checksum against the release workflow's reviewed candidate before approving.
The owner then runs `npm stage approve <stage-id>` or approves on npmjs.com and
completes the interactive 2FA challenge. This final approval publishes the version.

See npm's [staged publishing documentation](https://docs.npmjs.com/staged-publishing/)
for the review and approval flow.
