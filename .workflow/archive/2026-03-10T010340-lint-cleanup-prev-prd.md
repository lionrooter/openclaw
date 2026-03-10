# PRD — Repo-wide Lint Cleanup

**Status:** Approved
**Date:** 2026-03-10
**Provenance:** Bryan explicitly asked to continue into the repo-wide lint failures after the typecheck cleanup was committed and pushed on 2026-03-10.

## Summary

Reduce the current repo-wide lint backlog in `clawdbot` with a pragmatic, category-driven cleanup plan aimed at making `pnpm check` materially healthier and eventually green.

## User Stories

- As a maintainer, I want lint failures grouped and attacked by highest-yield categories instead of random file hopping.
- As an engineer, I want fixes to be mostly mechanical and low-risk.
- As an operator, I do not want the already-verified Zulip or typecheck fixes to regress during lint cleanup.

## Acceptance Criteria

- [x] Workflow docs exist for this scope.
- [ ] Lint backlog is profiled by rule and high-impact files.
- [ ] A first safe tranche of lint fixes lands with targeted verification.
- [ ] Previously-fixed Zulip and typecheck areas still pass focused verification.

## Out of Scope

- Feature work.
- Broad refactors that are not needed for lint compliance.
- Changing lint policy/config unless strictly required.
