# Technical Plan — Zulip Inline Attachment Prompting Fix

**Status:** Approved
**Date:** 2026-03-09

## Architecture Summary

- `extensions/zulip/src/zulip/monitor.ts` builds Zulip attachment prompt text in `processZulipUploads()` and `buildZulipAgentBody()`.
- The live session transcript proves the inline attachment text already reaches `BodyForAgent`.
- The bad behavior comes from how the prompt still presents the file as an attached artifact, which encourages a redundant `read` call on the bare filename.

## Implementation Phases

1. **Workflow + scope**
   - Replace stale workflow docs with this approved task scope.
2. **Prompt wording fix**
   - In the inline-text branch of `processZulipUploads()`, replace the generic `[attached: ...]` placeholder with wording that says the file contents are already included below.
   - Adjust the inline attachment section wording to explicitly say no tool read is needed unless a real path is provided.
   - In the large-text cached branch, include the saved filesystem path in the prompt note so the agent knows where the cached file actually lives.
   - Leave binary-file handling unchanged.
3. **Focused tests**
   - Update Zulip monitor tests to assert the new inline-text wording.
4. **Verification**
   - Run focused Zulip tests.
   - Send a fresh live Zulip upload verification and inspect Cody’s reply/session behavior.

## Files to Modify

- `extensions/zulip/src/zulip/monitor.ts`
- `extensions/zulip/src/zulip/monitor.test.ts`
- workflow docs only as task gate

## Testing Strategy

- Run focused Vitest on Zulip monitor/url-bridge tests.
- Re-run the live marker test in Zulip and inspect both Cody’s visible reply and the underlying session transcript.

## Rollback Plan

- Revert the wording change if it harms attachment clarity or causes regressions in other Zulip workflows.
- Keep the earlier `BodyForAgent` fix regardless; it is independently correct.
