# Technical Plan — Repo-wide Typecheck Failure Cleanup

**Status:** Approved
**Date:** 2026-03-10
**Flow/Context Builder Output:** RepoPrompt plan identified three narrow failures: unreachable dead code in Feishu warnings, an overly narrow `remote.apiKey` type in memory search, and stale test fixtures in content intake missing `lastRoutePolicy` and updated media field names.

## Architecture

- `extensions/feishu/src/channel.ts` delegates warning generation to the shared allowlist/group-policy helper; it should not contain extra fallback logic after returning.
- `src/agents/memory-search.ts` merges config that may carry `SecretInput` through to embedding provider creation, where secrets are resolved lazily.
- `src/lionroot/content-intake.test.ts` builds synthetic route fixtures and params that must match current `ResolvedAgentRoute` and content-intake parameter shapes.

## Files to Modify

- `extensions/feishu/src/channel.ts` — remove dead fallback code after the warning helper return.
- `src/agents/memory-search.ts` — widen the merged remote `apiKey` type to `SecretInput`.
- `src/lionroot/content-intake.test.ts` — update fixtures to current route and media field shapes.

## Tasks

1. [ ] Remove the Feishu undefined `groupPolicy` dead code path.
2. [ ] Align memory-search remote API key typing with config/runtime types.
3. [ ] Update content-intake test fixtures to current route/media contracts.
4. [ ] Run focused verification for the touched areas plus Zulip regression tests.
5. [ ] Re-run `pnpm check` and report any remaining blockers.

## Testing Strategy

- Run targeted tests for `memory-search` and `content-intake` where available.
- Re-run the focused Zulip tests to guard the previously-completed work.
- Re-run `pnpm check` to identify whether any blockers remain after the narrow fixes.

## Rollback Plan

- Revert these three files only; each change is isolated and does not depend on the Zulip attachment commit.
