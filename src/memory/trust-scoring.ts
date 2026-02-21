/**
 * Source trust scoring for memory search results.
 *
 * Trust multipliers weight memory sources by reliability:
 * - Curated memory files (MEMORY.md, topic files) get highest trust
 * - Dated daily memory notes get standard trust
 * - Session transcripts get lower trust (raw conversation, may contain errors)
 * - Extra paths (vault, shared) get configurable trust
 *
 * Trust scores are stored per-chunk at index time and applied during search scoring.
 */

export type SourceTrustConfig = {
  /** Trust multiplier for curated memory files (MEMORY.md, topics). Default: 1.0 */
  memory: number;
  /** Trust multiplier for session transcript chunks. Default: 0.8 */
  sessions: number;
  /** Trust multiplier for extra paths (vault imports, shared docs). Default: 0.9 */
  extra: number;
};

export const DEFAULT_SOURCE_TRUST: SourceTrustConfig = {
  memory: 1.0,
  sessions: 0.8,
  extra: 0.9,
};

/**
 * Resolve the trust multiplier for a given source and file path.
 *
 * @param source - The memory source type ("memory" | "sessions")
 * @param filePath - The file path (used to distinguish curated vs extra)
 * @param config - Trust configuration (optional, uses defaults)
 * @returns Trust multiplier in range (0, 1]
 */
export function resolveSourceTrust(
  source: string,
  filePath: string,
  config: Partial<SourceTrustConfig> = {},
): number {
  const trust = { ...DEFAULT_SOURCE_TRUST, ...config };

  if (source === "sessions") {
    return clampTrust(trust.sessions);
  }

  if (source === "memory") {
    // Check if this is from an extra path (vault import, shared docs)
    // Extra paths typically don't start with "memory/" or "MEMORY.md"
    const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const isCorePath =
      normalized === "MEMORY.md" || normalized === "memory.md" || normalized.startsWith("memory/");

    if (isCorePath) {
      return clampTrust(trust.memory);
    }

    // Non-core memory paths are "extra" (vault imports, shared docs)
    return clampTrust(trust.extra);
  }

  // Unknown source — neutral trust
  return 1.0;
}

/**
 * Apply trust scoring to search results as a post-processing step.
 * This is used when trust wasn't baked into the index (e.g., FTS-only results).
 */
export function applyTrustToResults<T extends { score: number; source: string; path: string }>(
  results: T[],
  config: Partial<SourceTrustConfig> = {},
): T[] {
  return results.map((result) => ({
    ...result,
    score: result.score * resolveSourceTrust(result.source, result.path, config),
  }));
}

function clampTrust(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.1; // minimum non-zero trust
  }
  return Math.min(1.0, value);
}
