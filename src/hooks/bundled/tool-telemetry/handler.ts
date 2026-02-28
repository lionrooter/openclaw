/**
 * Tool Telemetry Hook — persist tool-call stats on session end
 *
 * Reads SessionState.toolCallHistory from the outgoing session and writes
 * a summary JSONL record to ~/.openclaw/telemetry/tool-calls.jsonl.
 *
 * This data powers action-space optimization: which tools does each agent
 * actually use, how often, and what patterns repeat?
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import type { ToolCallRecord } from "../../../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/tool-telemetry");

/**
 * Compute per-tool frequency breakdown from raw tool call history.
 */
function computeToolBreakdown(history: ToolCallRecord[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const call of history) {
    breakdown[call.toolName] = (breakdown[call.toolName] ?? 0) + 1;
  }
  return breakdown;
}

/**
 * Persist tool-call telemetry on session reset/new
 */
const persistToolTelemetry: HookHandler = async (event) => {
  // Only trigger on reset/new commands (session end)
  const isSessionEnd = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isSessionEnd) {
    return;
  }

  try {
    const context = event.context || {};

    // Get session entry (prefer previous session — the one being closed)
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const toolCallHistory = (sessionEntry.toolCallHistory ?? []) as ToolCallRecord[];

    // Skip if no tool calls were recorded
    if (toolCallHistory.length === 0) {
      log.debug("No tool call history in session, skipping telemetry");
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const sessionId = (sessionEntry.sessionId as string) || "unknown";

    // Compute stats
    const tools = computeToolBreakdown(toolCallHistory);
    const uniquePatterns = new Set(toolCallHistory.map((c) => c.argsHash)).size;

    // Find most frequent tool
    let mostFrequent: { toolName: string; count: number } | null = null;
    for (const [toolName, count] of Object.entries(tools)) {
      if (!mostFrequent || count > mostFrequent.count) {
        mostFrequent = { toolName, count };
      }
    }

    const record = {
      timestamp: event.timestamp.toISOString(),
      agentId,
      sessionKey: event.sessionKey,
      sessionId,
      totalCalls: toolCallHistory.length,
      uniquePatterns,
      tools,
      mostFrequent,
    };

    // Write to telemetry directory
    const stateDir = resolveStateDir(process.env, os.homedir);
    const telemetryDir = path.join(stateDir, "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    const logFile = path.join(telemetryDir, "tool-calls.jsonl");
    await fs.appendFile(logFile, JSON.stringify(record) + "\n", "utf-8");

    log.info(
      `Tool telemetry saved: ${agentId} — ${toolCallHistory.length} calls, ${Object.keys(tools).length} unique tools`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to persist tool telemetry: ${message}`);
  }
};

export default persistToolTelemetry;
