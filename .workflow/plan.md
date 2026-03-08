# Technical Plan — Large Text Attachment Reading + Safe Upstream Sync Track

**Status:** Approved
**Date:** 2026-03-08

## Architecture Summary

- Zulip upload processing currently inlines only small text files and drops large text files from downstream media analysis.
- Auto-reply always runs `applyMediaUnderstanding()`, which can already extract readable text attachments into model-visible `<file ...>` blocks.
- Lionroot content routing currently sees only attachment MIME summaries, not extracted text, during classification.
- Upstream sync is a separate track because local `main` is heavily divergent from `upstream/main` and the worktree is dirty.

## Implementation Phases

1. **Workflow + provenance**
   - Write task-specific workflow docs.
2. **Large text attachment fix**
   - Update `extensions/zulip/src/zulip/monitor.ts` so large text uploads are cached for model analysis instead of being dropped after the inline-size threshold.
   - Preserve helpful operator-visible attachment notes.
3. **Lionroot routing improvement**
   - Update `src/lionroot/content-route.ts` / `src/lionroot/content-intake.ts` so classifiers can use attachment text context for readable text files rather than only MIME labels.
4. **Verification**
   - Add/adjust focused tests for Zulip upload handling and Lionroot routing behavior.
5. **Upstream sync track**
   - Document current ahead/behind state, why a blind merge is unsafe, and the recommended next sync procedure.

## Files to Modify

- `extensions/zulip/src/zulip/monitor.ts`
- `extensions/zulip/src/zulip/monitor.test.ts`
- `src/lionroot/content-intake.ts`
- `src/lionroot/routing/content-route.ts`
- `src/lionroot/routing/content-route.test.ts`
- additional test files only if needed

## Testing Strategy

- Run targeted Vitest coverage for Zulip upload handling.
- Run targeted Vitest coverage for Lionroot content routing/classification.
- Prefer focused tests over full-suite runs because the repo is large and already dirty.

## Rollback Plan

- Revert only the touched files if the new attachment flow causes regressions.
- Keep upstream sync work out of this patch so rollback remains small and isolated.
