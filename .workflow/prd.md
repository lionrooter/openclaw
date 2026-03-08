# PRD — Large Text Attachment Reading + Upstream Sync

**Status:** Approved
**Date:** 2026-03-08
**Provenance:** See `.workflow/inputs/original-request.md`.

## Summary

Lionroot’s OpenClaw deployment should correctly read large pasted posts that arrive as `.txt` attachments instead of only reporting the filename. This task also now includes executing a real upstream sync in an isolated worktree so newer OpenClaw features can be integrated without disturbing the dirty primary checkout.

## User Stories

- As Bryan, when I paste a long post that becomes a `.txt` attachment, I want OpenClaw to read the contents instead of saying it cannot open the file.
- As an operator, I want large text attachments to go through the same safe extraction pipeline as other readable documents.
- As a maintainer, I want the upstream sync executed in an isolated worktree instead of as a blind merge into the dirty primary checkout.

## Acceptance Criteria

- [x] Task-specific workflow docs exist and are approved.
- [x] Large text attachments received through Lionroot intake paths are made available to the model for reading.
- [x] Existing small inline text attachment behavior remains sane and readable.
- [x] Routing/classification paths that need attachment context do better than MIME-only summaries for text attachments.
- [x] Focused regression tests cover the large-text attachment path.
- [ ] Upstream sync is executed in an isolated worktree with conflicts resolved or clearly documented.
- [ ] Verification shows the synced worktree still passes focused regression coverage for the Lionroot-local areas touched by the merge.

## Out of Scope

- Blindly merging or rebasing 927 upstream commits into the current dirty primary worktree.
- Reworking unrelated attachment systems that already reach the shared extraction pipeline correctly.
- General product cleanup unrelated to text attachment ingestion or sync planning.

## Technical Notes

- Core reusable extractor already exists in `src/media-understanding/apply.ts`.
- The large-text fix lands in Lionroot-local intake paths such as `extensions/zulip/src/zulip/monitor.ts` and `src/lionroot/*`.
- Upstream sync must happen in a dedicated worktree/branch created from current `main`, then merged with `upstream/main` there.
