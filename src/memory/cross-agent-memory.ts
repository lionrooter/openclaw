/**
 * Cross-agent memory sharing.
 *
 * Enables agents to publish important facts/insights to a shared memory pool
 * that other agents can search. This goes beyond the current read-only vault
 * paths by providing active memory propagation between agents.
 *
 * Architecture:
 * - Shared JSONL store at ~/.openclaw/memory/shared/<agentId>-published.jsonl
 * - Each agent publishes facts with tags, confidence, and expiry
 * - Any agent can search the shared pool alongside their own memory
 * - Trust scoring from trust-scoring.ts is extended: shared memories get
 *   a configurable trust multiplier (default: 0.7, below sessions at 0.8)
 *
 * This module implements piece #19 (Cross-Agent Sharing) of the 31-piece
 * memory framework, upgrading it from 0.5 (read-only vault paths) to 1.0
 * (active memory propagation with search integration).
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/shared");

// ─── Types ───────────────────────────────────────────────────────────────────

export type SharedMemoryEntry = {
  /** Unique entry ID */
  id: string;
  /** Agent who published this fact */
  publishedBy: string;
  /** The fact/insight text */
  fact: string;
  /** Categorization tags for discoverability */
  tags: string[];
  /** How confident the publishing agent is (0-1). Default: 0.8 */
  confidence: number;
  /** Optional scope: which agents should see this? Empty = all agents */
  visibleTo: string[];
  /** Optional: which agents should NOT see this */
  hiddenFrom: string[];
  /** Epoch ms when published */
  timestamp: number;
  /** Epoch ms when this fact expires (0 = never) */
  expiresAt: number;
  /** Source context: what conversation/file generated this fact */
  sourceContext?: string;
  /** Whether this entry has been superseded by a newer fact */
  supersededBy?: string;
};

export type SharedMemorySearchResult = {
  entry: SharedMemoryEntry;
  /** Relevance score from text matching */
  score: number;
};

export type SharedMemoryConfig = {
  /** Enable shared memory pool. Default: true */
  enabled: boolean;
  /** Max entries per agent in their published file. Default: 500 */
  maxEntriesPerAgent: number;
  /** Default time-to-live for facts in days. 0 = never expire. Default: 90 */
  defaultTtlDays: number;
  /** Trust multiplier for shared memories in search scoring. Default: 0.7 */
  trustMultiplier: number;
  /** Max results when searching shared pool. Default: 5 */
  maxSearchResults: number;
};

export const DEFAULT_SHARED_MEMORY_CONFIG: SharedMemoryConfig = {
  enabled: true,
  maxEntriesPerAgent: 500,
  defaultTtlDays: 90,
  trustMultiplier: 0.7,
  maxSearchResults: 5,
};

// ─── File Paths ──────────────────────────────────────────────────────────────

const SHARED_DIR = ".openclaw/memory/shared";

function resolveSharedDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, SHARED_DIR);
}

function resolvePublishedFile(agentId: string): string {
  return path.join(resolveSharedDir(), `${agentId}-published.jsonl`);
}

// ─── Publish ─────────────────────────────────────────────────────────────────

/**
 * Publish a fact to the shared memory pool.
 *
 * The fact becomes searchable by all agents (unless scoped via visibleTo/hiddenFrom).
 *
 * @param params.agentId     - Publishing agent
 * @param params.fact        - The fact text (will be searched via keyword matching)
 * @param params.tags        - Categorization tags
 * @param params.confidence  - How confident (0-1). Default: 0.8
 * @param params.visibleTo   - Restrict visibility to these agents (empty = all)
 * @param params.hiddenFrom  - Hide from these agents
 * @param params.ttlDays     - Days until expiry (0 = never). Default: from config
 * @param params.sourceContext - What generated this fact
 */
