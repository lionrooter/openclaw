# PRD — Repo-wide Typecheck Failure Cleanup

**Status:** Approved
**Date:** 2026-03-10
**Provenance:** Bryan explicitly asked to proceed after committing and pushing the Zulip attachment work on 2026-03-10.

## Summary

Fix the current unrelated TypeScript/check failures in `clawdbot` so the repo can pass static validation again without changing the already-completed Zulip attachment behavior.

## User Stories

- As a maintainer, I want `pnpm check` to get past current TypeScript failures so the repo is gateable again.
- As an engineer, I want the fixes to stay narrow to the actual broken files and type contracts.
- As an operator, I do not want the already-verified Zulip attachment behavior to regress while unrelated failures are repaired.

## Acceptance Criteria

- [x] Workflow docs exist for this scope.
- [ ] `extensions/feishu/src/channel.ts` typechecks.
- [ ] `src/agents/memory-search.ts` typechecks.
- [ ] `src/lionroot/content-intake.test.ts` typechecks.
- [ ] Focused verification covers the repaired areas.
- [ ] Zulip attachment tests still pass after the unrelated fixes.

## Out of Scope

- New feature work.
- Broad refactors outside the failing type surfaces.
- Reworking the already-committed Zulip attachment implementation.
