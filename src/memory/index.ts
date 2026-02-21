export { MemoryIndexManager } from "./manager.js";
export type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";
export { getMemorySearchManager, type MemorySearchManagerResult } from "./search-manager.js";
export {
  createMemoryAuditEmitter,
  readRecentAuditEvents,
  type MemoryAuditEvent,
  type MemoryAuditOp,
} from "./audit-log.js";
export {
  resolveSourceTrust,
  applyTrustToResults,
  type SourceTrustConfig,
  DEFAULT_SOURCE_TRUST,
} from "./trust-scoring.js";
export {
  createEmbeddingCostEmitter,
  readEmbeddingCostSummary,
  estimateEmbeddingCost,
  estimateTokensFromTexts,
  type EmbeddingCostEntry,
  type EmbeddingCostSummary,
  type EmbeddingCostEmitter,
} from "./embedding-cost-tracker.js";
export {
  publishSharedMemory,
  searchSharedMemory,
  supersedeSharedMemory,
  listPublishedMemories,
  getSharedMemoryStats,
  type SharedMemoryEntry,
  type SharedMemorySearchResult,
  type SharedMemoryConfig,
  DEFAULT_SHARED_MEMORY_CONFIG,
} from "./cross-agent-memory.js";
export {
  processSessionForEpisode,
  searchEpisodes,
  getRecentEpisodes,
  getEpisodeStats,
  type Episode,
  type EpisodeSearchResult,
  type EpisodeConfig,
  DEFAULT_EPISODE_CONFIG,
} from "./episode-tracker.js";
export {
  extractFactsFromSession,
  extractAndProcessFacts,
  readRecentFacts,
  logExtractedFacts,
  type ExtractedFact,
  type FactType,
  type FactExtractionConfig,
  DEFAULT_FACT_EXTRACTION_CONFIG,
} from "./fact-extractor.js";
