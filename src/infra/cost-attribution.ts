/**
 * Cost attribution — joins session cost data to agent work.
 *
 * Provides per-agent cost profiles by aggregating session cost data
 * across all an agent's sessions. This is the "observation layer" —
 * it answers "what did this agent cost?" without changing behavior.
 *
 * Integrates with:
 * - session-cost-usage.ts (source of cost data)
 * - provider-usage (source of provider utilization)
 * - memory/embedding-cost-tracker.ts (source of embedding costs)
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readEmbeddingCostSummary,
  type EmbeddingCostSummary,
} from "../memory/embedding-cost-tracker.js";
import { formatErrorMessage } from "./errors.js";
import { loadCostUsageSummary, discoverAllSessions } from "./session-cost-usage.js";
import type { CostUsageSummary, CostUsageTotals } from "./session-cost-usage.types.js";

const log = createSubsystemLogger("budget/attribution");

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentCostProfile = {
  agentId: string;
  /** Time window start (epoch ms) */
  windowStartMs: number;
  /** Time window end (epoch ms) */
  windowEndMs: number;
  /** Total cost across all sessions in window */
  totalCost: number;
  /** Total tokens across all sessions */
  totalTokens: number;
  /** Number of active sessions in window */
  sessionCount: number;
  /** Cost per day average */
  avgDailyCost: number;
  /** Token totals breakdown */
  totals: CostUsageTotals;
  /** Embedding costs (API calls for memory indexing) */
  embeddingCost: EmbeddingCostSummary;
  /** Combined cost including embeddings */
  combinedCost: number;
};

export type FleetCostSnapshot = {
  updatedAt: number;
  windowDays: number;
  agents: AgentCostProfile[];
  fleetTotal: number;
  fleetDailyCost: number;
  /** Total embedding cost across all agents */
  fleetEmbeddingCost: number;
};

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const profileCache = new Map<string, CacheEntry<AgentCostProfile>>();
let fleetCache: CacheEntry<FleetCostSnapshot> | null = null;

function getCached<T>(entry: CacheEntry<T> | null | undefined): T | null {
  if (!entry || Date.now() > entry.expiresAt) {
    return null;
  }
  return entry.data;
}

// ─── Agent Cost Profile ──────────────────────────────────────────────────────

/**
 * Load the cost profile for a single agent.
 *
 * @param agentId  - Agent to profile
 * @param days     - Look-back window (default: 7)
 * @param config   - Optional OpenClaw config for cost resolution
 */
export async function loadAgentCostProfile(params: {
  agentId: string;
  days?: number;
  config?: OpenClawConfig;
}): Promise<AgentCostProfile> {
  const { agentId, days = 7, config } = params;

  const cacheKey = `${agentId}:${days}`;
  const cached = getCached(profileCache.get(cacheKey));
  if (cached) {
    return cached;
  }

  const now = Date.now();
  const startMs = now - days * 24 * 60 * 60 * 1000;

  let summary: CostUsageSummary;
  try {
    summary = await loadCostUsageSummary({
      agentId,
      startMs,
      endMs: now,
      config,
    });
  } catch (err) {
    log.warn(`Failed to load cost summary for agent ${agentId}: ${formatErrorMessage(err)}`);
    summary = {
      updatedAt: now,
      days,
      daily: [],
      totals: emptyTotals(),
    };
  }

  // Discover sessions for this agent in the time window
  let sessionCount = 0;
  try {
    const sessions = await discoverAllSessions({
      agentId,
      startMs,
      endMs: now,
    });
    sessionCount = sessions.length;
  } catch {
    // Best effort — session discovery is optional
  }

  // Load embedding costs for this agent
  let embeddingCost: EmbeddingCostSummary;
  try {
    embeddingCost = readEmbeddingCostSummary({ agentId, days });
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`Failed to read embedding costs for agent ${agentId}: ${reason}`);
    embeddingCost = { totalCost: 0, totalTokens: 0, callCount: 0, providers: {} };
  }

  const profile: AgentCostProfile = {
    agentId,
    windowStartMs: startMs,
    windowEndMs: now,
    totalCost: summary.totals.totalCost,
    totalTokens: summary.totals.totalTokens,
    sessionCount,
    avgDailyCost: days > 0 ? summary.totals.totalCost / days : 0,
    totals: summary.totals,
    embeddingCost,
    combinedCost: summary.totals.totalCost + embeddingCost.totalCost,
  };

  profileCache.set(cacheKey, { data: profile, expiresAt: now + CACHE_TTL_MS });
  return profile;
}

