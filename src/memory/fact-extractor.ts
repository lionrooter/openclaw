/**
 * Incremental learning — fact extraction from conversations.
 *
 * Extracts structured facts, preferences, corrections, and decisions from
 * session transcripts. These learned facts are:
 * 1. Published to the cross-agent shared memory pool (for broad visibility)
 * 2. Optionally appended to the agent's MEMORY.md (for curated persistence)
 *
 * This implements piece #29 (Incremental Learning) of the 31-piece memory
 * framework, upgrading from 0.5 (session transcript indexing only) to 1.0
 * (fact extraction + knowledge distillation + cross-agent propagation).
 *
 * The extraction is pattern-based (no LLM calls) to keep costs at zero and
 * latency minimal. It runs during session sync as a post-processing step.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { publishSharedMemory, type SharedMemoryConfig } from "./cross-agent-memory.js";

const log = createSubsystemLogger("memory/learning");

// ─── Types ───────────────────────────────────────────────────────────────────

export type FactType =
  | "decision" // A decision was made: "decided to use PostgreSQL"
  | "preference" // A preference was stated: "user prefers tabs over spaces"
  | "correction" // An error was corrected: "actually it's TypeScript, not JavaScript"
  | "learning" // A new fact was learned: "the API rate limit is 100/min"
  | "tool_usage" // A tool/command was used successfully: "used qmd query for search"
  | "architecture" // An architectural decision: "using event-driven architecture"
  | "relationship" // A relationship between entities: "Cody handles code reviews"
  | "workflow"; // A workflow/process was established: "deploy to staging first"

export type ExtractedFact = {
  /** Unique fact ID */
  id: string;
  /** What type of fact this is */
  type: FactType;
  /** The extracted fact text */
  fact: string;
  /** Confidence in the extraction (0-1) */
  confidence: number;
  /** The source line(s) that generated this fact */
  sourceText: string;
  /** Tags for categorization */
  tags: string[];
  /** Whether this should be shared with other agents */
  shareWorthy: boolean;
  /** Whether this should be appended to MEMORY.md */
  memoryWorthy: boolean;
  /** Loop ID that this fact was extracted during (for cross-system tracing) */
  loopId?: string;
};

export type FactExtractionConfig = {
  /** Enable fact extraction. Default: true */
  enabled: boolean;
  /** Minimum confidence threshold for extracted facts. Default: 0.6 */
  minConfidence: number;
  /** Whether to publish share-worthy facts to cross-agent pool. Default: true */
  publishToShared: boolean;
  /** Whether to append memory-worthy facts to MEMORY.md. Default: false (manual review) */
  appendToMemory: boolean;
  /** Max facts to extract per session. Default: 10 */
  maxFactsPerSession: number;
  /** Max length of fact text. Default: 200 */
  maxFactLength: number;
};

export const DEFAULT_FACT_EXTRACTION_CONFIG: FactExtractionConfig = {
  enabled: true,
  minConfidence: 0.6,
  publishToShared: true,
  appendToMemory: false, // Conservative default: don't auto-modify memory files
  maxFactsPerSession: 10,
  maxFactLength: 200,
};

// ─── Extraction Patterns ─────────────────────────────────────────────────────

type ExtractionRule = {
  type: FactType;
  pattern: RegExp;
  /** Base confidence for matches (adjusted by pattern specificity) */
  confidence: number;
  /** Which capture group contains the fact text (0 = full match) */
  captureGroup: number;
  /** Tags to auto-apply */
  tags: string[];
  /** Whether this type of fact should be shared across agents */
  shareWorthy: boolean;
  /** Whether this type of fact should be appended to MEMORY.md */
  memoryWorthy: boolean;
};

