/**
 * Budget gateway handlers.
 *
 * Provides budget status, cost attribution, and gate check endpoints.
 */

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { checkBudgetGates, type WorkCategory } from "../../infra/budget-gates.js";
import {
  loadAgentCostProfile,
  loadFleetCostSnapshot,
  formatFleetCostSummary,
} from "../../infra/cost-attribution.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readEmbeddingCostSummary } from "../../memory/embedding-cost-tracker.js";
import type { GatewayRequestHandlers } from "./types.js";

const KNOWN_AGENTS = [
  "clawdy",
  "leo",
  "cody",
  "artie",
  "exdi",
  "grove",
  "liev",
  "nesta",
  "finn",
  "archie",
  "projel",
  "schoolie",
];

function resolveAgentList(config: ReturnType<typeof loadConfig>): string[] {
  const configured = config.agents?.list;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((a: { id?: string }) => a.id || "").filter(Boolean);
  }
  return KNOWN_AGENTS;
}

export const budgetHandlers: GatewayRequestHandlers = {
  /**
   * Get cost attribution for a single agent.
   * Params: { agentId?: string, days?: number }
   */
  "budget.agent": async ({ respond, params }) => {
    const config = loadConfig();
    const agentId = params?.agentId || resolveDefaultAgentId(config);
    const days = typeof params?.days === "number" ? params.days : 7;

    try {
      const profile = await loadAgentCostProfile({ agentId, days, config });
      respond(true, profile, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: -1,
        message: `Failed to load cost profile: ${formatErrorMessage(err)}`,
      });
    }
  },

  /**
   * Get fleet-wide cost snapshot.
   * Params: { days?: number }
   */
  "budget.fleet": async ({ respond, params }) => {
    const config = loadConfig();
    const agentIds = resolveAgentList(config);
    const days = typeof params?.days === "number" ? params.days : 7;

    try {
      const snapshot = await loadFleetCostSnapshot({ agentIds, days, config });
      respond(true, snapshot, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: -1,
        message: `Failed to load fleet cost snapshot: ${formatErrorMessage(err)}`,
      });
    }
  },

  /**
   * Get fleet cost summary as formatted text lines (for agents/chat).
   * Params: { days?: number }
   */
  "budget.fleet.summary": async ({ respond, params }) => {
    const config = loadConfig();
    const agentIds = resolveAgentList(config);
    const days = typeof params?.days === "number" ? params.days : 7;

    try {
      const snapshot = await loadFleetCostSnapshot({ agentIds, days, config });
      const lines = formatFleetCostSummary(snapshot);
      respond(true, { lines, snapshot }, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: -1,
        message: `Failed to load fleet summary: ${formatErrorMessage(err)}`,
      });
    }
  },

  /**
   * Check budget gates for a work category.
   * Params: { category?: WorkCategory, agentId?: string }
   */
  "budget.check": async ({ respond, params }) => {
    const config = loadConfig();
    const category = (params?.category as WorkCategory) || "maintenance";
    const agentId = params?.agentId || resolveDefaultAgentId(config);

    try {
      const decision = await checkBudgetGates({ category, agentId, config });
      respond(true, decision, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: -1,
        message: `Budget check failed: ${formatErrorMessage(err)}`,
      });
    }
  },

  /**
   * Get embedding cost summary for an agent.
   * Params: { agentId?: string, days?: number }
   */
  "budget.embeddings": async ({ respond, params }) => {
    const config = loadConfig();
    const agentId = params?.agentId || resolveDefaultAgentId(config);
    const days = typeof params?.days === "number" ? params.days : 7;

    try {
      const summary = readEmbeddingCostSummary({ agentId, days });
      respond(true, { agentId, days, ...summary }, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: -1,
        message: `Failed to load embedding costs: ${formatErrorMessage(err)}`,
      });
    }
  },
};
