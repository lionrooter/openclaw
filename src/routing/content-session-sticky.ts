/**
 * Session stickiness for content-based routing.
 *
 * Keeps track of which agent a peer was recently routed to,
 * so ambiguous follow-up messages stay with the same agent
 * unless a clear topic switch is detected.
 */

export type StickyEntry = {
  agentId: string;
  lastAt: number;
};

export type ContentConfidence = "high" | "medium" | "low";

const stickyMap = new Map<string, StickyEntry>();

/**
 * Resolve final agent considering session stickiness.
 *
 * Rules:
 * 1. No recent sticky entry → use new classification, set sticky.
 * 2. Recent entry + new classification "high" confidence + different agent → switch (topic change).
 * 3. Recent entry + "medium"/"low" confidence → stay sticky (ambiguous follow-up).
 * 4. Always refresh timestamp.
 */
export function resolveWithStickiness(opts: {
  peer: string;
  newAgentId: string;
  newConfidence: ContentConfidence;
  stickyTimeoutMs: number;
  now?: number;
}): string {
  const now = opts.now ?? Date.now();
  const existing = stickyMap.get(opts.peer);

  // No recent sticky → use new classification
  if (!existing || now - existing.lastAt > opts.stickyTimeoutMs) {
    stickyMap.set(opts.peer, { agentId: opts.newAgentId, lastAt: now });
    return opts.newAgentId;
  }

  // Same agent → just refresh timestamp
  if (existing.agentId === opts.newAgentId) {
    existing.lastAt = now;
    return existing.agentId;
  }

  // Different agent + high confidence → topic switch
  if (opts.newConfidence === "high") {
    stickyMap.set(opts.peer, { agentId: opts.newAgentId, lastAt: now });
    return opts.newAgentId;
  }

  // Different agent + medium/low confidence → stay sticky
  existing.lastAt = now;
  return existing.agentId;
}

/** Get the current sticky entry for a peer (for testing/debugging). */
export function getStickyEntry(peer: string): StickyEntry | undefined {
  return stickyMap.get(peer);
}

/** Clear a single peer's sticky entry. */
export function clearStickyEntry(peer: string): void {
  stickyMap.delete(peer);
}

/** Clear all sticky entries (for testing). */
export function clearAllSticky(): void {
  stickyMap.clear();
}
