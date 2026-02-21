/**
 * Embedding cost tracker — records per-API-call costs for memory embedding operations.
 *
 * Writes structured JSONL to disk, following the same pattern as the audit log.
 * This data is consumed by cost-attribution.ts to include embedding costs
 * in agent cost profiles.
 *
 * Cost estimation uses the same token-based pricing as the provider
 * usage system — costs are per 1M tokens.
 */

import fs from "node:fs";
import path from "node:path";
// ─── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingCostEntry = {
  /** Embedding provider ID: "openai" | "gemini" | "voyage" | "local" */
  provider: string;
  /** Model name */
  model: string;
  /** Agent this cost is attributed to */
  agentId: string;
  /** Number of texts embedded in this call */
  batchSize: number;
  /** Estimated total tokens (characters / 4 approximation) */
  estimatedTokens: number;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Epoch ms timestamp */
  timestamp: number;
  /** Source: "index" | "query" | "reindex" */
  operation: "index" | "query" | "reindex";
};

export type EmbeddingCostSummary = {
  totalCost: number;
  totalTokens: number;
  callCount: number;
  providers: Record<string, { cost: number; tokens: number; calls: number }>;
};

export type EmbeddingCostEmitter = (entry: Omit<EmbeddingCostEntry, "timestamp">) => void;

// ─── Known embedding costs per 1M tokens ────────────────────────────────────

const EMBEDDING_COSTS_PER_1M: Record<string, number> = {
  // OpenAI
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.1,
  // Gemini
  "text-embedding-004": 0.0, // free tier
  "embedding-001": 0.0,
  // Voyage
  "voyage-3": 0.06,
  "voyage-3-lite": 0.02,
  "voyage-code-3": 0.18,
  // Local models are free
  local: 0.0,
};

/**
 * Estimate the cost of an embedding operation.
 *
 * @param provider - Provider ID
 * @param model    - Model name
 * @param tokens   - Estimated token count
 * @returns Cost in USD
 */
export function estimateEmbeddingCost(params: {
  provider: string;
  model: string;
  tokens: number;
}): number {
  const { provider, model, tokens } = params;

  if (provider === "local") {
    return 0;
  }

  // Look up by model name first, then fall back to a reasonable default
  const modelLower = model.toLowerCase();
  for (const [key, costPerM] of Object.entries(EMBEDDING_COSTS_PER_1M)) {
    if (modelLower.includes(key)) {
      return (tokens / 1_000_000) * costPerM;
    }
  }

  // Unknown model — use a conservative estimate ($0.10/1M)
  return (tokens / 1_000_000) * 0.1;
}

// ─── Cost Log File ───────────────────────────────────────────────────────────

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROTATIONS = 3;
const DEFAULT_COST_DIR = ".openclaw/memory/embedding-costs";

function resolveEmbeddingCostDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, DEFAULT_COST_DIR);
}

function resolveLogFile(agentId: string): string {
  return path.join(resolveEmbeddingCostDir(), `${agentId}-embedding-costs.jsonl`);
}

function rotateLog(logFile: string): void {
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${logFile}.${i}`;
    const to = `${logFile}.${i + 1}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // Missing file is fine
    }
  }
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    try {
      fs.writeFileSync(logFile, "", "utf-8");
    } catch {
      // Best-effort
    }
  }
}

// ─── Emitter ─────────────────────────────────────────────────────────────────

/**
 * Creates an embedding cost emitter that writes structured JSONL to disk.
 *
 * @param agentId - Agent identifier for the log file name
 * @returns An emitter function to call after each embedding operation
 */
export function createEmbeddingCostEmitter(agentId: string): EmbeddingCostEmitter {
  const costDir = resolveEmbeddingCostDir();

  // Ensure directory exists
  try {
    fs.mkdirSync(costDir, { recursive: true });
  } catch {
    // Best-effort
  }

  return (entry) => {
    const full: EmbeddingCostEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    try {
      const logFile = resolveLogFile(agentId);

      // Check rotation
      try {
        const stat = fs.statSync(logFile);
        if (stat.size >= MAX_LOG_SIZE_BYTES) {
          rotateLog(logFile);
        }
      } catch {
        // File doesn't exist yet
      }

      const line = JSON.stringify(full);
      fs.appendFileSync(logFile, line + "\n", "utf-8");
    } catch {
      // Embedding cost tracking is best-effort
    }
  };
}

// ─── Reader ──────────────────────────────────────────────────────────────────

/**
 * Read embedding cost summary for an agent over a time window.
 *
 * @param agentId - Agent to read costs for
 * @param days    - Look-back window (default: 7)
 */
export function readEmbeddingCostSummary(params: {
  agentId: string;
  days?: number;
}): EmbeddingCostSummary {
  const { agentId, days = 7 } = params;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const summary: EmbeddingCostSummary = {
    totalCost: 0,
    totalTokens: 0,
    callCount: 0,
    providers: {},
  };

  const logFile = resolveLogFile(agentId);
  let content: string;
  try {
    content = fs.readFileSync(logFile, "utf-8");
  } catch {
    return summary; // No log file — zero cost
  }

  const lines = content.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as EmbeddingCostEntry;
      if (entry.timestamp < cutoff) {
        continue;
      }
      summary.totalCost += entry.estimatedCost;
      summary.totalTokens += entry.estimatedTokens;
      summary.callCount += 1;

      const provKey = entry.provider;
      if (!summary.providers[provKey]) {
        summary.providers[provKey] = { cost: 0, tokens: 0, calls: 0 };
      }
      summary.providers[provKey].cost += entry.estimatedCost;
      summary.providers[provKey].tokens += entry.estimatedTokens;
      summary.providers[provKey].calls += 1;
    } catch {
      // Skip malformed lines
    }
  }

  return summary;
}

/**
 * Estimate tokens from text content.
 * Uses the standard ~4 characters per token heuristic.
 */
export function estimateTokensFromTexts(texts: string[]): number {
  let totalChars = 0;
  for (const text of texts) {
    totalChars += text.length;
  }
  return Math.ceil(totalChars / 4);
}
