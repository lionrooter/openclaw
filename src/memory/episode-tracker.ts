/**
 * Episode tracker — structured conversation episode model.
 *
 * Episodes are coherent units of conversation (a task, a discussion, a debug session).
 * They're extracted from session transcripts and stored as searchable structured data.
 *
 * An episode captures:
 * - Topic/title: What the conversation was about
 * - Participants: Which agents and users were involved
 * - Time span: When it started and ended
 * - Key decisions: Important choices or conclusions reached
 * - Outcome: How the episode resolved
 * - Links: References to other episodes, memory files, or vault notes
 *
 * This implements piece #21 (Episode Tracking) of the 31-piece memory framework,
 * upgrading from 0.5 (convention-based dates/sessions) to 1.0 (structured episode
 * model with linking, summarization, and search).
 *
 * Episodes are stored as JSONL at ~/.openclaw/memory/episodes/<agentId>-episodes.jsonl
 * and are searchable via the episodeSearch() function.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/episodes");

// ─── Types ───────────────────────────────────────────────────────────────────

export type EpisodeStatus = "active" | "completed" | "abandoned" | "paused";

export type Episode = {
  /** Unique episode ID */
  id: string;
  /** Agent this episode belongs to */
  agentId: string;
  /** Short descriptive title (auto-generated or manual) */
  title: string;
  /** Longer description of the episode's topic/context */
  topic: string;
  /** Who participated (agent IDs, user names, external parties) */
  participants: string[];
  /** Epoch ms — when the episode started */
  startTime: number;
  /** Epoch ms — when the episode ended (0 = still active) */
  endTime: number;
  /** Current status */
  status: EpisodeStatus;
  /** Key decisions or conclusions made during this episode */
  decisions: string[];
  /** The outcome or result of the episode */
  outcome?: string;
  /** IDs of related episodes (e.g., follow-ups, prerequisites) */
  linkedEpisodes: string[];
  /** Paths to related files (memory files, vault notes) */
  linkedFiles: string[];
  /** Tags for categorization */
  tags: string[];
  /** Session transcript file(s) this episode was extracted from */
  sourceSessionFiles: string[];
  /** Number of messages in this episode */
  messageCount: number;
  /** Auto-generated summary of the conversation */
  summary?: string;
  /** Epoch ms — last time this episode was updated */
  updatedAt: number;
  /** Loop ID that this episode was generated during (for cross-system tracing) */
  loopId?: string;
};

export type EpisodeSearchResult = {
  episode: Episode;
  score: number;
};

export type EpisodeConfig = {
  /** Enable episode tracking. Default: true */
  enabled: boolean;
  /** Maximum episodes to keep per agent. Default: 200 */
  maxEpisodesPerAgent: number;
  /** Minimum messages in a session to create an episode. Default: 4 */
  minMessagesForEpisode: number;
  /** Max search results. Default: 10 */
  maxSearchResults: number;
};

export const DEFAULT_EPISODE_CONFIG: EpisodeConfig = {
  enabled: true,
  maxEpisodesPerAgent: 200,
  minMessagesForEpisode: 4,
  maxSearchResults: 10,
};

// ─── File Paths ──────────────────────────────────────────────────────────────

const EPISODES_DIR = ".openclaw/memory/episodes";

function resolveEpisodesDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, EPISODES_DIR);
}

function resolveEpisodeFile(agentId: string): string {
  return path.join(resolveEpisodesDir(), `${agentId}-episodes.jsonl`);
}

// ─── Episode Extraction ──────────────────────────────────────────────────────

/**
 * Extract an episode from session transcript content.
 *
 * Parses the session text (already formatted as "User: ... / Assistant: ...")
 * and extracts structured episode metadata using pattern matching.
 *
 * This runs during session sync as a post-processing step.
 *
 * @param params.agentId        - The agent this session belongs to
 * @param params.sessionFile    - Source session file path
 * @param params.sessionContent - The processed session text (from buildSessionEntry)
 * @param params.config         - Episode configuration
 */
