# Technical Plan — Large Text Attachment Reading + Upstream Sync

**Status:** Approved
**Date:** 2026-03-08

## Architecture Summary

- Zulip upload processing currently inlines only small text files and previously dropped large text files from downstream media analysis.
- Auto-reply runs `applyMediaUnderstanding()`, which can extract readable text attachments into model-visible `<file ...>` blocks.
- Lionroot content routing can use bounded text excerpts from readable attachments during classification.
- Upstream sync must be executed in an isolated worktree because local `main` is both heavily divergent from `upstream/main` and dirty.

## Implementation Phases

1. **Workflow + provenance**
   - Maintain task-specific workflow docs.
2. **Large text attachment fix**
   - Cache oversized Zulip text uploads for model analysis.
   - Pass readable attachment text into Lionroot content classification.
   - Add focused regression tests.
3. **Upstream sync execution**
   - Create a dedicated worktree/branch from current `main`.
   - Merge `upstream/main` there.
   - Resolve conflicts, prioritizing Lionroot-local surfaces under `extensions/zulip/*`, `src/lionroot/*`, and related `src/imessage/*` hooks.
4. **Verification**
   - Run focused regression coverage in the sync worktree.
   - Document remaining risks and follow-ups.

## Files Already Changed

- `extensions/zulip/src/zulip/monitor.ts`
- `extensions/zulip/src/zulip/monitor.test.ts`
- `src/lionroot/content-intake.ts`
- `src/lionroot/content-intake.test.ts`
- `src/lionroot/routing/content-route.ts`
- `src/lionroot/routing/content-route.test.ts`

## Upstream Sync Hotspots

- `extensions/zulip/*`
- `src/lionroot/*`
- selected `src/imessage/*` files

## Testing Strategy

- Run targeted Vitest coverage for Zulip upload handling.
- Run targeted Vitest coverage for Lionroot content routing/classification.
- After merge resolution, rerun focused coverage on touched Lionroot-local areas before broader validation.

## Rollback Plan

- Keep the txt-attachment fix committed separately from the sync worktree effort.
- If the merge becomes unstable, discard the isolated worktree/branch without touching the primary checkout.
