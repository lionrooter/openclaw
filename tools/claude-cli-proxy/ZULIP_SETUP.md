# Zulip Setup with Claude CLI Proxy

This guide adds Zulip support to your OpenClaw setup using the Claude CLI proxy.

## Prerequisites

1. Claude CLI proxy running (see README.md)
2. Zulip bot credentials:
   - Site URL (e.g., `https://your-org.zulipchat.com`)
   - Bot email (e.g., `clawdy-bot@your-org.zulipchat.com`)
   - Bot API key

## Get Zulip Bot Credentials

### Option 1: Create New Bot

1. Go to your Zulip organization settings
2. Navigate to **Personal settings** → **Bots**
3. Click **Add a new bot**
4. Choose **Generic bot** type
5. Set name (e.g., "Clawdy") and email
6. Click **Create bot**
7. Copy the **API key** shown

### Option 2: Use Existing Bot

1. Go to **Personal settings** → **Bots**
2. Find your bot in the list
3. Click **Show/change your API key**
4. Copy the API key

## Configuration

### 1. Enable Zulip Plugin

Edit `~/.openclaw/openclaw.json` and add to the `plugins` section:

```json
{
  "plugins": {
    "entries": {
      "zulip": {}
    }
  }
}
```

### 2. Add Zulip Channel Configuration

Add to the `channels` section in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "botEmail": "clawdy-bot@your-org.zulipchat.com",
      "botApiKey": "your-zulip-api-key-here",
      "baseUrl": "https://your-org.zulipchat.com",
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "allowlist",
      "requireMention": true
    }
  }
}
```

### 3. Add Agent Binding (Optional)

If you want a specific agent to respond in Zulip, add to `bindings`:

```json
{
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "zulip",
        "accountId": "default"
      }
    }
  ]
}
```

### 4. Multi-Account Setup (Optional)

To run multiple Zulip bots, use the `accounts` pattern:

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "accounts": {
        "clawdy": {
          "name": "Clawdy",
          "enabled": true,
          "botEmail": "clawdy-bot@your-org.zulipchat.com",
          "botApiKey": "key1",
          "baseUrl": "https://your-org.zulipchat.com",
          "dmPolicy": "open",
          "allowFrom": ["*"]
        },
        "cody": {
          "name": "Cody",
          "enabled": true,
          "botEmail": "cody-bot@your-org.zulipchat.com",
          "botApiKey": "key2",
          "baseUrl": "https://your-org.zulipchat.com",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

## Restart Gateway

```bash
openclaw gateway stop
openclaw gateway start
```

## Verify Setup

### Check Channel Status

```bash
moltbot channels status
```

You should see Zulip listed with status "connected".

### Test in Zulip

1. **Direct Message**: Send a DM to your bot
2. **Stream Message**: Mention the bot in a stream (if `requireMention: true`)

Example:

```
@**Clawdy** hello world
```

## Configuration Options

### DM Policy

- `"open"`: Anyone can DM the bot (requires `allowFrom: ["*"]`)
- `"pairing"`: Users must pair first
- `"closed"`: No DMs accepted

### Group Policy

- `"allowlist"`: Only respond in allowed streams
- `"open"`: Respond in any stream

### Require Mention

- `true`: Bot only responds when @mentioned in streams
- `false`: Bot responds to all messages in allowed streams

### Stream Allowlist

To allow specific streams, use `groupAllowFrom`:

```json
{
  "groupPolicy": "allowlist",
  "groupAllowFrom": [
    "announce",
    "general",
    123456 // Stream ID
  ]
}
```

### Block Streaming

To send complete responses instead of streaming:

```json
{
  "blockStreaming": true
}
```

Or with coalescing (wait for full response):

```json
{
  "blockStreamingCoalesce": {
    "enabled": true,
    "timeout": 10000
  }
}
```

## Model Selection

The bot uses the model configured in the agent's auth profile (same as Discord).

To use a specific model for Zulip, set it in the agent config:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "model": {
          "primary": "openai/opus"
        }
      }
    ]
  }
}
```

## Troubleshooting

### "No response from bot"

1. **Check proxy is running**:

   ```bash
   curl http://127.0.0.1:11435/v1/models
   ```

2. **Check gateway logs**:

   ```bash
   tail -f /tmp/openclaw-gateway.log | grep -i zulip
   ```

3. **Verify Zulip credentials**:
   ```bash
   curl -u BOT_EMAIL:API_KEY https://your-org.zulipchat.com/api/v1/users/me
   ```

### "Authentication failed"

- Verify `botEmail` and `botApiKey` are correct
- Check `baseUrl` has no trailing slash
- Ensure bot is not deactivated in Zulip settings

### "Not responding in streams"

- Check `requireMention: true` - you must @mention the bot
- Verify stream is in `groupAllowFrom` allowlist
- Check `groupPolicy` is set to `"allowlist"`

### "TLS certificate error"

For self-hosted Zulip with self-signed certs:

```json
{
  "tlsRejectUnauthorized": false
}
```

⚠️ Only use this for development/testing!

## Cost Savings

Same as Discord:

- **Before**: Every message = Anthropic API call = ~$0.015
- **After**: Uses Claude CLI subprocess = **$0** (Claude Code license)
- For 1000 messages/month: **Save ~$15/month**

## Advanced: Multiple Zulip Organizations

To connect to multiple Zulip organizations:

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "accounts": {
        "work": {
          "botEmail": "bot@work.zulipchat.com",
          "botApiKey": "work-key",
          "baseUrl": "https://work.zulipchat.com"
        },
        "community": {
          "botEmail": "bot@community.zulipchat.com",
          "botApiKey": "community-key",
          "baseUrl": "https://community.zulipchat.com"
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "zulip",
        "accountId": "work"
      }
    },
    {
      "agentId": "support",
      "match": {
        "channel": "zulip",
        "accountId": "community"
      }
    }
  ]
}
```
