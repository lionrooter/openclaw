# Technical Plan — QMD ABI Guard + Main Heartbeat Session Reset

**Status:** Approved
**Date:** 2026-03-09

## Architecture Summary

- Gateway memory startup goes through `src/gateway/server-startup-memory.ts` into `src/memory/qmd-manager.ts`.
- `QmdMemoryManager.create()` is the right choke point for detecting initialization failures that should degrade to `null` and let the gateway continue without QMD.
- `main` session lifecycle is managed by the gateway `sessions.reset` handler in `src/gateway/server-methods/sessions.ts`, which resets the session ID, archives transcripts, and cleans runtime state.

## Implementation Phases

1. **Workflow + provenance**
   - Replace stale task docs with this approved scope.
2. **QMD ABI guard**
   - Add a narrow detector for native-module ABI mismatch text in QMD initialization failures.
   - In `QmdMemoryManager.create()`, catch that failure class, log a clear degrade warning, close any partially initialized manager state, and return `null`.
   - Avoid arming periodic update loops after this failure.
3. **Verification**
   - Add a focused unit test covering ABI-mismatch degradation.
   - Run focused QMD and startup-memory tests.
4. **Operational reset + soak**
   - Reset `main` through the supported gateway session-reset path.
   - Trigger a bounded heartbeat/system event check and inspect the resulting session/output for clean behavior.

## Files to Modify

- `src/memory/qmd-manager.ts`
- `src/memory/qmd-manager.test.ts`
- workflow docs only as task gate

## Testing Strategy

- Run focused Vitest coverage for `qmd-manager` and nearby startup-memory tests.
- After code validation, use the live gateway session-reset path and inspect `system heartbeat last` plus the new `main` session transcript.

## Rollback Plan

- Revert the QMD guard if it suppresses legitimate non-ABI initialization failures.
- Use the archived transcript from `sessions.reset` if the operational reset needs to be inspected or reversed manually.
