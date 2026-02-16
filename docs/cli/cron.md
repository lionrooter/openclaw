---
summary: "CLI reference for `openclaw cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: "cron"
---

# `openclaw cron`

Manage cron jobs for the Gateway scheduler.

Related:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

Tip: run `openclaw cron --help` for the full command surface.

Note: isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

Note: one-shot (`--at`) jobs delete after success by default. Use `--keep-after-run` to keep them.

Note: recurring jobs now use exponential retry backoff after consecutive errors (30s → 1m → 5m → 15m → 60m), then return to normal schedule after the next successful run.

## Common edits

Update delivery settings without changing the message:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
openclaw cron edit <job-id> --no-deliver
```

Announce to a specific channel:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

## Timeout-safe manual runs

For long isolated jobs, `cron.run` can exceed the default CLI timeout (`--timeout 30000`).
The command now includes built-in safety rails:

- Delivery preflight for isolated `announce` jobs (unless `--no-preflight`).
- Automatic run-log verification on timeout (unless `--no-verify-on-timeout`).

```bash
openclaw cron run <job-id> --timeout 30000 --verify-timeout 180000 --verify-poll 3000
```

Useful flags:

- `--no-preflight`: skip channel preflight checks.
- `--no-verify-on-timeout`: disable timeout recovery via `cron.runs`.
- `--preflight-timeout <ms>`: timeout for `channels.status` preflight.
