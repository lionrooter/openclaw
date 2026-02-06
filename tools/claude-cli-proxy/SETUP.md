# Claude CLI Proxy Setup for OpenClaw/Moltbot

This guide documents how to use Claude CLI (from Claude Code subscription) with OpenClaw Discord bots, avoiding direct API costs while maintaining full functionality.

## Problem

OpenClaw's Discord integration was not posting responses because:

1. The Pi-AI SDK (used by openclaw) doesn't support "ollama" provider type
2. Anthropic OAuth authentication was failing
3. Responses were being generated but never delivered to Discord

## Solution Architecture

```
Discord Message
    ↓
OpenClaw Gateway (receives message)
    ↓
Pi-AI SDK (calls LLM provider)
    ↓
"openai" provider config → http://localhost:11435/v1/chat/completions
    ↓
Claude CLI Proxy (this solution)
    ↓
Claude CLI subprocess (--print mode)
    ↓
Response back through chain → Posted to Discord
```

### Key Components

1. **OpenClaw Config**: Uses "openai" provider type (Pi-AI SDK supports this)
2. **Proxy Server**: Converts OpenAI API format ↔ Claude CLI commands
3. **Claude CLI**: Uses your Claude Code subscription (no API costs)

## Prerequisites

- ✅ Claude Code installed and authenticated (`claude --print` works)
- ✅ OpenClaw/Moltbot installed
- ✅ Discord bot configured

## Installation Steps

### 1. Start the Proxy

```bash
# Make proxy executable
chmod +x /Users/lionroot/scripts/claude-cli-proxy-final.mjs

# Start proxy (keep running)
node /Users/lionroot/scripts/claude-cli-proxy-final.mjs
```

You should see:

```
🦞 Claude CLI Proxy running on http://127.0.0.1:11435
Using Claude CLI: /Users/lionroot/.local/bin/claude
Models available: sonnet, opus, haiku

This proxy uses your Claude Code subscription - no API costs!
Ready!
```

### 2. Update OpenClaw Configuration

```bash
# Remove old ollama provider
openclaw config delete models.providers.ollama

# Add openai provider pointing to proxy
openclaw config set models.providers.openai.baseUrl "http://127.0.0.1:11435/v1"
openclaw config set models.providers.openai.apiKey "dummy-not-needed"
openclaw config set models.providers.openai.models.0.id "sonnet"
openclaw config set models.providers.openai.models.0.name "Claude Sonnet 4.5 via CLI"
openclaw config set models.providers.openai.models.0.contextWindow 200000

# Add Opus model
openclaw config set models.providers.openai.models.1.id "opus"
openclaw config set models.providers.openai.models.1.name "Claude Opus 4.6 via CLI"
openclaw config set models.providers.openai.models.1.contextWindow 200000

# Add Haiku model
openclaw config set models.providers.openai.models.2.id "haiku"
openclaw config set models.providers.openai.models.2.name "Claude Haiku 4.5 via CLI"
openclaw config set models.providers.openai.models.2.contextWindow 200000

# Set main agent to use sonnet
openclaw config set agents.list.0.model.primary "openai/sonnet"
```

### 3. Update Auth Profiles

Edit `~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "openai:default": {
    "type": "api_key",
    "provider": "openai",
    "key": "dummy-not-needed"
  }
}
```

Remove any `ollama:default` entries.

### 4. Restart OpenClaw Gateway

```bash
# Stop all gateway processes
pkill -9 -f openclaw-gateway

# Start gateway with debug logging
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/gateway-claude-cli.log 2>&1 &

# Verify it's running
openclaw channels status
```

### 5. Test in Discord

Send a message to your bot:

```
@Clawdy_Bot hello
```

You should see:

1. Typing indicator appears
2. After ~20 seconds, bot responds
3. Proxy logs show the request/response

## Monitoring

### Proxy Logs

The proxy logs all requests to stdout:

```
[2026-02-06T...] Calling Claude CLI with model: sonnet
[2026-02-06T...] Prompt length: 245 chars
[2026-02-06T...] Response received, 87 chars
```

### Gateway Logs

Check gateway activity:

```bash
tail -f /tmp/gateway-claude-cli.log
```

### Session Logs

Check openclaw sessions:

```bash
ls -lt ~/.openclaw/agents/main/sessions/
cat ~/.openclaw/agents/main/sessions/*.jsonl | tail -20
```

## Model Selection

The proxy supports three models:

- **sonnet** - Claude Sonnet 4.5 (default, balanced)
- **opus** - Claude Opus 4.6 (most capable, slower)
- **haiku** - Claude Haiku 4.5 (fast, simple tasks)

Configure per-agent:

```bash
# Use Opus for main agent
openclaw config set agents.list.0.model.primary "openai/opus"

# Use Haiku for heartbeat checks
openclaw config set agents.defaults.heartbeat.model "openai/haiku"
```

## Performance

- **Response time**: ~15-25 seconds (Claude CLI overhead)
- **Cost**: $0 (uses Claude Code subscription)
- **Concurrent requests**: Limited by single proxy process (can run multiple on different ports)

## Troubleshooting

### Proxy won't start

```bash
# Check if port is in use
lsof -i :11435

# Kill if needed
kill -9 <PID>
```

### Claude CLI auth errors

```bash
# Re-authenticate
claude --print "test"
# If fails, run:
claude
# Then type: /login
```

### No Discord responses

1. Check proxy is running:

   ```bash
   curl http://localhost:11435/v1/models
   ```

2. Check gateway logs:

   ```bash
   tail -50 /tmp/gateway-claude-cli.log
   ```

3. Verify config:
   ```bash
   openclaw config get models.providers.openai
   openclaw config get agents.list.0.model.primary
   ```

### Responses are slow

This is normal - Claude CLI takes 15-25 seconds. The typing indicator shows the bot is working.

To speed up:

- Use `haiku` for simple queries
- Run multiple proxy instances for concurrent requests

## Running in Production

### 1. Run proxy as background service

Create `/Users/lionroot/Library/LaunchAgents/com.user.claude-cli-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.claude-cli-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/lionroot/scripts/claude-cli-proxy-final.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-cli-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-cli-proxy.error.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.user.claude-cli-proxy.plist
```

### 2. Monitor health

Check proxy health:

```bash
curl -s http://localhost:11435/v1/models | jq
```

## What We Achieved (from the Tweet)

✅ Claude CLI as subprocess
✅ JSON in, reply out (OpenAI-compatible)
✅ Smart model routing (sonnet/opus/haiku)
✅ Works with Anthropic subscription (Claude Code)
✅ Session persistence (openclaw handles this)

Future additions:

- Local Llama for heartbeat (add another proxy on different port)
- Load balancing across multiple proxy instances
- Response caching

## Credits

Solution based on this approach:

> "Ended up forking it and using Claude CLI directly: Claude CLI as subprocess, JSON in/out, smart model routing. All works with same Anthropic subscription."

Implemented for OpenClaw Discord bots to fix message posting issue caused by Pi-AI SDK not supporting "ollama" provider type.

## Support

If issues persist:

1. Check all logs (proxy, gateway, session)
2. Verify Claude CLI works standalone: `claude --print "test" --model sonnet`
3. Verify proxy responds: `curl http://localhost:11435/v1/models`
4. Check Discord channel configuration in openclaw.json
5. Review session files for errors

Last updated: 2026-02-06
