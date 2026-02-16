/**
 * Learning RAG Plugin
 *
 * Injects relevant knowledge from the Neo4j vault graph into agent context
 * at query time via the `before_agent_start` hook.
 *
 * Architecture:
 *   1. Agent receives a message (prompt)
 *   2. Plugin embeds the prompt using OpenAI
 *   3. Vector search against Neo4j HNSW index finds similar vault notes
 *   4. Optional 1-hop graph traversal finds linked notes + shared tags
 *   5. Results are formatted as <knowledge-graph> XML and prepended to context
 *
 * This gives agents automatic access to the Obsidian vault knowledge graph
 * without any manual retrieval. Per-agent filtering is supported via the
 * `owner` property on Note nodes.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import neo4j from "neo4j-driver";
import OpenAI from "openai";

// ============================================================================
// Types
// ============================================================================

type LearningRagConfig = {
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  embedding: {
    apiKey: string;
  };
  topK: number;
  minScore: number;
  includeNeighbors: boolean;
};

type SearchResult = {
  filePath: string;
  title: string;
  type: string;
  owner: string | null;
  score: number;
};

type GraphSearchResult = {
  seeds: SearchResult[];
  neighbors: Array<{
    filePath: string;
    title: string;
    type: string;
    owner: string | null;
  }>;
};

// ============================================================================
// Config parsing
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parseConfig(raw: Record<string, unknown> | undefined): LearningRagConfig {
  if (!raw) {
    throw new Error("learning-rag: plugin config is required");
  }

  const neo4jCfg = raw.neo4j as Record<string, unknown> | undefined;
  if (!neo4jCfg?.password) {
    throw new Error("learning-rag: neo4j.password is required");
  }

  const embeddingCfg = raw.embedding as Record<string, unknown> | undefined;
  if (!embeddingCfg?.apiKey) {
    throw new Error("learning-rag: embedding.apiKey is required");
  }

  return {
    neo4j: {
      uri: (neo4jCfg.uri as string) || "bolt://localhost:7687",
      user: (neo4jCfg.user as string) || "neo4j",
      password: resolveEnvVars(neo4jCfg.password as string),
    },
    embedding: {
      apiKey: resolveEnvVars(embeddingCfg.apiKey as string),
    },
    topK: (raw.topK as number) ?? 3,
    minScore: (raw.minScore as number) ?? 0.3,
    includeNeighbors: (raw.includeNeighbors as boolean) ?? true,
  };
}

// ============================================================================
// Neo4j Client (lightweight — only vector search operations)
// ============================================================================

const VECTOR_INDEX_NAME = "note_embedding";

class Neo4jRAG {
  private driver: ReturnType<typeof neo4j.driver>;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  async vectorSearch(
    queryVector: number[],
    topK: number,
    minScore: number,
    owner?: string,
  ): Promise<SearchResult[]> {
    const session = this.driver.session();
    try {
      let cypher = `
        CALL db.index.vector.queryNodes($indexName, $topK, $queryVector)
        YIELD node, score
        WHERE score >= $minScore`;

      const params: Record<string, unknown> = {
        indexName: VECTOR_INDEX_NAME,
        topK: neo4j.int(topK),
        queryVector,
        minScore,
      };

      if (owner) {
        cypher += `\n        AND node.owner = $owner`;
        params.owner = owner;
      }

      cypher += `
        RETURN node.filePath AS filePath,
               node.title AS title,
               node.type AS type,
               node.owner AS owner,
               score
        ORDER BY score DESC`;

      const result = await session.run(cypher, params);
      return result.records.map((r) => ({
        filePath: r.get("filePath") as string,
        title: r.get("title") as string,
        type: r.get("type") as string,
        owner: r.get("owner") as string | null,
        score: r.get("score") as number,
      }));
    } finally {
      await session.close();
    }
  }

  async vectorSearchWithGraph(
    queryVector: number[],
    topK: number,
    minScore: number,
    owner?: string,
  ): Promise<GraphSearchResult> {
    const session = this.driver.session();
    try {
      let cypher = `
        CALL db.index.vector.queryNodes($indexName, $topK, $queryVector)
        YIELD node AS seed, score
        WHERE score >= $minScore`;

      const params: Record<string, unknown> = {
        indexName: VECTOR_INDEX_NAME,
        topK: neo4j.int(topK),
        queryVector,
        minScore,
      };

      if (owner) {
        cypher += `\n        AND seed.owner = $owner`;
        params.owner = owner;
      }

      cypher += `
        WITH collect({
          filePath: seed.filePath,
          title: seed.title,
          type: seed.type,
          owner: seed.owner,
          score: score
        }) AS seeds, collect(seed) AS seedNodes
        UNWIND seedNodes AS s
        OPTIONAL MATCH (s)-[:LINKS_TO|HAS_TAG]-(neighbor:Note)
        WHERE NOT neighbor IN seedNodes
        WITH seeds, collect(DISTINCT {
          filePath: neighbor.filePath,
          title: neighbor.title,
          type: neighbor.type,
          owner: neighbor.owner
        }) AS neighbors
        RETURN seeds, neighbors`;

      const result = await session.run(cypher, params);
      const row = result.records[0];

      if (!row) {
        return { seeds: [], neighbors: [] };
      }

      return {
        seeds: row.get("seeds") as SearchResult[],
        neighbors: row.get("neighbors") as GraphSearchResult["neighbors"],
      };
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ============================================================================
// Embeddings
// ============================================================================

class QueryEmbedder {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  }
}

// ============================================================================
// Context Formatting
// ============================================================================

function formatKnowledgeContext(result: GraphSearchResult): string {
  if (result.seeds.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("<knowledge-graph>");
  lines.push("Relevant knowledge from your vault:");
  lines.push("");

  for (const seed of result.seeds) {
    const pct = (seed.score * 100).toFixed(0);
    lines.push(
      `- [${seed.type}] ${seed.title} (${pct}% match${seed.owner ? `, owner: ${seed.owner}` : ""})`,
    );
  }

  if (result.neighbors.length > 0) {
    lines.push("");
    lines.push("Related notes (graph neighbors):");
    for (const n of result.neighbors.slice(0, 5)) {
      lines.push(`- [${n.type}] ${n.title}${n.owner ? ` (owner: ${n.owner})` : ""}`);
    }
  }

  lines.push("</knowledge-graph>");
  return lines.join("\n");
}

function formatSimpleContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("<knowledge-graph>");
  lines.push("Relevant knowledge from your vault:");
  lines.push("");

  for (const r of results) {
    const pct = (r.score * 100).toFixed(0);
    lines.push(`- [${r.type}] ${r.title} (${pct}% match${r.owner ? `, owner: ${r.owner}` : ""})`);
  }

  lines.push("</knowledge-graph>");
  return lines.join("\n");
}

// ============================================================================
// Agent name → owner mapping
// ============================================================================

const AGENT_OWNER_MAP: Record<string, string> = {
  clawdy: "Clawdy",
  leo: "Leo",
  cody: "Cody",
  artie: "Artie",
  exdi: "Exdi",
  grove: "Grove",
  liev: "Liev",
  nesta: "Nesta",
  finn: "Finn",
  archie: "Archie",
};

function resolveOwner(agentId?: string): string | undefined {
  if (!agentId) {
    return undefined;
  }
  const lower = agentId.toLowerCase();
  // Try exact match first, then prefix match
  if (AGENT_OWNER_MAP[lower]) {
    return AGENT_OWNER_MAP[lower];
  }
  for (const [key, value] of Object.entries(AGENT_OWNER_MAP)) {
    if (lower.includes(key)) {
      return value;
    }
  }
  return undefined;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const learningRagPlugin = {
  id: "learning-rag",
  name: "Learning RAG",
  description: "Neo4j knowledge graph RAG — injects vault knowledge into agent context",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown>);
    const neo4jClient = new Neo4jRAG(cfg.neo4j.uri, cfg.neo4j.user, cfg.neo4j.password);
    const embedder = new QueryEmbedder(cfg.embedding.apiKey);

    api.logger.info(
      `learning-rag: registered (neo4j: ${cfg.neo4j.uri}, topK: ${cfg.topK}, neighbors: ${cfg.includeNeighbors})`,
    );

    // ========================================================================
    // before_agent_start — inject relevant vault knowledge
    // ========================================================================

    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) {
        return;
      }

      // Skip if the prompt already has knowledge context (avoid double-injection)
      if (event.prompt.includes("<knowledge-graph>")) {
        return;
      }

      try {
        const queryVector = await embedder.embed(event.prompt);

        // Resolve per-agent owner filter
        const owner = resolveOwner(ctx.agentId);

        let context: string;

        if (cfg.includeNeighbors) {
          // Vector search + 1-hop graph traversal
          const result = await neo4jClient.vectorSearchWithGraph(
            queryVector,
            cfg.topK,
            cfg.minScore,
            owner,
          );
          context = formatKnowledgeContext(result);
        } else {
          // Pure vector search
          const results = await neo4jClient.vectorSearch(
            queryVector,
            cfg.topK,
            cfg.minScore,
            owner,
          );
          context = formatSimpleContext(results);
        }

        if (!context) {
          return;
        }

        api.logger.info?.(`learning-rag: injecting knowledge context (${context.length} chars)`);

        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`learning-rag: retrieval failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Cleanup on gateway stop
    // ========================================================================

    api.on("gateway_stop", async () => {
      await neo4jClient.close();
      api.logger.info("learning-rag: Neo4j connection closed");
    });
  },
};

export default learningRagPlugin;