export function extractEpisodeFromSession(params: {
  agentId: string;
  sessionFile: string;
  sessionContent: string;
  config?: Partial<EpisodeConfig>;
}): Episode | null {
  const config = { ...DEFAULT_EPISODE_CONFIG, ...params.config };
  if (!config.enabled) {
    return null;
  }

  const lines = params.sessionContent.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < config.minMessagesForEpisode) {
    return null;
  }

  const now = Date.now();

  // Extract participants
  const participants = new Set<string>([params.agentId]);
  for (const line of lines) {
    if (line.startsWith("User:")) {
      participants.add("user");
    }
  }

  // Extract topic from first user message
  const firstUserMsg = lines.find((l) => l.startsWith("User:"));
  const topic = firstUserMsg
    ? firstUserMsg.replace(/^User:\s*/, "").slice(0, 200)
    : "Untitled conversation";

  // Generate title — use first meaningful user request, truncated
  const title = generateTitle(topic);

  // Extract decisions — look for patterns indicating decisions/conclusions
  const decisions = extractDecisions(lines);

  // Extract outcome — from the last assistant message
  const lastAssistantMsg = [...lines].toReversed().find((l) => l.startsWith("Assistant:"));
  const outcome = lastAssistantMsg
    ? lastAssistantMsg.replace(/^Assistant:\s*/, "").slice(0, 300)
    : undefined;

  // Detect linked files mentioned in the conversation
  const linkedFiles = extractLinkedFiles(lines);

  // Generate tags from conversation content
  const tags = extractTags(lines);

  // Generate summary
  const summary = generateSummary(lines, title, decisions);

  // Estimate time span from session file name (which often includes timestamps)
  const timeInfo = estimateTimeFromSessionFile(params.sessionFile);

  const episode: Episode = {
    id: generateEpisodeId(),
    agentId: params.agentId,
    title,
    topic,
    participants: Array.from(participants),
    startTime: timeInfo?.startTime ?? now,
    endTime: timeInfo?.endTime ?? now,
    status: "completed",
    decisions,
    outcome,
    linkedEpisodes: [],
    linkedFiles,
    sourceSessionFiles: [params.sessionFile],
    tags,
    messageCount: lines.length,
    summary,
    updatedAt: now,
  };

  return episode;
}

/**
 * Store an episode to the agent's episode file.
 */
export function storeEpisode(episode: Episode): void {
  const episodesDir = resolveEpisodesDir();
  try {
    fs.mkdirSync(episodesDir, { recursive: true });
  } catch {
    // Best-effort
  }

  const logFile = resolveEpisodeFile(episode.agentId);
  try {
    const line = JSON.stringify(episode);
    fs.appendFileSync(logFile, line + "\n", "utf-8");
  } catch (err) {
    log.warn(`Failed to store episode: ${String(err)}`);
  }

  // Prune if over limit
  pruneEpisodes(episode.agentId, DEFAULT_EPISODE_CONFIG.maxEpisodesPerAgent);
}

/**
 * Process a session transcript and create an episode if meaningful.
 * This is the main entry point called from the session sync pipeline.
 */
