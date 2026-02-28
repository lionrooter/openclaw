---
name: tool-telemetry
description: "Persist tool-call stats to JSONL on session end for audit and action space optimization"
homepage: https://docs.openclaw.ai/automation/hooks#tool-telemetry
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "events": ["command"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Tool Telemetry Hook

Persists tool-call statistics from each session to a JSONL audit log when the session resets or ends. This data helps optimize per-agent action spaces by revealing which tools each agent actually uses.

## What It Does

When a `/new` or `/reset` command fires:

1. **Reads tool call history** from the outgoing session's `SessionState.toolCallHistory`
2. **Computes stats** — total calls, unique patterns, per-tool frequency breakdown
3. **Appends a JSONL record** to `~/.openclaw/telemetry/tool-calls.jsonl`

## Output Format

```json
{
  "timestamp": "2026-02-27T14:30:00.000Z",
  "agentId": "cody",
  "sessionKey": "agent:cody:main",
  "totalCalls": 42,
  "uniquePatterns": 18,
  "tools": { "Bash": 15, "Read": 8, "Write": 6, "Grep": 5, "Edit": 4, "Glob": 3, "WebFetch": 1 },
  "mostFrequent": { "toolName": "Bash", "count": 15 }
}
```

## Use Cases

- **Action space tuning**: See which skills/tools each agent actually uses vs. what's available
- **Cost optimization**: Identify tool call patterns that waste tokens
- **Loop detection audit**: Confirm loop detectors are catching repetitive patterns
- **Agent comparison**: Compare tool usage profiles across agents

## Log File Location

`~/.openclaw/telemetry/tool-calls.jsonl`

## Querying

```bash
# Per-agent tool usage summary
cat ~/.openclaw/telemetry/tool-calls.jsonl | jq -s 'group_by(.agentId) | map({agent: .[0].agentId, sessions: length, avgCalls: (map(.totalCalls) | add / length)})'

# Most used tools across all sessions
cat ~/.openclaw/telemetry/tool-calls.jsonl | jq -s '[.[].tools | to_entries[]] | group_by(.key) | map({tool: .[0].key, total: map(.value) | add}) | sort_by(-.total)'

# Tools used by a specific agent
grep '"agentId":"cody"' ~/.openclaw/telemetry/tool-calls.jsonl | jq '.tools'
```

## Requirements

No requirements — this hook works out of the box on all platforms.
