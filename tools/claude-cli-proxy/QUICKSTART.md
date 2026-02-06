# Claude CLI Proxy - Quick Start

**Status**: ✅ Working in Discord, ready for Zulip

## What We Built

A streaming proxy that uses Claude CLI as a subprocess, eliminating API costs for OpenClaw bots.

## Current Setup

### ✅ Discord (Working)

- Proxy running on `http://127.0.0.1:11435`
- Using Opus 4.6 model
- Zero API costs (Claude CLI subprocess)
- Config in `~/.openclaw/openclaw.json`

### 📋 Zulip (Ready to Configure)

See [ZULIP_SETUP.md](ZULIP_SETUP.md) for complete instructions.

**Quick steps:**

1. Get Zulip bot credentials (site URL, email, API key)
2. Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "zulip": {}
    }
  },
  "channels": {
    "zulip": {
      "enabled": true,
      "botEmail": "your-bot@your-org.zulipchat.com",
      "botApiKey": "your-api-key",
      "baseUrl": "https://your-org.zulipchat.com",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

3. Restart gateway: `openclaw gateway stop && openclaw gateway start`
4. Test: `@**YourBot** hello world`

## Files in This Repo

- **server.mjs** - The streaming proxy implementation
- **README.md** - Complete technical documentation
- **SETUP.md** - Original setup guide with troubleshooting
- **ZULIP_SETUP.md** - Zulip-specific configuration
- **QUICKSTART.md** - This file

## Preservation Strategy

✅ **Version Controlled**: All proxy code and docs in `tools/claude-cli-proxy/`

✅ **Config Persists**: `~/.openclaw/openclaw.json` survives OpenClaw updates

✅ **Proxy Isolated**: Proxy runs from `~/scripts/` (outside openclaw directory)

### After OpenClaw Updates

1. Verify proxy config still exists in `~/.openclaw/openclaw.json`
2. Restart gateway if needed
3. Test with a message

## Cost Savings

- **Before**: ~$0.015 per message (Anthropic API)
- **After**: $0 per message (Claude CLI subprocess)
- **Monthly**: Save ~$15 per 1000 messages

## Next Steps

1. ✅ Push to GitHub to back up these changes
2. Configure Zulip if needed (see ZULIP_SETUP.md)
3. Test both Discord and Zulip

## Support

If something breaks after an update:

1. Check proxy is running: `curl http://127.0.0.1:11435/v1/models`
2. Check config: `cat ~/.openclaw/openclaw.json | grep -A 20 openai`
3. Restart proxy: `pkill -f claude-cli-proxy && node ~/scripts/claude-cli-proxy-streaming.mjs &`
4. Restart gateway: `openclaw gateway stop && openclaw gateway start`

## Documentation

- [README.md](README.md) - Full technical details
- [SETUP.md](SETUP.md) - Original setup walkthrough
- [ZULIP_SETUP.md](ZULIP_SETUP.md) - Zulip configuration
