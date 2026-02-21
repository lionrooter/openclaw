import type { DatabaseSync } from "node:sqlite";
import type { AuditEventEmitter } from "./audit-log.js";

export function deleteStaleIndexedPaths(params: {
  db: DatabaseSync;
  source: string;
  activePaths: Set<string>;
  vectorTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsAvailable: boolean;
  model: string;
  emitAuditEvent?: AuditEventEmitter;
}) {
  const staleRows = params.db
    .prepare(`SELECT path FROM files WHERE source = ?`)
    .all(params.source) as Array<{ path: string }>;

  const deletedPaths: string[] = [];

  for (const stale of staleRows) {
    if (params.activePaths.has(stale.path)) {
      continue;
    }
    deletedPaths.push(stale.path);

    // Mark chunks as superseded (stale file removed) instead of hard-deleting
    // We keep the chunk rows for audit history but remove from search indexes
    const now = Date.now();
    params.db
      .prepare(
        `UPDATE chunks SET superseded_by = 'file_removed', superseded_at = ? WHERE path = ? AND source = ? AND superseded_by IS NULL`,
      )
      .run(now, stale.path, params.source);

    // Remove from vector and FTS indexes (superseded chunks shouldn't be searchable)
    try {
      params.db
        .prepare(
          `DELETE FROM ${params.vectorTable} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(stale.path, params.source);
    } catch {}
    if (params.ftsEnabled && params.ftsAvailable) {
      try {
        params.db
          .prepare(`DELETE FROM ${params.ftsTable} WHERE path = ? AND source = ? AND model = ?`)
          .run(stale.path, params.source, params.model);
      } catch {}
    }

    // Remove the file entry (the file itself is gone)
    params.db
      .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
      .run(stale.path, params.source);
  }

  if (deletedPaths.length > 0) {
    params.emitAuditEvent?.({
      op: "delete_stale",
      source: params.source,
      deletedPaths,
      timestamp: Date.now(),
    });
  }
}