export function processSessionForEpisode(params: {
  agentId: string;
  sessionFile: string;
  sessionContent: string;
  config?: Partial<EpisodeConfig>;
  loopId?: string;
}): Episode | null {
  try {
    // Check if we already have an episode for this session file
    const existing = loadEpisodes(params.agentId);
    if (existing.some((e) => e.sourceSessionFiles.includes(params.sessionFile))) {
      return null; // Already processed
    }

    const episode = extractEpisodeFromSession(params);
    if (!episode) {
      return null;
    }

    // Attach loop ID for cross-system tracing
    if (params.loopId) {
      episode.loopId = params.loopId;
    }

    // Try to link to previous episodes by topic similarity
    const linked = findRelatedEpisodes(existing, episode);
    episode.linkedEpisodes = linked.map((e) => e.id);

    storeEpisode(episode);
    return episode;
  } catch (err) {
    log.warn(`Episode extraction failed: ${String(err)}`);
    return null;
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search episodes for an agent by query text.
 */
export function searchEpisodes(params: {
  agentId: string;
  query: string;
  status?: EpisodeStatus[];
  tags?: string[];
  maxResults?: number;
  config?: Partial<EpisodeConfig>;
}): EpisodeSearchResult[] {
  const config = { ...DEFAULT_EPISODE_CONFIG, ...params.config };
  const maxResults = params.maxResults ?? config.maxSearchResults;
  const episodes = loadEpisodes(params.agentId);
  const queryTokens = tokenize(params.query.toLowerCase());

  if (queryTokens.length === 0) {
    return [];
  }

  const scored: EpisodeSearchResult[] = [];

  for (const episode of episodes) {
    // Status filter
    if (params.status && params.status.length > 0 && !params.status.includes(episode.status)) {
      continue;
    }

    // Tag filter
    if (params.tags && params.tags.length > 0) {
      const hasTag = params.tags.some((t) =>
        episode.tags.some((et) => et.toLowerCase() === t.toLowerCase()),
      );
      if (!hasTag) {
        continue;
      }
    }

    // Score by keyword matching across title, topic, decisions, summary, tags
    const searchableText = [
      episode.title,
      episode.topic,
      ...episode.decisions,
      episode.summary ?? "",
      ...episode.tags,
      episode.outcome ?? "",
    ]
      .join(" ")
      .toLowerCase();

    const searchTokens = tokenize(searchableText);
    let matchCount = 0;
    for (const qt of queryTokens) {
      if (searchTokens.some((t) => t.includes(qt) || qt.includes(t))) {
        matchCount++;
      }
    }

    if (matchCount === 0) {
      continue;
    }

    const matchFraction = matchCount / queryTokens.length;
    // Boost recent episodes
    const ageDays = (Date.now() - episode.updatedAt) / (24 * 60 * 60 * 1000);
    const recency = Math.exp(-0.005 * ageDays); // very gentle decay
    const score = matchFraction * recency;

    scored.push({ episode, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * Get recent episodes for an agent.
 */
export function getRecentEpisodes(agentId: string, limit = 10): Episode[] {
  const episodes = loadEpisodes(agentId);
  return episodes.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * Get episode statistics for an agent.
 */
export function getEpisodeStats(agentId: string): {
  total: number;
  byStatus: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  avgDecisionsPerEpisode: number;
  linkedCount: number;
} {
  const episodes = loadEpisodes(agentId);
  const byStatus: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  let totalDecisions = 0;
  let linkedCount = 0;

  for (const ep of episodes) {
    byStatus[ep.status] = (byStatus[ep.status] ?? 0) + 1;
    totalDecisions += ep.decisions.length;
    if (ep.linkedEpisodes.length > 0) {
      linkedCount++;
    }
    for (const tag of ep.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    total: episodes.length,
    byStatus,
    topTags,
    avgDecisionsPerEpisode: episodes.length > 0 ? totalDecisions / episodes.length : 0,
    linkedCount,
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function generateEpisodeId(): string {
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tokenize(text: string): string[] {
  return (
    text
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1) ?? []
  );
}

function generateTitle(topic: string): string {
  // Take first sentence or first 60 chars
  const firstSentence = topic.match(/^[^.!?]+[.!?]?/)?.[0] ?? topic;
  const title = firstSentence.length > 60 ? firstSentence.slice(0, 57) + "..." : firstSentence;
  return title.trim();
}

/**
 * Extract decisions from conversation lines.
 * Looks for patterns like:
 * - "decided to...", "we'll go with...", "the plan is to..."
 * - "conclusion:", "decision:", "agreed to..."
 * - Lines containing "should", "will", "must" after discussion
 */
function extractDecisions(lines: string[]): string[] {
  const decisions: string[] = [];
  const decisionPatterns = [
    /(?:decided|decision|conclude|conclusion|agreed|going with|plan is|will proceed|should use)\s*(?:to|:|\s)/i,
    /^Assistant:.*(?:I recommend|I suggest|the best approach|let's go with|we should)/i,
    /^Assistant:.*(?:Here's the plan|The solution is|To summarize|In summary)/i,
  ];

  for (const line of lines) {
    for (const pattern of decisionPatterns) {
      if (pattern.test(line)) {
        const clean = line
          .replace(/^(?:User|Assistant):\s*/, "")
          .trim()
          .slice(0, 200);
        if (clean.length > 10) {
          decisions.push(clean);
        }
        break;
      }
    }
  }

  // Limit to top 5 most distinctive decisions
  return decisions.slice(0, 5);
}

/**
 * Extract file paths mentioned in conversation.
 */
function extractLinkedFiles(lines: string[]): string[] {
  const filePattern = /(?:^|\s|`)((?:~\/|\.\/|\/)?[\w./-]+\.\w{1,10})(?:\s|$|`|,|;|\))/g;
  const files = new Set<string>();

  for (const line of lines) {
    let match;
    while ((match = filePattern.exec(line)) !== null) {
      const file = match[1];
      // Filter out obvious non-files
      if (
        file &&
        !file.startsWith("http") &&
        !file.startsWith("//") &&
        !file.endsWith(".0") &&
        !file.match(/^\d+\.\d+/) // version numbers
      ) {
        files.add(file);
      }
    }
  }

  return Array.from(files).slice(0, 20);
}

/**
 * Extract tags from conversation content using keyword analysis.
 */
function extractTags(lines: string[]): string[] {
  const tagPatterns: Array<{ pattern: RegExp; tag: string }> = [
    { pattern: /\b(?:debug|debugging|bug|error|fix|issue)\b/i, tag: "debugging" },
    { pattern: /\b(?:refactor|clean up|reorganize|restructure)\b/i, tag: "refactoring" },
    { pattern: /\b(?:implement|build|create|add|new feature)\b/i, tag: "implementation" },
    { pattern: /\b(?:test|testing|spec|coverage)\b/i, tag: "testing" },
    { pattern: /\b(?:review|audit|inspect|check)\b/i, tag: "review" },
    { pattern: /\b(?:deploy|deployment|release|publish)\b/i, tag: "deployment" },
    { pattern: /\b(?:config|configuration|setup|install)\b/i, tag: "configuration" },
    { pattern: /\b(?:design|architect|pattern|structure)\b/i, tag: "architecture" },
    { pattern: /\b(?:document|docs|readme|wiki)\b/i, tag: "documentation" },
    { pattern: /\b(?:performance|optimize|speed|memory|cpu)\b/i, tag: "performance" },
    { pattern: /\b(?:security|auth|encrypt|permission|access)\b/i, tag: "security" },
    { pattern: /\b(?:api|endpoint|route|handler)\b/i, tag: "api" },
    { pattern: /\b(?:database|query|schema|migration|sql)\b/i, tag: "database" },
    { pattern: /\b(?:ui|frontend|component|layout|style)\b/i, tag: "frontend" },
    { pattern: /\b(?:plan|planning|strategy|roadmap)\b/i, tag: "planning" },
  ];

  const fullText = lines.join(" ");
  const tags = new Set<string>();

  for (const { pattern, tag } of tagPatterns) {
    if (pattern.test(fullText)) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}

/**
 * Generate a brief summary from conversation lines.
 */
function generateSummary(lines: string[], title: string, decisions: string[]): string {
  const parts: string[] = [];

  // Opening: what was discussed
  parts.push(`Topic: ${title}`);

  // Stats
  const userMsgs = lines.filter((l) => l.startsWith("User:")).length;
  const assistantMsgs = lines.filter((l) => l.startsWith("Assistant:")).length;
  parts.push(`Exchange: ${userMsgs} user messages, ${assistantMsgs} assistant responses.`);

  // Key decisions
  if (decisions.length > 0) {
    parts.push(`Decisions: ${decisions.slice(0, 3).join("; ")}`);
  }

  return parts.join(" ");
}

/**
 * Estimate start/end time from session file name.
 * Session files are often named like: <session-id>.jsonl
 * with timestamps embedded in the session-id or file mtime.
 */
function estimateTimeFromSessionFile(
  sessionFile: string,
): { startTime: number; endTime: number } | null {
  try {
    const stat = fs.statSync(sessionFile);
    // Use file mtime as end time, and estimate start based on file size
    // (rough heuristic: assume ~1KB per minute of conversation)
    const endTime = stat.mtimeMs;
    const estimatedDurationMs = Math.max(60_000, (stat.size / 1024) * 60_000);
    const startTime = endTime - estimatedDurationMs;
    return { startTime, endTime };
  } catch {
    return null;
  }
}

/**
 * Find episodes related to a new episode by topic similarity.
 */
function findRelatedEpisodes(existing: Episode[], newEpisode: Episode): Episode[] {
  if (existing.length === 0) {
    return [];
  }

  const newTokens = tokenize(
    [newEpisode.title, newEpisode.topic, ...newEpisode.tags].join(" ").toLowerCase(),
  );
  if (newTokens.length === 0) {
    return [];
  }

  const scored: Array<{ episode: Episode; score: number }> = [];

  for (const ep of existing) {
    const epTokens = tokenize([ep.title, ep.topic, ...ep.tags].join(" ").toLowerCase());

    let overlap = 0;
    for (const t of newTokens) {
      if (epTokens.some((et) => et.includes(t) || t.includes(et))) {
        overlap++;
      }
    }

    const similarity = overlap / Math.max(1, newTokens.length);
    if (similarity >= 0.3) {
      scored.push({ episode: ep, score: similarity });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.episode);
}

function loadEpisodes(agentId: string): Episode[] {
  const file = resolveEpisodeFile(agentId);
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Episode;
        } catch {
          return null;
        }
      })
      .filter((e): e is Episode => e !== null);
  } catch {
    return [];
  }
}

function pruneEpisodes(agentId: string, maxEpisodes: number): void {
  const episodes = loadEpisodes(agentId);
  if (episodes.length <= maxEpisodes) {
    return;
  }

  // Keep most recent episodes
  const sorted = episodes.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, maxEpisodes);
  const file = resolveEpisodeFile(agentId);
  try {
    const content = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(file, content, "utf-8");
  } catch {
    // Best-effort
  }
}
