/**
 * Budget gates — operational guardrails for agent work dispatch.
 *
 * Two independent gates:
 * 1. **Provider usage gate** — checks real-time API provider utilization
 *    (via the provider-usage system: Claude, Codex, Gemini, etc.)
 * 2. **Daily spend gate** — checks cumulative session costs against a ceiling
 *
 * Gates return a decision: proceed, defer, or warn. They never hard-block
 * unless `BUDGET_ENFORCEMENT=strict` is set.
 *
 * Work categories determine gate thresholds:
 * - "mission"       → proceeds up to 95% provider usage
 * - "maintenance"   → defers above 80% provider usage
 * - "self-improve"  → defers above 60% provider usage
 * - "heartbeat"     → treated like maintenance (80%)
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import type { UsageSummary } from "./provider-usage.types.js";
import { loadCostUsageSummary } from "./session-cost-usage.js";

const log = createSubsystemLogger("budget/gates");

// ─── Types ───────────────────────────────────────────────────────────────────

export type WorkCategory = "mission" | "maintenance" | "self-improve" | "heartbeat";

export type BudgetGateDecision = {
  /** Whether the work should proceed */
  proceed: boolean;
  /** Reason for deferral (if proceed is false) */
  reason?: string;
  /** Warning message (even if proceed is true) */
  warning?: string;
  /** Which gate triggered the decision */
  gate: "provider-usage" | "daily-spend" | "none";
  /** Details for logging */
  details?: {
    provider?: string;
    usedPercent?: number;
    threshold?: number;
    dailySpend?: number;
    dailyCeiling?: number;
  };
};

export type BudgetGateConfig = {
  /** Per-category provider usage thresholds (percent). Default: mission=95, maintenance=80, self-improve=60 */
  providerThresholds: Record<WorkCategory, number>;
  /** Daily spend ceiling in USD. Default: from DAILY_SPEND_CEILING env var, or Infinity */
  dailySpendCeiling: number;
  /** Enforcement mode. "soft" = warn only, "strict" = defer. Default: "soft" */
  enforcement: "soft" | "strict";
  /** Whether to enable budget gates at all. Default: true */
  enabled: boolean;
};

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER_THRESHOLDS: Record<WorkCategory, number> = {
  mission: 95,
  maintenance: 80,
  "self-improve": 60,
  heartbeat: 80,
};

function resolveBudgetGateConfig(): BudgetGateConfig {
  const envCeiling = process.env.DAILY_SPEND_CEILING;
  const envEnforcement = process.env.BUDGET_ENFORCEMENT;

  return {
    providerThresholds: { ...DEFAULT_PROVIDER_THRESHOLDS },
    dailySpendCeiling: envCeiling ? Number(envCeiling) : Infinity,
    enforcement: envEnforcement === "strict" ? "strict" : "soft",
    enabled: process.env.BUDGET_GATES_DISABLED !== "1",
  };
}

// ─── Provider Usage Gate ─────────────────────────────────────────────────────

/**
 * Check if any provider's usage exceeds the threshold for the given work category.
 *
 * Uses the highest `usedPercent` window across all providers as the gating value.
 * This is conservative: if Claude is at 90% but Codex is at 20%, we report 90%.
 */
function checkProviderUsageGate(params: {
  summary: UsageSummary;
  category: WorkCategory;
  config: BudgetGateConfig;
}): BudgetGateDecision {
  const { summary, category, config } = params;
  const threshold = config.providerThresholds[category];

  // Find the highest usage across all providers
  let worstProvider = "";
  let worstPercent = 0;

  for (const provider of summary.providers) {
    if (provider.error || provider.windows.length === 0) {
      continue;
    }
    for (const window of provider.windows) {
      if (window.usedPercent > worstPercent) {
        worstPercent = window.usedPercent;
        worstProvider = provider.displayName;
      }
    }
  }

  if (worstPercent <= 0) {
    return { proceed: true, gate: "none" };
  }

  const details = {
    provider: worstProvider,
    usedPercent: worstPercent,
    threshold,
  };

  if (worstPercent >= threshold) {
    const reason = `Provider ${worstProvider} at ${worstPercent.toFixed(1)}% (threshold: ${threshold}% for ${category})`;

    if (config.enforcement === "strict") {
      log.info(`budget gate: DEFER ${category} — ${reason}`);
      return {
        proceed: false,
        reason,
        gate: "provider-usage",
        details,
      };
    }

    // Soft enforcement: warn but proceed
    log.info(`budget gate: WARN ${category} — ${reason}`);
    return {
      proceed: true,
      warning: reason,
      gate: "provider-usage",
      details,
    };
  }

  // Under threshold — check if close (within 10 percentage points) and add warning
  if (worstPercent >= threshold - 10) {
    return {
      proceed: true,
      warning: `Provider ${worstProvider} approaching limit: ${worstPercent.toFixed(1)}% (threshold: ${threshold}%)`,
      gate: "provider-usage",
      details,
    };
  }

  return { proceed: true, gate: "none", details };
}

// ─── Daily Spend Gate ────────────────────────────────────────────────────────

