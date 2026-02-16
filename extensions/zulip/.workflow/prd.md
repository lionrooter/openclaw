# PRD: Zulip Message Replay on Reconnect

**Status:** ✅ Approved (2026-02-03)  
**Author:** Cody  
**Date:** 2026-02-03

---

## Problem Statement

When the OpenClaw gateway restarts (e.g., config patch), the Zulip plugin reconnects and registers a new event queue. However, messages sent during the disconnection window (typically 1-5 seconds) are lost because Zulip's event queue only delivers new messages, not historical ones.

**Impact:** Users experience missed messages, requiring them to re-send. This is especially frustrating when the restart was triggered by a config change made by the bot itself.

---

## Proposed Solution

Add message replay on reconnect:

1. **Track last seen message timestamp** per account
2. **On reconnection**, before starting event polling:
   - Query Zulip API for messages newer than last seen timestamp
   - Filter to subscribed streams only
   - Process any missed messages through existing `handleMessage()` flow
3. **Update last seen timestamp** as messages are processed

---

## Technical Approach

### Changes to `monitor.ts`:

```typescript
// Track last processed message timestamp per account
let lastProcessedTimestamp = Math.floor(Date.now() / 1000);

// New function to replay missed messages
async function replayMissedMessages(client: ZulipClient, botUserId: number): Promise<void> {
  const anchor = "newest";
  const numBefore = 100; // Max messages to replay

  // Query recent messages from all subscribed streams
  const response = await client.request("GET", "/messages", {
    anchor,
    num_before: numBefore,
    num_after: 0,
    narrow: JSON.stringify([
      { operator: "streams", operand: "public" }, // Or specific subscribed streams
    ]),
  });

  // Filter to messages newer than lastProcessedTimestamp
  const missed = response.messages.filter(
    (m) => m.timestamp > lastProcessedTimestamp && m.sender_id !== botUserId,
  );

  // Process oldest first
  missed.sort((a, b) => a.timestamp - b.timestamp);

  for (const msg of missed) {
    await handleMessage(msg);
  }

  // Update timestamp
  if (missed.length > 0) {
    lastProcessedTimestamp = Math.max(...missed.map((m) => m.timestamp));
  }
}
```

### Integration point in `pollLoop`:

```typescript
// After successful queue registration, before polling
const reg = await registerZulipQueue(client);
queueId = reg.queue_id;
lastEventId = reg.last_event_id;

// NEW: Replay any missed messages
await replayMissedMessages(client, botUserId);

// Continue with normal event polling...
```

---

## Scope

### In Scope

- Message replay for stream messages on reconnect
- Deduplication (existing `dedup()` function handles this)
- Configurable replay window (default: last 100 messages or 5 minutes)

### Out of Scope

- DM replay (lower priority, can add later)
- Cross-restart persistence (would need file storage)

---

## Risks & Mitigations

| Risk                         | Mitigation                                |
| ---------------------------- | ----------------------------------------- |
| Duplicate processing         | Existing `dedup()` function prevents this |
| Processing very old messages | Filter by timestamp, max 100 messages     |
| API rate limits              | Single batch query, not per-message       |

---

## Success Criteria

1. Messages sent during gateway restart are processed after reconnect
2. No duplicate message processing
3. No impact on normal message flow performance

---

## Approval

- [x] Bryan approves PRD (2026-02-03 09:34 EST)
