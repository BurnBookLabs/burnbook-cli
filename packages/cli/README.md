# burnbook

Counts the tokens your AI coding agents burn and links each signed upload to
your registered Burnbook device.

`burn` reads supported assistants' local usage records, extracts **only**
content-free usage evidence, stores it in a private local spool, and signs
uploads with a device-bound Ed25519 key for
[burnbook.dev](https://burnbook.dev).

Install globally before enabling continuous sync so the operating-system
scheduler has stable CLI and Node.js paths:

```bash
npm install -g burnbook
burn login
burn repair
```

`burn login` only authorizes the device. `burn repair` then installs or repairs
supported hooks and, on macOS, automatic scheduling. It also requests the
initial collection and delivery attempt. An `npx` cache path is temporary and
is not suitable for durable scheduling.

## Near-real-time, not response streaming

Burnbook syncs completed usage events, not partial model output. On supported
macOS installations, a user LaunchAgent requests one bounded sync every 60
seconds and exits. Burnbook does not keep a resident process or terminal open.
Dashboard refresh and public caching can add separate display delay.

Claude Code hooks can request an earlier sync after a completed turn. The timer
also discovers completed Codex usage. Duplicate hook, timer, and manual requests
remain safe through local locking, evidence identity, and server-side
idempotency.

| Platform | Automatic scheduling | Status |
|---|---|---|
| macOS | 60-second user LaunchAgent | Supported |
| Linux | 60-second systemd user timer | Supported |
| Windows | 60-second current-user Task Scheduler task | Supported |

Burnbook does not install system cron, an administrator task, or another
privileged fallback. Linux and Windows automation remains owned by the current
user and `burn uninstall` removes only Burnbook-managed definitions.

## What it reads, and what it sends

Claude Code is supported after its adapter passed Burnbook's deterministic
collector certification suite. Codex local collection remains preview-only and
is excluded from ranked credentials until it passes the same collector gate.
These are Burnbook compatibility labels, not attestations from Anthropic or
OpenAI. Device signatures establish evidence origin, not absolute truth.

<!-- agent-support:start -->
| Agent | Tier | Collector gate | Source version | Collector | Normalizer | Coverage |
|---|---|---|---|---|---|---|
| Claude Code | supported | passed | claude-transcript-v1 | 1 | 1 | Persisted local Claude Code sessions; ephemeral or deleted sessions are not covered. |
| Codex | preview | preview | codex-rollout-token-count-v1 | 1 | 1 | Persisted local rollouts only; ephemeral and cloud-only sessions are not covered. |
| Gemini CLI | preview | preview | gemini-otel-v1 | 1 | 1 | Local token telemetry with prompt logging disabled. |
| Cursor | preview | preview | burnbook-import-v1 | 1 | 1 | User-supplied content-free usage exports only. |
| Antigravity | preview | preview | burnbook-import-v1 | 1 | 1 | User-supplied content-free usage exports only. |
<!-- agent-support:end -->

| Sent | Never sent |
|---|---|
| bounded event/session ids and timestamp | prompt text |
| model name | assistant output text |
| normalized input / output token counts | file contents, paths, or names |
| cache / reasoning counters and exact total | tool calls and their arguments |

The upload schema is a Zod object with `.strict()` at every level. The server
rejects unexpected keys, so prompts, responses, code, paths, diffs, repository
content, and tool payloads cannot enter normal ingestion.

## Why you can check this yourself

The published bundle is **not minified**. `npm view burnbook dist.tarball`,
unpack it, and read `dist/index.js`; it is the artifact you installed.
Provenance is version-specific: verify `dist.attestations` for the exact version
and run `npm audit signatures` after installation. The published `0.1.4`
release has a registry signature but no provenance attestation. Starting with
`0.2.0`, the reviewable CLI source and release workflow live in the public
[BurnBookLabs/burnbook-cli](https://github.com/BurnBookLabs/burnbook-cli)
repository so npm provenance can bind the package to its exact source commit.

The security model assumes the client is fully reverse-engineered. The server
independently checks every payload for supported-source eligibility,
plausibility, integrity state, and ranking consent.

## Commands

| Command | What it does |
|---|---|
| `burn login` | Authorizes the device without installing hooks or scheduling |
| `burn status` | Shows totals, streak, queue depth, and automatic-sync health |
| `burn doctor` | Diagnoses credentials, permissions, scheduler, worker, spool, and retry health |
| `burn sync` | Requests an immediate bounded collection and delivery attempt |
| `burn repair` | Repairs Burnbook-owned hooks and supported scheduling |
| `burn init` | Deprecated compatibility alias for repair |
| `burn init --remove` | Removes Burnbook hooks and scheduling while preserving local state |
| `burn uninstall` | Removes Burnbook automation while preserving local state |

## Files it writes

Private state lives under `~/.config/burnbook/`; directories are owner-only and
sensitive files use mode `0600`:

- `key.json` — device private key; it never leaves the machine.
- `config.json` — device token and id.
- `state.json` — source cursors and file stamps used for incremental reads.
- `spool/usage.jsonl` — sanitized usage records waiting for delivery.
- `background-state.json` — bounded automatic-sync health and retry state.
- `sync-worker.lock` — private process coordination.

On macOS, Burnbook owns the user LaunchAgent at
`~/Library/LaunchAgents/dev.burnbook.sync.plist` with label
`dev.burnbook.sync`.

## Repair and removal

Run `burn repair` after changing the global Node.js or npm installation path,
or when `burn status` reports unhealthy automation. Removal unloads the owned
job before deleting its validated plist and removes only exact Burnbook hook
entries. It preserves credentials, keys, cursors, queued usage, and unrelated
assistant hooks. Manual `burn sync` remains available.

If a release is defective, run `burn uninstall` before replacing it. This
disables Burnbook-owned hooks and scheduling while preserving the queue and
cursors needed for recovery. Never delete the spool as a troubleshooting step.

Revoking a device in the Burnbook dashboard stops that credential from making
future API requests. It does not erase this machine's private key, token,
cursors, or queued evidence. Account deletion removes server-side account data
but likewise does not delete local files. After removing automation and deciding
whether to sync or discard queued evidence, delete `~/.config/burnbook/` with
your operating system's file manager if you also want to erase local state.

## Upgrading from Evidence V1

Burnbook accepts V1 syncs for 30 days after V2 is activated. The server returns
the exact deadline in its `Sunset` header. Install `burnbook@latest`, run
`burn doctor`, then run `burn sync`; existing evidence is preserved and
pending records stay local until the server acknowledges them.

## Environment

- `BURNBOOK_API` — override the API origin. Must be `https`, except for
  `localhost`.
- `BURNBOOK_NO_OPEN=1` — never launch a browser.
- `BURNBOOK_CLAUDE_DIR` — override Claude Code's local directory.
- `CODEX_HOME` — override Codex's local state directory.

## License

MIT