/**
 * Check if cumulative daily spend has exceeded the ceiling.
 */
async function checkDailySpendGate(params: {
  config: BudgetGateConfig;
  agentId?: string;
  openClawConfig?: OpenClawConfig;
}): Promise<BudgetGateDecision> {
  const { config, agentId, openClawConfig } = params;

  if (!Number.isFinite(config.dailySpendCeiling) || config.dailySpendCeiling <= 0) {
    return { proceed: true, gate: "none" };
  }

  const now = Date.now();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  let dailySpend = 0;
  try {
    const summary = await loadCostUsageSummary({
      startMs: todayStart.getTime(),
      endMs: now,
      config: openClawConfig,
      agentId,
    });
    dailySpend = summary.totals.totalCost;
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`budget gate: failed to load daily cost: ${reason}`);
    return { proceed: true, gate: "none" };
  }

  const details = {
    dailySpend,
    dailyCeiling: config.dailySpendCeiling,
  };

  if (dailySpend >= config.dailySpendCeiling) {
    const reason = `Daily spend $${dailySpend.toFixed(2)} exceeds ceiling $${config.dailySpendCeiling.toFixed(2)}`;

    if (config.enforcement === "strict") {
      log.info(`budget gate: DEFER — ${reason}`);
      return { proceed: false, reason, gate: "daily-spend", details };
    }

    log.info(`budget gate: WARN — ${reason}`);
    return { proceed: true, warning: reason, gate: "daily-spend", details };
  }

  // Approaching ceiling (within 80%)
  if (dailySpend >= config.dailySpendCeiling * 0.8) {
    return {
      proceed: true,
      warning: `Daily spend $${dailySpend.toFixed(2)} approaching ceiling $${config.dailySpendCeiling.toFixed(2)} (${((dailySpend / config.dailySpendCeiling) * 100).toFixed(0)}%)`,
      gate: "daily-spend",
      details,
    };
  }

  return { proceed: true, gate: "none", details };
}

// ─── Combined Gate ───────────────────────────────────────────────────────────

/**
 * Run all budget gates for a given work category.
 *
 * Returns the most restrictive decision. If any gate says "defer",
 * the combined result is "defer". Warnings are aggregated.
 *
 * @param category  - Type of work being dispatched
 * @param agentId   - Agent performing the work (for per-agent spend tracking)
 * @param config    - Optional OpenClaw config
 * @param usageSummary - Optional pre-loaded provider usage (to avoid redundant API calls)
 */
export async function checkBudgetGates(params: {
  category: WorkCategory;
  agentId?: string;
  config?: OpenClawConfig;
  usageSummary?: UsageSummary;
}): Promise<BudgetGateDecision> {
  const { category, agentId, config } = params;
  const gateConfig = resolveBudgetGateConfig();

  if (!gateConfig.enabled) {
    return { proceed: true, gate: "none" };
  }

  // 1. Provider usage gate
  let providerDecision: BudgetGateDecision = { proceed: true, gate: "none" };
  try {
    const summary = params.usageSummary ?? (await loadProviderUsageSummary({ timeoutMs: 3000 }));

    providerDecision = checkProviderUsageGate({
      summary,
      category,
      config: gateConfig,
    });
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`budget gate: failed to load provider usage: ${reason}`);
    // Don't block on provider check failure
  }

  // 2. Daily spend gate
  const spendDecision = await checkDailySpendGate({
    config: gateConfig,
    agentId,
    openClawConfig: config,
  });

  // Combine decisions — most restrictive wins
  if (!providerDecision.proceed) {
    return providerDecision;
  }
  if (!spendDecision.proceed) {
    return spendDecision;
  }

  // Both proceed — aggregate warnings
  const warnings = [providerDecision.warning, spendDecision.warning].filter(Boolean);
  if (warnings.length > 0) {
    const gate = providerDecision.warning ? providerDecision.gate : spendDecision.gate;
    const details = providerDecision.warning ? providerDecision.details : spendDecision.details;
    return {
      proceed: true,
      warning: warnings.join(" | "),
      gate,
      details,
    };
  }

  return { proceed: true, gate: "none" };
}

/**
 * Quick budget check for heartbeat dispatch — returns true if work should proceed.
 * This is the simplified API for the heartbeat runner.
 */
export async function shouldProceedWithHeartbeat(params: {
  agentId: string;
  config?: OpenClawConfig;
  usageSummary?: UsageSummary;
}): Promise<{ proceed: boolean; reason?: string }> {
  const decision = await checkBudgetGates({
    category: "heartbeat",
    agentId: params.agentId,
    config: params.config,
    usageSummary: params.usageSummary,
  });

  if (!decision.proceed) {
    return { proceed: false, reason: decision.reason };
  }

  if (decision.warning) {
    log.info(`heartbeat budget warning for ${params.agentId}: ${decision.warning}`);
  }

  return { proceed: true };
}

/** Exported for testing */
export const __test = {
  resolveBudgetGateConfig,
  checkProviderUsageGate,
  checkDailySpendGate,
  DEFAULT_PROVIDER_THRESHOLDS,
};
