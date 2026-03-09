# PRD — QMD ABI Guard + Main Heartbeat Session Reset

**Status:** Approved
**Date:** 2026-03-09
**Provenance:** Approved by Bryan in chat after live verification showed (1) the gateway can recover from BlockRun failures on 2026.3.3, (2) QMD native-module ABI mismatches can recur after Node upgrades, and (3) the `main` heartbeat session is too contaminated to be a trustworthy validation surface without an explicit reset.

## Summary

Make gateway startup degrade cleanly when QMD fails due to a native-module ABI mismatch instead of repeatedly logging noisy startup/update errors, and rotate the `main` session through the supported session-reset path so heartbeat behavior can be validated on a clean session.

## User Stories

- As Bryan, when the gateway runtime changes Node ABI, I want memory search to disable itself cleanly instead of spamming logs or partially arming QMD.
- As an operator, when QMD is unavailable because of a native build mismatch, I want the gateway to continue booting with a clear warning and no repeated background failures.
- As a maintainer, when I validate heartbeat behavior on `main`, I want a clean session reset using supported APIs rather than stale transcript state.

## Acceptance Criteria

- [x] Task-specific workflow docs exist and are approved.
- [ ] `src/memory/qmd-manager.ts` detects native-module ABI mismatch failures during QMD initialization and degrades cleanly.
- [ ] QMD init aborts before recurring update loops are armed when the failure is an ABI mismatch.
- [ ] A focused test covers the ABI-mismatch guard behavior.
- [ ] The `main` session is reset through the supported session-reset path, not by manual store corruption.
- [ ] A post-reset heartbeat soak on `main` yields a clean result that reflects the current heartbeat contract rather than stale session contamination.

## Out of Scope

- Reworking QMD sync semantics beyond the ABI-mismatch guard.
- Rewriting the heartbeat runner.
- Bulk-resetting every agent session.

## Technical Notes

- The live runtime already recovered after a manual rebuild of `better-sqlite3`; the source fix should prevent future upgrades from degrading badly before an operator rebuilds native modules.
- The clean operational reset path is the gateway `sessions.reset` handler.
- The post-reset heartbeat check should be bounded and avoid unnecessary channel spam where possible.
