# Technical Plan — Repo-wide Lint Cleanup

**Status:** Approved
**Date:** 2026-03-10
**Flow/Context Builder Output:** Lint backlog profiling shows 410 remaining diagnostics after the initial pass, led by `no-explicit-any`, `curly`, `no-unsafe-optional-chaining`, `no-unused-vars`, and `no-unnecessary-type-assertion`. The first safe tranche targets mechanical fixes only.

## Architecture

- Lint cleanup should be done in narrow, rule-driven batches.
- Mechanical rule families (`curly`, `no-unused-vars`) should be preferred first because they are low-risk and often auto-fixable.
- Higher-cost categories such as `no-explicit-any` should be deferred until after easy wins reduce noise.

## Files to Modify

### First safe tranche

- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/outbound.ts`
- `extensions/zalo/src/accounts.ts`
- `extensions/zalo/src/channel.ts`

### Deferred until separately cleaned

- Synology Chat, Mattermost, and Feishu docx helper files touched by exploratory autofix but not yet brought clean.

## Tasks

1. [x] Profile lint backlog by rule and file.
2. [x] Fix a first mechanical tranche (`curly`, `no-unused-vars`, safe typing cleanup) in the four selected files.
3. [ ] Commit the first clean tranche.
4. [ ] Re-profile the backlog and select the next tranche.

## Testing Strategy

- Re-run `oxlint --type-aware` on the selected tranche files.
- Re-run formatting checks on those files.
- Preserve previously passing targeted Zulip/typecheck tests.

## Rollback Plan

- Revert the tranche commit if any behavior regresses.
- Keep future lint cleanup isolated in separate commits by tranche.