// ─── Fleet Cost Snapshot ─────────────────────────────────────────────────────

/**
 * Load cost profiles for all known agents and produce a fleet-wide snapshot.
 *
 * @param agentIds - List of agent IDs to profile
 * @param days     - Look-back window (default: 7)
 * @param config   - Optional OpenClaw config
 */
export async function loadFleetCostSnapshot(params: {
  agentIds: string[];
  days?: number;
  config?: OpenClawConfig;
}): Promise<FleetCostSnapshot> {
  const { agentIds, days = 7, config } = params;
  const now = Date.now();

  const cached = getCached(fleetCache);
  if (cached && cached.windowDays === days) {
    return cached;
  }

  const agents = await Promise.all(
    agentIds.map((agentId) =>
      loadAgentCostProfile({ agentId, days, config }).catch((err) => {
        log.warn(`Failed to load cost profile for ${agentId}: ${err}`);
        return null;
      }),
    ),
  );

  const validAgents = agents.filter((a): a is AgentCostProfile => a !== null);
  const fleetTotal = validAgents.reduce((sum, a) => sum + a.combinedCost, 0);
  const fleetEmbeddingCost = validAgents.reduce((sum, a) => sum + a.embeddingCost.totalCost, 0);

  const snapshot: FleetCostSnapshot = {
    updatedAt: now,
    windowDays: days,
    agents: validAgents,
    fleetTotal,
    fleetDailyCost: days > 0 ? fleetTotal / days : 0,
    fleetEmbeddingCost,
  };

  fleetCache = { data: snapshot, expiresAt: now + CACHE_TTL_MS };
  return snapshot;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyTotals(): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

/**
 * Format a cost profile as a human-readable summary line.
 */
export function formatAgentCostLine(profile: AgentCostProfile): string {
  const cost = profile.combinedCost;
  const costStr = cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
  const daily =
    profile.avgDailyCost >= 1
      ? `$${profile.avgDailyCost.toFixed(2)}/day`
      : `$${profile.avgDailyCost.toFixed(4)}/day`;
  const embedCost = profile.embeddingCost.totalCost;
  const embedSuffix = embedCost > 0.001 ? ` (incl. $${embedCost.toFixed(4)} embeddings)` : "";
  return `${profile.agentId}: ${costStr} over ${Math.round((profile.windowEndMs - profile.windowStartMs) / 86400000)}d (${daily}, ${profile.sessionCount} sessions)${embedSuffix}`;
}

/**
 * Format the fleet snapshot for a digest or log message.
 */
export function formatFleetCostSummary(snapshot: FleetCostSnapshot): string[] {
  const lines: string[] = [];
  const total =
    snapshot.fleetTotal >= 1
      ? `$${snapshot.fleetTotal.toFixed(2)}`
      : `$${snapshot.fleetTotal.toFixed(4)}`;
  const daily =
    snapshot.fleetDailyCost >= 1
      ? `$${snapshot.fleetDailyCost.toFixed(2)}/day`
      : `$${snapshot.fleetDailyCost.toFixed(4)}/day`;
  lines.push(`💰 Fleet cost (${snapshot.windowDays}d): ${total} (${daily})`);

  if (snapshot.fleetEmbeddingCost > 0.001) {
    lines.push(`   Embedding costs: $${snapshot.fleetEmbeddingCost.toFixed(4)}`);
  }

  const sorted = [...snapshot.agents].toSorted((a, b) => b.combinedCost - a.combinedCost);
  for (const agent of sorted) {
    if (agent.combinedCost > 0) {
      lines.push(`  ${formatAgentCostLine(agent)}`);
    }
  }
  return lines;
}

/** Clear caches (for tests). */
export function __clearCaches(): void {
  profileCache.clear();
  fleetCache = null;
}
