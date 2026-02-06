# Claude CLI Streaming Proxy

OpenAI-compatible streaming proxy that uses Claude CLI as a subprocess to avoid API costs.

## Why This Exists

OpenClaw uses Pi-AI SDK which expects OpenAI-compatible **streaming** responses (SSE format). This proxy:

- Calls `claude --print` (no API cost, uses your Claude Code license)
- Returns Server-Sent Events (SSE) format with `delta.content` chunks
- Compatible with Pi-AI SDK's openai-completions handler
- Works with Discord, Zulip, and any OpenClaw channel

## Installation

### 1. Copy proxy to your scripts directory

```bash
cp server.mjs ~/scripts/claude-cli-proxy-streaming.mjs
chmod +x ~/scripts/claude-cli-proxy-streaming.mjs
```

### 2. Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://127.0.0.1:11435/v1",
        "apiKey": "dummy-key-not-needed",
        "models": [
          {
            "id": "sonnet",
            "name": "Claude Sonnet via CLI",
            "api": "openai-completions",
            "contextWindow": 200000
          },
          {
            "id": "opus",
            "name": "Claude Opus via CLI",
            "api": "openai-completions",
            "contextWindow": 200000
          },
          {
            "id": "haiku",
            "name": "Claude Haiku via CLI",
            "api": "openai-completions",
            "contextWindow": 200000
          }
        ]
      }
    },
    "primary": "openai/opus"
  }
}
```

### 3. Configure Agent Auth

Edit `~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "openai:default": {
      "type": "api_key",
      "provider": "openai",
      "key": "dummy-not-needed"
    }
  },
  "lastGood": "openai:default"
}
```

### 4. Start the Proxy

```bash
nohup node ~/scripts/claude-cli-proxy-streaming.mjs > /tmp/claude-proxy-stream.log 2>&1 &
```

### 5. Restart OpenClaw Gateway

```bash
openclaw gateway stop
openclaw gateway start
```

## Usage

The proxy runs on `http://127.0.0.1:11435` and provides:

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Chat completions (streaming)

### Available Models

- `sonnet` (Claude Sonnet 4.5)
- `opus` (Claude Opus 4.6)
- `haiku` (Claude Haiku 4.5)

## Channel Configuration

### Discord

```json
{
  "type": "discord",
  "token": "your-discord-token",
  "agent": "main"
}
```

### Zulip

```json
{
  "type": "zulip",
  "site": "https://your-org.zulipchat.com",
  "email": "bot@your-org.zulipchat.com",
  "apiKey": "your-zulip-api-key",
  "agent": "main"
}
```

Both will automatically use the OpenAI provider configured in the agent's auth profile.

## Technical Details

### Why Streaming Format?

Pi-AI SDK's `openai-completions.js` handler:

- Line 332: Hardcodes `stream: true`
- Lines 105-154: Parses `choice.delta.content` from SSE chunks
- **Does NOT support** completion format (`choice.message.content`)

### Response Format

The proxy sends two chunks:

**Chunk 1** (content):

```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion.chunk",
  "model": "opus",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",
        "content": "Full response text here"
      },
      "finish_reason": null
    }
  ]
}
```

**Chunk 2** (finish):

```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion.chunk",
  "model": "opus",
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 1801
  }
}
```

Followed by: `data: [DONE]\n\n`

## Troubleshooting

### Check proxy is running

```bash
curl http://127.0.0.1:11435/v1/models
```

### Check proxy logs

```bash
tail -f /tmp/claude-proxy-stream.log
```

### Check gateway status

```bash
moltbot channels status
```

### Test end-to-end

In Discord: `@YourBot hello world`
In Zulip: Send a DM to the bot

### Common Issues

**"No response from bot"**

- Check proxy is running on port 11435
- Verify `api: "openai-completions"` is set in model config
- Check auth-profiles.json has openai:default profile

**"Connection refused"**

- Restart proxy: `pkill -f claude-cli-proxy && node ~/scripts/claude-cli-proxy-streaming.mjs &`

**"Model not found"**

- Restart gateway: `openclaw gateway stop && openclaw gateway start`

## Preservation

This setup survives OpenClaw updates because:

1. Proxy is in `~/scripts` (not in openclaw directory)
2. Config is in `~/.openclaw` (persists across updates)
3. Documentation is in this repo

After OpenClaw updates:

1. Verify proxy config in `~/.openclaw/openclaw.json`
2. Restart gateway: `openclaw gateway stop && openclaw gateway start`
3. Test with a message

## Cost Savings

- **Before**: Every message = Anthropic API call = ~$0.015 per message
- **After**: Uses Claude CLI subprocess = **$0** (included in Claude Code license)
- For 1000 messages/month: **Save ~$15/month**