const EXTRACTION_RULES: ExtractionRule[] = [
  // ─── Decisions ───────────────────────────────────────────────────────
  {
    type: "decision",
    pattern:
      /(?:decided|decision|we'll go with|going with|chose|choosing)\s+(?:to\s+)?(.{10,200}?)(?:\.|$)/i,
    confidence: 0.85,
    captureGroup: 1,
    tags: ["decision"],
    shareWorthy: true,
    memoryWorthy: true,
  },
  {
    type: "decision",
    pattern: /(?:the plan is|plan:)\s+(.{10,200}?)(?:\.|$)/i,
    confidence: 0.8,
    captureGroup: 1,
    tags: ["decision", "planning"],
    shareWorthy: true,
    memoryWorthy: true,
  },

  // ─── Preferences ─────────────────────────────────────────────────────
  {
    type: "preference",
    pattern: /(?:prefer|prefers|preference|rather|instead of)\s+(.{5,150}?)(?:\.|$)/i,
    confidence: 0.75,
    captureGroup: 1,
    tags: ["preference"],
    shareWorthy: false,
    memoryWorthy: true,
  },
  {
    type: "preference",
    pattern: /(?:always|never|don't|do not)\s+(.{5,100}?)(?:\.|$)/i,
    confidence: 0.65,
    captureGroup: 1,
    tags: ["preference", "rule"],
    shareWorthy: false,
    memoryWorthy: true,
  },

  // ─── Corrections ──────────────────────────────────────────────────────
  {
    type: "correction",
    pattern:
      /(?:actually|correction|mistake|wrong|incorrect|not .{2,20} but|should be)\s+(.{5,200}?)(?:\.|$)/i,
    confidence: 0.8,
    captureGroup: 1,
    tags: ["correction"],
    shareWorthy: true,
    memoryWorthy: true,
  },

  // ─── Learnings ────────────────────────────────────────────────────────
  {
    type: "learning",
    pattern:
      /(?:learned|discovered|found out|turns out|TIL|note to self)\s+(?:that\s+)?(.{10,200}?)(?:\.|$)/i,
    confidence: 0.8,
    captureGroup: 1,
    tags: ["learning"],
    shareWorthy: true,
    memoryWorthy: true,
  },
  {
    type: "learning",
    pattern:
      /(?:the (?:api|rate|limit|key|url|endpoint|password|token|secret|port) (?:is|was|=|:))\s+(.{3,100}?)(?:\.|$)/i,
    confidence: 0.7,
    captureGroup: 0,
    tags: ["learning", "config"],
    shareWorthy: false, // may contain sensitive info
    memoryWorthy: false,
  },

  // ─── Architecture ─────────────────────────────────────────────────────
  {
    type: "architecture",
    pattern:
      /(?:architecture|pattern|approach|strategy|design)\s+(?:is|uses|will use|should use)\s+(.{10,200}?)(?:\.|$)/i,
    confidence: 0.8,
    captureGroup: 0,
    tags: ["architecture"],
    shareWorthy: true,
    memoryWorthy: true,
  },
  {
    type: "architecture",
    pattern:
      /(?:using|use|implement|switch to)\s+(?:a\s+)?(.{5,100}?)\s+(?:pattern|architecture|approach|strategy|design)/i,
    confidence: 0.75,
    captureGroup: 0,
    tags: ["architecture"],
    shareWorthy: true,
    memoryWorthy: true,
  },

  // ─── Agent Relationships ──────────────────────────────────────────────
  {
    type: "relationship",
    pattern:
      /(?:(\w+)\s+(?:handles|manages|owns|is responsible for|works on|covers))\s+(.{5,100}?)(?:\.|$)/i,
    confidence: 0.7,
    captureGroup: 0,
    tags: ["relationship", "agent-role"],
    shareWorthy: true,
    memoryWorthy: false,
  },

  // ─── Workflows ────────────────────────────────────────────────────────
  {
    type: "workflow",
    pattern: /(?:workflow|process|procedure|steps?|pipeline)\s*(?:is|:)\s+(.{10,200}?)(?:\.|$)/i,
    confidence: 0.75,
    captureGroup: 0,
    tags: ["workflow"],
    shareWorthy: true,
    memoryWorthy: true,
  },
  {
    type: "workflow",
    pattern:
      /(?:first|then|next|finally|after that)\s+(?:we\s+)?(.{10,150}?)(?:,\s+(?:then|next|and)|\.)/i,
    confidence: 0.6,
    captureGroup: 0,
    tags: ["workflow", "steps"],
    shareWorthy: false,
    memoryWorthy: false,
  },
];

// ─── Main Extraction Function ────────────────────────────────────────────────

/**
 * Extract facts from session transcript content.
 *
 * @param params.agentId        - The agent this session belongs to
 * @param params.sessionContent - Processed session text ("User: .." / "Assistant: ..")
 * @param params.sessionFile    - Source session file path (for context)
 * @param params.config         - Extraction configuration
 * @returns Array of extracted facts
 */
export function extractFactsFromSession(params: {
  agentId: string;
  sessionContent: string;
  sessionFile: string;
  config?: Partial<FactExtractionConfig>;
}): ExtractedFact[] {
  const config = { ...DEFAULT_FACT_EXTRACTION_CONFIG, ...params.config };
  if (!config.enabled) {
    return [];
  }

  const lines = params.sessionContent.split("\n").filter((l) => l.trim().length > 0);
  const facts: ExtractedFact[] = [];
  const seenFacts = new Set<string>(); // dedup by normalized fact text

  for (const line of lines) {
    // Only extract from assistant messages (they contain the conclusions/decisions)
    // and user messages (they contain preferences/corrections)
    const cleanLine = line.replace(/^(?:User|Assistant):\s*/, "").trim();
    if (cleanLine.length < 10) {
      continue;
    }

    for (const rule of EXTRACTION_RULES) {
      const match = rule.pattern.exec(cleanLine);
      if (!match) {
        continue;
      }

      const rawFact =
        rule.captureGroup > 0
          ? (match[rule.captureGroup]?.trim() ?? match[0].trim())
          : match[0].trim();

      if (!rawFact || rawFact.length < 5) {
        continue;
      }

      // Normalize and dedup
      const normalized = rawFact.toLowerCase().replace(/\s+/g, " ").trim();
      if (seenFacts.has(normalized)) {
        continue;
      }
      seenFacts.add(normalized);

      // Skip if below confidence threshold
      if (rule.confidence < config.minConfidence) {
        continue;
      }

      // Truncate to max length
      const fact =
        rawFact.length > config.maxFactLength
          ? rawFact.slice(0, config.maxFactLength - 3) + "..."
          : rawFact;

      facts.push({
        id: generateFactId(),
        type: rule.type,
        fact,
        confidence: rule.confidence,
        sourceText: cleanLine.slice(0, 300),
        tags: [...rule.tags],
        shareWorthy: rule.shareWorthy,
        memoryWorthy: rule.memoryWorthy,
      });

      if (facts.length >= config.maxFactsPerSession) {
        break;
      }
    }

    if (facts.length >= config.maxFactsPerSession) {
      break;
    }
  }

  return facts;
}

/**
 * Process extracted facts: publish to shared memory and/or append to MEMORY.md.
 *
 * This is the main integration point called from the session sync pipeline.
 *
 * @param params.agentId      - The publishing agent
 * @param params.facts        - Facts extracted from extractFactsFromSession()
 * @param params.workspaceDir - Agent's workspace directory (for MEMORY.md path)
 * @param params.sessionFile  - Source session file (for context)
 * @param params.config       - Configuration
 * @param params.sharedConfig - Cross-agent shared memory configuration
 */
export function processFacts(params: {
  agentId: string;
  facts: ExtractedFact[];
  workspaceDir: string;
  sessionFile: string;
  config?: Partial<FactExtractionConfig>;
  sharedConfig?: Partial<SharedMemoryConfig>;
}): { published: number; appended: number } {
  const config = { ...DEFAULT_FACT_EXTRACTION_CONFIG, ...params.config };
  let published = 0;
  let appended = 0;

  for (const fact of params.facts) {
    // Publish to cross-agent shared memory
    if (config.publishToShared && fact.shareWorthy) {
      try {
        publishSharedMemory({
          agentId: params.agentId,
          fact: `[${fact.type}] ${fact.fact}`,
          tags: fact.tags,
          confidence: fact.confidence,
          sourceContext: `Extracted from session: ${path.basename(params.sessionFile)}`,
          config: params.sharedConfig,
        });
        published++;
      } catch (err) {
        log.warn(`Failed to publish shared fact: ${String(err)}`);
      }
    }

    // Append to MEMORY.md
    if (config.appendToMemory && fact.memoryWorthy) {
      try {
        appendToMemoryFile(params.workspaceDir, fact);
        appended++;
      } catch (err) {
        log.warn(`Failed to append fact to MEMORY.md: ${String(err)}`);
      }
    }
  }

  return { published, appended };
}

/**
 * Full pipeline: extract facts from session content and process them.
 *
 * Entry point called from session sync in manager-sync-ops.ts.
 */
export function extractAndProcessFacts(params: {
  agentId: string;
  sessionContent: string;
  sessionFile: string;
  workspaceDir: string;
  config?: Partial<FactExtractionConfig>;
  sharedConfig?: Partial<SharedMemoryConfig>;
  loopId?: string;
}): { extracted: number; published: number; appended: number } {
  try {
    const facts = extractFactsFromSession({
      agentId: params.agentId,
      sessionContent: params.sessionContent,
      sessionFile: params.sessionFile,
      config: params.config,
    });

    // Attach loop ID to all extracted facts for cross-system tracing
    if (params.loopId) {
      for (const fact of facts) {
        fact.loopId = params.loopId;
      }
    }

    if (facts.length === 0) {
      return { extracted: 0, published: 0, appended: 0 };
    }

    const result = processFacts({
      agentId: params.agentId,
      facts,
      workspaceDir: params.workspaceDir,
      sessionFile: params.sessionFile,
      config: params.config,
      sharedConfig: params.sharedConfig,
    });

    // Persist extracted facts to the review log so they're visible
    // via memory.facts.recent gateway endpoint and readRecentFacts()
    logExtractedFacts(params.agentId, facts);

    log.debug(`Extracted ${facts.length} facts from session`, {
      agentId: params.agentId,
      extracted: facts.length,
      published: result.published,
      appended: result.appended,
      types: facts.map((f) => f.type),
    });

    return { extracted: facts.length, ...result };
  } catch (err) {
    log.warn(`Fact extraction failed: ${String(err)}`);
    return { extracted: 0, published: 0, appended: 0 };
  }
}

// ─── MEMORY.md Append ────────────────────────────────────────────────────────

/**
 * Append a fact to the agent's MEMORY.md file.
 *
 * Facts are appended under a "## Learned Facts" section at the end of the file.
 * Each fact includes its type, confidence, and extraction date.
 */
function appendToMemoryFile(workspaceDir: string, fact: ExtractedFact): void {
  const memoryFile = path.join(workspaceDir, "MEMORY.md");

  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const factLine = `- **[${fact.type}]** ${fact.fact} _(confidence: ${(fact.confidence * 100).toFixed(0)}%, ${date})_\n`;

  try {
    let content = "";
    try {
      content = fs.readFileSync(memoryFile, "utf-8");
    } catch {
      // File doesn't exist — will create
    }

    const sectionHeader = "## Learned Facts\n";
    if (content.includes(sectionHeader)) {
      // Append under existing section
      const sectionIndex = content.indexOf(sectionHeader);
      const afterHeader = sectionIndex + sectionHeader.length;
      // Find the next section header or end of file
      const nextSection = content.indexOf("\n## ", afterHeader);
      const insertAt = nextSection >= 0 ? nextSection : content.length;
      content = content.slice(0, insertAt) + factLine + content.slice(insertAt);
    } else {
      // Add new section at end
      content = content.trimEnd() + "\n\n" + sectionHeader + "\n" + factLine;
    }

    fs.writeFileSync(memoryFile, content, "utf-8");
  } catch {
    // Best-effort — don't crash if we can't write MEMORY.md
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateFactId(): string {
  return `fact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Fact Log (persisted for review) ─────────────────────────────────────────

const FACTS_DIR = ".openclaw/memory/facts";

function resolveFactsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, FACTS_DIR);
}

function resolveFactFile(agentId: string): string {
  return path.join(resolveFactsDir(), `${agentId}-extracted-facts.jsonl`);
}

/**
 * Persist extracted facts to a review log.
 * This allows the user to review what was extracted and adjust extraction rules.
 */
export function logExtractedFacts(agentId: string, facts: ExtractedFact[]): void {
  if (facts.length === 0) {
    return;
  }

  const factsDir = resolveFactsDir();
  try {
    fs.mkdirSync(factsDir, { recursive: true });
  } catch {
    // Best-effort
  }

  const logFile = resolveFactFile(agentId);
  try {
    const lines = facts
      .map((f) =>
        JSON.stringify({
          ...f,
          timestamp: Date.now(),
          agentId,
        }),
      )
      .join("\n");
    fs.appendFileSync(logFile, lines + "\n", "utf-8");
  } catch {
    // Best-effort
  }
}

/**
 * Read recently extracted facts for review.
 */
export function readRecentFacts(agentId: string, limit = 50): ExtractedFact[] {
  const logFile = resolveFactFile(agentId);
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as ExtractedFact;
        } catch {
          return null;
        }
      })
      .filter((f): f is ExtractedFact => f !== null);
  } catch {
    return [];
  }
}
