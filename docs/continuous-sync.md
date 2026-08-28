# Continuous sync

Burnbook uses near-real-time scheduled sync. It does not stream a model response
or keep a Burnbook process running. After an assistant writes a completed usage
event locally, Burnbook normally delivers its token counters within about 60
seconds under normal network conditions. Dashboard refresh and public CDN
caching can add separate display delay.

## Supported platforms

| Platform | Automatic scheduling | Current status |
|---|---|---|
| macOS | User LaunchAgent, every 60 seconds | Stable |
| Linux | User systemd timer, every 60 seconds | Stable |
| Windows | Current-user Task Scheduler task, every 60 seconds | Stable |

Claude Code hooks can request a sync immediately after a completed turn. The
platform timer remains authoritative and also discovers completed Codex usage.
Burnbook does not install a system cron job or administrator task.

## Install and lifecycle

Use a global installation for durable scheduling:

```bash
npm install -g burnbook
burn login
burn repair
```

The scheduler must reference a stable CLI and Node.js path. An `npx` cache path
is temporary and can disappear, so an `npx` invocation is not suitable for
durable automatic sync.

`burn login` authorizes the device and stores its credential. It deliberately
does not install hooks or background scheduling. On supported desktops,
`burn repair` then:

1. installs or repairs supported assistant hooks;
2. installs the managed launchd, systemd, or Task Scheduler definition;
3. registers the current-user background job; and
4. requests an immediate backfill and delivery attempt.

The managed job starts after login or reboot and repeats every 60 seconds. Each
invocation runs one bounded sync and exits. Platform overlap controls and
Burnbook's sync lock prevent overlap with hooks or a manual sync.

Use these commands throughout the lifecycle:

```bash
burn status         # inspect account and automatic-sync state
burn doctor         # inspect credentials, scheduler, worker, and queue
burn sync           # request an immediate diagnostic sync
burn repair         # install or repair Burnbook hooks and scheduling
burn uninstall      # remove Burnbook automation but preserve local state
```

`burn init` remains a deprecated compatibility alias for repair. Existing
installations can continue to use `burn init --remove` to disable and
remove automation safely.

Removal unloads the owned job before deleting its validated definition and removes
only exact Burnbook hook entries. It preserves login credentials, signing keys,
cursors, retry spool, and health state so manual sync and later repair remain
safe. It never rewrites unrelated assistant hooks.

## Privacy and delivery

Collectors emit only completed, content-free usage records: identifiers,
timestamps, model or agent identity when available, and token counters.
Burnbook never uploads prompts, responses, code, paths, diffs, tool payloads,
or repository content.

Normalized records enter the owner-only local spool before cursors advance.
Offline and server failures leave records queued for a later invocation.
Duplicate timer, hook, and manual requests remain safe because the local lock,
event identifiers, and server ingestion are idempotent.

## Rollback

Run `burn uninstall` first. If a release is defective, disable its
scheduler before deprecating or replacing the npm version. Do not delete the
local Burnbook directory: it contains the evidence queue and cursors required
for safe recovery. Manual `burn sync` remains available while automatic
scheduling is disabled.

Maintainers release scheduler changes through the tag-driven npm workflow. See
[Releasing the CLI](RELEASING.md). The cancelled `cli-v0.1.5` tag was never
published; the first eligible continuous-sync release is `0.1.6` or later.
