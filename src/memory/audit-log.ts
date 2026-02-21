/**
 * Memory mutation audit log.
 *
 * Structured JSONL logging for every memory mutation (index, supersede, delete, reindex).
 * Enables traceability: "what changed in memory, when, and why."
 */

import fs from "node:fs";
import path from "node:path";

export type MemoryAuditOp =
  | "index"
  | "supersede"
  | "delete_stale"
  | "reindex_start"
  | "reindex_complete"
  | "reindex_fail"
  | "cache_prune"
  | "session_prune";

export type MemoryAuditEvent = {
  op: MemoryAuditOp;
  path?: string;
  source?: string;
  supersededCount?: number;
  newCount?: number;
  version?: number;
  deletedPaths?: string[];
  prunedEntries?: number;
  reason?: string;
  error?: string;
  timestamp: number;
};

export type AuditEventEmitter = (event: MemoryAuditEvent) => void;

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — rotate after this
const MAX_ROTATIONS = 3;

/**
 * Creates an audit event emitter that writes structured JSONL to disk.
 *
 * @param auditDir - Directory to write audit logs (e.g., ~/.openclaw/memory/audit/)
 * @param agentId  - Agent identifier for the log file name
 * @returns An emitter function to call for each audit event
 */
export function createMemoryAuditEmitter(auditDir: string, agentId: string): AuditEventEmitter {
  const logFile = path.join(auditDir, `${agentId}-memory-audit.jsonl`);

  // Ensure directory exists
  try {
    fs.mkdirSync(auditDir, { recursive: true });
  } catch {
    // Best-effort — don't crash if we can't create the dir
  }

  return (event: MemoryAuditEvent) => {
    try {
      // Check rotation
      try {
        const stat = fs.statSync(logFile);
        if (stat.size >= MAX_LOG_SIZE_BYTES) {
          rotateLog(logFile);
        }
      } catch {
        // File doesn't exist yet — fine
      }

      const line = JSON.stringify({
        ...event,
        agentId,
        ts: new Date(event.timestamp).toISOString(),
      });
      fs.appendFileSync(logFile, line + "\n", "utf-8");
    } catch {
      // Audit logging is best-effort — never crash the memory system
    }
  };
}

function rotateLog(logFile: string): void {
  // Shift existing rotations: .2 → .3, .1 → .2, current → .1
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
    // If rename fails, truncate instead
    try {
      fs.writeFileSync(logFile, "", "utf-8");
    } catch {
      // Best-effort
    }
  }
}

/**
 * Read recent audit events from the log file.
 * Useful for debugging and monitoring.
 */
export function readRecentAuditEvents(
  auditDir: string,
  agentId: string,
  limit = 50,
): MemoryAuditEvent[] {
  const logFile = path.join(auditDir, `${agentId}-memory-audit.jsonl`);
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const recent = lines.slice(-limit);
    return recent
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryAuditEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is MemoryAuditEvent => event !== null);
  } catch {
    return [];
  }
}
