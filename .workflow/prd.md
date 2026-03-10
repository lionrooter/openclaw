# PRD — Zulip Inline Attachment Prompting Fix

**Status:** Approved
**Date:** 2026-03-09
**Provenance:** Approved by Bryan in chat on 2026-03-09 after live verification showed the Zulip intake path now inlines upload text into Cody’s session input, but Cody still tries a redundant local `read` of the attachment filename instead of answering from the already-included text.

## Summary

Adjust the Zulip attachment prompt formatting so agents treat small readable uploads as already-present prompt text, and expose the real cached filesystem path for large readable uploads that are saved for later tool access.

## User Stories

- As Bryan, when I paste a small text upload into Zulip, I want Cody to answer directly from the inline text.
- As an operator, when attachment text is already present in the agent prompt, I do not want the model to waste a turn trying to `read` a filename that is not in its cwd.
- As a maintainer, I want this fix to stay narrow to Zulip readable text uploads without changing binary attachment handling.

## Acceptance Criteria

- [x] Task-specific workflow docs exist and are approved.
- [ ] Inline text uploads in Zulip are labeled as already included, not just generically attached.
- [ ] The inline-text body wording discourages redundant read-tool calls.
- [ ] Large cached text uploads include the real saved filesystem path in the prompt note.
- [ ] Binary attachment behavior remains unchanged.
- [ ] Focused Zulip tests cover the new wording.
- [ ] A fresh live Zulip upload test shows Cody answering from the inline marker rather than trying to open the filename.

## Out of Scope

- General tool-selection training for all agents.
- Reworking non-Zulip attachment behavior.
- Large architectural changes to prompt assembly.

## Technical Notes

- The previous `BodyForAgent` fix is working: the session transcript now includes the inline file contents and marker.
- The remaining issue is prompt semantics, not attachment ingestion.
- The safest fix is to change the placeholder and attachment heading/line wording specifically for inlined text attachments.
