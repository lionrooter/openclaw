# learning-rag

OpenClaw gateway extension that provides automatic RAG (Retrieval-Augmented Generation) context to agents by querying a Neo4j knowledge graph before each agent response. Uses vector similarity search over note embeddings combined with graph traversal to find relevant vault knowledge.

## How It Works

```
User message
     |
     v
before_agent_start hook (this plugin)
     |
     |  1. Embed the user's prompt (OpenAI text-embedding-3-small)
     |  2. Vector search against Neo4j HNSW index (cosine similarity)
     |  3. Optional 1-hop graph traversal (LINKS_TO + HAS_TAG neighbors)
     |  4. Format results as <knowledge-graph> XML block
     |
     v
Enriched context prepended to agent prompt
     |
     v
Agent generates response (with vault knowledge available)
```

### Step-by-Step

1. **Hook trigger**: When any agent receives a message, the `before_agent_start` hook fires before the agent processes it.
2. **Query embedding**: The user's prompt is embedded into a 1536-dimension vector using OpenAI's `text-embedding-3-small` model.
3. **Vector search**: The embedding is compared against all Note node embeddings in the Neo4j HNSW vector index. Top-K results above the minimum similarity threshold are returned.
4. **Graph traversal** (optional): For each vector search result, 1-hop neighbors are discovered via `LINKS_TO` and `HAS_TAG` relationships. This surfaces related notes that may not be semantically similar but are structurally connected.
5. **Per-agent filtering**: If the agent has a known identity (Clawdy, Leo, Cody, etc.), results are filtered by the `owner` property on Note nodes so each agent sees knowledge relevant to its domain.
6. **Context injection**: Results are formatted as a `<knowledge-graph>` XML block and prepended to the agent's context via `prependContext`.

### Context Output Format

```xml
<knowledge-graph>
Relevant knowledge from your vault:

- [Project] CLI Proxy Expansion (87% match, owner: Archie)
- [Decision] Tiered Inference Architecture (72% match, owner: Leo)
- [AgentContext] Cody Context (65% match, owner: Cody)

Related notes (graph neighbors):
- [Tool] ClawRouter (owner: Leo)
- [Infrastructure] EXO Cluster (owner: Archie)
</knowledge-graph>
```

## Configuration

Configuration is provided via the OpenClaw plugin config in `openclaw.json`:

```json
{
  "extensions": {
    "learning-rag": {
      "neo4j": {
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "${NEO4J_PASSWORD}"
      },
      "embedding": {
        "apiKey": "${OPENAI_API_KEY}"
      },
      "topK": 3,
      "minScore": 0.3,
      "includeNeighbors": true
    }
  }
}
```

### Config Options

| Option             | Type    | Default                 | Description                                                        |
| ------------------ | ------- | ----------------------- | ------------------------------------------------------------------ |
| `neo4j.uri`        | string  | `bolt://localhost:7687` | Neo4j Bolt connection URI                                          |
| `neo4j.user`       | string  | `neo4j`                 | Neo4j username                                                     |
| `neo4j.password`   | string  | _required_              | Neo4j password (supports `${ENV_VAR}` syntax)                      |
| `embedding.apiKey` | string  | _required_              | OpenAI API key for query embeddings (supports `${ENV_VAR}` syntax) |
| `topK`             | number  | `3`                     | Number of similar notes to retrieve per query                      |
| `minScore`         | number  | `0.3`                   | Minimum cosine similarity threshold (0-1)                          |
| `includeNeighbors` | boolean | `true`                  | Also retrieve notes linked to/from top results via graph traversal |

### Environment Variable Substitution

Sensitive values support `${ENV_VAR}` syntax in the config. The plugin resolves these at startup:

- `"${NEO4J_PASSWORD}"` reads from `process.env.NEO4J_PASSWORD`
- `"${OPENAI_API_KEY}"` reads from `process.env.OPENAI_API_KEY`

## Per-Agent Filtering

The plugin maps agent IDs to vault owner names:

| Agent ID | Owner Filter |
| -------- | ------------ |
| clawdy   | Clawdy       |
| leo      | Leo          |
| cody     | Cody         |
| artie    | Artie        |
| exdi     | Exdi         |
| grove    | Grove        |
| liev     | Liev         |
| nesta    | Nesta        |
| finn     | Finn         |
| archie   | Archie       |

When an agent has a known identity, vector search results are filtered to notes owned by that agent. This ensures agents primarily see knowledge from their own domain while still having access to the broader graph through neighbor traversal.

## Plugin Lifecycle

- **Startup**: Parses config, connects to Neo4j, initializes OpenAI embeddings client.
- **Per-request**: Embeds prompt, runs vector search (+graph traversal), prepends context. Skips prompts shorter than 5 characters and prompts that already contain `<knowledge-graph>` (avoids double injection).
- **Shutdown**: Closes Neo4j driver connection on `gateway_stop` event.

## Source Files

| File                   | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Plugin implementation: config parsing, Neo4jRAG client, QueryEmbedder, context formatting, `before_agent_start` hook, `gateway_stop` cleanup |
| `openclaw.plugin.json` | Plugin config schema with validation rules, defaults, and UI hints for OpenClaw Studio                                                       |
| `package.json`         | Package manifest (`@openclaw/learning-rag` v0.1.0)                                                                                           |

## Dependencies

- `neo4j-driver` ^5.27.0 — Neo4j Bolt protocol driver
- `openai` ^6.21.0 — OpenAI API client for embeddings
- `openclaw` (dev) — Plugin SDK type definitions

## Prerequisites

- Neo4j 5.x running with the vault graph populated (see `neo4j-vault-sync`)
- HNSW vector index `note_embedding` created (seed.js creates this automatically)
- OpenAI API key for generating query embeddings
- OpenClaw gateway with plugin support enabled