export function publishSharedMemory(params: {
  agentId: string;
  fact: string;
  tags?: string[];
  confidence?: number;
  visibleTo?: string[];
  hiddenFrom?: string[];
  ttlDays?: number;
  sourceContext?: string;
  config?: Partial<SharedMemoryConfig>;
}): SharedMemoryEntry {
  const config = { ...DEFAULT_SHARED_MEMORY_CONFIG, ...params.config };
  const now = Date.now();
  const ttlDays = params.ttlDays ?? config.defaultTtlDays;

  const entry: SharedMemoryEntry = {
    id: generateId(),
    publishedBy: params.agentId,
    fact: params.fact.trim(),
    tags: params.tags ?? [],
    confidence: Math.max(0, Math.min(1, params.confidence ?? 0.8)),
    visibleTo: params.visibleTo ?? [],
    hiddenFrom: params.hiddenFrom ?? [],
    timestamp: now,
    expiresAt: ttlDays > 0 ? now + ttlDays * 24 * 60 * 60 * 1000 : 0,
    sourceContext: params.sourceContext,
  };

  const sharedDir = resolveSharedDir();
  try {
    fs.mkdirSync(sharedDir, { recursive: true });
  } catch {
    // Best-effort
  }

  const logFile = resolvePublishedFile(params.agentId);
  try {
    const line = JSON.stringify(entry);
    fs.appendFileSync(logFile, line + "\n", "utf-8");
  } catch (err) {
    log.warn(`Failed to publish shared memory: ${String(err)}`);
  }

  // Prune if over limit
  prunePublishedFile(params.agentId, config.maxEntriesPerAgent);

  return entry;
}

/**
 * Supersede (replace) a previously published fact.
 */
