# Implementation Plan: Zulip Message Replay

**Status:** ✅ Implemented

## Changes Made

### 1. client.ts

- Added `ZulipMessagesResponse` type
- Added `fetchZulipMessages()` function to query recent messages via `GET /messages`

### 2. monitor.ts

- Added import for `fetchZulipMessages`
- Added `lastProcessedTimestamp` tracking variable (initialized to current time)
- Added `replayMissedMessages()` function that:
  - Fetches last 100 messages
  - Filters to messages newer than `lastProcessedTimestamp`
  - Filters out bot's own messages
  - Processes missed messages oldest-first
  - Gracefully handles errors (non-fatal)
- Integrated call to `replayMissedMessages()` after queue registration
- Updated event loop to track `lastProcessedTimestamp` as messages are processed

## Configuration

- `MAX_REPLAY_MESSAGES`: 100
- `MAX_REPLAY_AGE_SECONDS`: 300 (5 minutes)

## Testing

- Restart gateway to load changes
- Send message, trigger restart, verify message is replayed

## Review Checklist

- [x] Code compiles (plugin loads dynamically)
- [x] Existing dedup() prevents duplicates
- [x] Error handling is non-fatal
- [x] Timestamp tracking covers both replay and normal paths
