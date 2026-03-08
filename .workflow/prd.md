# PRD — Large Text Attachment Reading + Safe Upstream Sync Track

**Status:** Approved
**Date:** 2026-03-08
**Provenance:** See `.workflow/inputs/original-request.md`.

## Summary

Lionroot’s OpenClaw deployment should correctly read large pasted posts that arrive as `.txt` attachments instead of only reporting the filename. The immediate implementation scope is to fix the attachment-reading path so large text files can reach the model and related routing logic. Separately, the fork should be prepared for a safe upstream feature update, but that sync work must not be bundled into the bug fix because the local repo is both divergent and dirty.

## User Stories

- As Bryan, when I paste a long post that becomes a `.txt` attachment, I want OpenClaw to read the contents instead of saying it cannot open the file.
- As an operator, I want large text attachments to go through the same safe extraction pipeline as other readable documents.
- As a maintainer, I want the upstream sync handled as a separate, low-risk track instead of a blind merge into a dirty fork.

## Acceptance Criteria

- [x] Task-specific workflow docs exist and are approved.
- [ ] Large text attachments received through Lionroot intake paths are made available to the model for reading.
- [ ] Existing small inline text attachment behavior remains sane and readable.
- [ ] Routing/classification paths that need attachment context do better than MIME-only summaries for text attachments.
- [ ] Focused regression tests cover the large-text attachment path.
- [ ] Upstream sync is documented as a separate follow-up track with concrete risk notes and next steps.

## Out of Scope

- Blindly merging or rebasing 927 upstream commits into the current dirty worktree.
- Reworking unrelated attachment systems that already reach the shared extraction pipeline correctly.
- General product cleanup unrelated to text attachment ingestion or sync planning.

## Technical Notes

- Core reusable extractor already exists in `src/media-understanding/apply.ts`.
- Likely fix points are `extensions/zulip/src/zulip/monitor.ts` and Lionroot intake/routing files under `src/lionroot/`.
- iMessage attachment flow appears to already populate `MediaPath/MediaPaths`, so it should be verified but changed only if needed.