export function supersedeSharedMemory(params: {
  agentId: string;
  oldEntryId: string;
  newFact: string;
  tags?: string[];
  confidence?: number;
  config?: Partial<SharedMemoryConfig>;
}): SharedMemoryEntry | null {
  const entries = loadPublishedEntries(params.agentId);
  const old = entries.find((e) => e.id === params.oldEntryId);
  if (!old) {
    return null;
  }

  // Publish the new fact
  const newEntry = publishSharedMemory({
    agentId: params.agentId,
    fact: params.newFact,
    tags: params.tags ?? old.tags,
    confidence: params.confidence ?? old.confidence,
    visibleTo: old.visibleTo,
    hiddenFrom: old.hiddenFrom,
    sourceContext: old.sourceContext,
    config: params.config,
  });

  // Mark old entry as superseded by rewriting file
  const updatedEntries = entries.map((e) => {
    if (e.id === params.oldEntryId) {
      return { ...e, supersededBy: newEntry.id };
    }
    return e;
  });

  writePublishedEntries(params.agentId, updatedEntries);
  return newEntry;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search the shared memory pool.
 *
 * Searches across all agents' published facts, filtering by:
 * - Visibility (visibleTo/hiddenFrom)
 * - Expiry (skip expired entries)
 * - Superseded entries (skip)
 * - Text relevance (keyword matching)
 *
 * @param params.query      - Search query text
 * @param params.agentId    - The searching agent (for visibility filtering)
 * @param params.tags       - Optional tag filter (entries must have at least one matching tag)
 * @param params.maxResults - Max results to return
 * @param params.config     - Shared memory configuration
 */
export function searchSharedMemory(params: {
  query: string;
  agentId: string;
  tags?: string[];
  maxResults?: number;
  config?: Partial<SharedMemoryConfig>;
}): SharedMemorySearchResult[] {
  const config = { ...DEFAULT_SHARED_MEMORY_CONFIG, ...params.config };
  if (!config.enabled) {
    return [];
  }

  const maxResults = params.maxResults ?? config.maxSearchResults;
  const now = Date.now();
  const queryTokens = tokenize(params.query.toLowerCase());

  if (queryTokens.length === 0) {
    return [];
  }

  // Load entries from all agents
  const allEntries = loadAllSharedEntries();

  // Filter and score
  const scored: SharedMemorySearchResult[] = [];

  for (const entry of allEntries) {
    // Skip expired
    if (entry.expiresAt > 0 && entry.expiresAt < now) {
      continue;
    }

    // Skip superseded
    if (entry.supersededBy) {
      continue;
    }

    // Skip if not visible to this agent
    if (entry.visibleTo.length > 0 && !entry.visibleTo.includes(params.agentId)) {
      continue;
    }
    if (entry.hiddenFrom.includes(params.agentId)) {
      continue;
    }

    // Skip own entries (agents shouldn't search their own published facts
    // — those are already in their memory index)
    if (entry.publishedBy === params.agentId) {
      continue;
    }

    // Tag filter
    if (params.tags && params.tags.length > 0) {
      const hasMatchingTag = params.tags.some((tag) =>
        entry.tags.some((et) => et.toLowerCase() === tag.toLowerCase()),
      );
      if (!hasMatchingTag) {
        continue;
      }
    }

    // Score by keyword matching
    const factTokens = tokenize(entry.fact.toLowerCase());
    const tagTokens = entry.tags.flatMap((t) => tokenize(t.toLowerCase()));
    const allTokens = [...factTokens, ...tagTokens];

    let matchCount = 0;
    for (const qt of queryTokens) {
      if (allTokens.some((t) => t.includes(qt) || qt.includes(t))) {
        matchCount++;
      }
    }

    if (matchCount === 0) {
      continue;
    }

    // Score: fraction of query tokens matched × confidence × recency factor
    const matchFraction = matchCount / queryTokens.length;
    const ageDays = (now - entry.timestamp) / (24 * 60 * 60 * 1000);
    const recency = Math.exp(-0.01 * ageDays); // gentle decay
    const score = matchFraction * entry.confidence * recency * config.trustMultiplier;

    scored.push({ entry, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * List all facts published by a specific agent (for review/management).
 */
export function listPublishedMemories(agentId: string): SharedMemoryEntry[] {
  return loadPublishedEntries(agentId).filter((e) => !e.supersededBy);
}

/**
 * Get summary stats for the shared memory pool.
 */
export function getSharedMemoryStats(): {
  totalEntries: number;
  activeEntries: number;
  byAgent: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
} {
  const allEntries = loadAllSharedEntries();
  const now = Date.now();
  const active = allEntries.filter(
    (e) => !e.supersededBy && (e.expiresAt === 0 || e.expiresAt > now),
  );

  const byAgent: Record<string, number> = {};
  const tagCounts = new Map<string, number>();

  for (const entry of active) {
    byAgent[entry.publishedBy] = (byAgent[entry.publishedBy] ?? 0) + 1;
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalEntries: allEntries.length,
    activeEntries: active.length,
    byAgent,
    topTags,
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function generateId(): string {
  return `sm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tokenize(text: string): string[] {
  return (
    text
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1) ?? []
  );
}

function loadPublishedEntries(agentId: string): SharedMemoryEntry[] {
  const logFile = resolvePublishedFile(agentId);
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as SharedMemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is SharedMemoryEntry => e !== null);
  } catch {
    return [];
  }
}

function writePublishedEntries(agentId: string, entries: SharedMemoryEntry[]): void {
  const logFile = resolvePublishedFile(agentId);
  try {
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(logFile, content, "utf-8");
  } catch {
    // Best-effort
  }
}

function loadAllSharedEntries(): SharedMemoryEntry[] {
  const sharedDir = resolveSharedDir();
  try {
    const files = fs.readdirSync(sharedDir);
    const entries: SharedMemoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith("-published.jsonl")) {
        continue;
      }
      const filePath = path.join(sharedDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as SharedMemoryEntry);
          } catch {
            // Skip malformed
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function prunePublishedFile(agentId: string, maxEntries: number): void {
  const entries = loadPublishedEntries(agentId);
  if (entries.length <= maxEntries) {
    return;
  }
  // Keep the most recent entries, but always keep non-superseded ones
  const active = entries.filter((e) => !e.supersededBy);
  const superseded = entries.filter((e) => e.supersededBy);

  // Remove oldest superseded entries first
  const sorted = [
    ...active.toSorted((a, b) => b.timestamp - a.timestamp),
    ...superseded.toSorted((a, b) => b.timestamp - a.timestamp),
  ].slice(0, maxEntries);

  writePublishedEntries(agentId, sorted);
}
