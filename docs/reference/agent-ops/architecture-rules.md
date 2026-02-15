---
title: Architecture Rules
description: Module boundary and dependency direction rules enforced by pnpm check:arch
---

# Architecture Rules

Mechanically enforced via `pnpm check:arch` (runs in CI). Violations block merge.

## Rule 1: No Cross-Provider Imports

Channel providers must not import from sibling channel providers.

**Provider directories:**

```
src/telegram/   src/discord/   src/slack/
src/signal/     src/imessage/  src/whatsapp/  src/line/
```

Each provider can import from core modules but never from another provider.

```
src/telegram/bot.ts  →  src/channels/types.ts    ✅ OK (core module)
src/telegram/bot.ts  →  src/discord/accounts.ts  ❌ VIOLATION
```

**How to fix:** Move shared logic to `src/channels/`, `src/shared/`, or `src/types/`.

## Rule 2: Dependency Direction

Protected core modules must not import from channel providers. Dependencies flow inward: providers → core, never core → providers.

**Protected core directories:**

```
src/routing/   src/types/   src/shared/   src/media/
```

```
src/routing/resolve.ts  →  src/types/message.ts      ✅ OK (core → core)
src/telegram/send.ts    →  src/routing/resolve.ts     ✅ OK (provider → core)
src/routing/resolve.ts  →  src/telegram/accounts.ts   ❌ VIOLATION
```

**How to fix:** Inject the dependency via a function parameter or interface. See `src/cli/deps.ts` for the established DI pattern.

## Dependency Direction Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Channel Providers                     │
│  telegram/  discord/  slack/  signal/  imessage/  ...   │
│                    ↓ (imports from)                      │
├─────────────────────────────────────────────────────────┤
│                     Hub Layer                            │
│  channels/dock  cli/deps  plugin-sdk/  plugins/runtime  │
│                    ↓                                     │
├─────────────────────────────────────────────────────────┤
│                   Protected Core                         │
│         routing/  types/  shared/  media/                │
└─────────────────────────────────────────────────────────┘

Arrows show allowed import direction (top → bottom only).
No horizontal arrows between providers.
```

## Exempt Paths

These files/directories are architecturally required to import from providers and are excluded from the dependency direction rule:

| Path                                 | Reason                                                          |
| ------------------------------------ | --------------------------------------------------------------- |
| `src/channels/`                      | Channel registry (`dock.ts`) + plugin bridge layer (`plugins/`) |
| `src/cli/deps.ts`                    | DI boundary — type-only imports for dependency injection        |
| `src/plugin-sdk/`                    | SDK surface — re-exports provider types for external plugins    |
| `src/plugins/`                       | Plugin runtime — needs all provider implementations             |
| `src/infra/outbound/`                | Outbound delivery hub — dispatches to provider send functions   |
| `src/gateway/server-http.ts`         | Slack HTTP handler registration                                 |
| `src/auto-reply/templating.ts`       | StickerMetadata type from telegram                              |
| `src/tts/`                           | `stripMarkdown` utility from line                               |
| `src/config/types.discord.ts`        | DiscordPluralKitConfig type                                     |
| `src/commands/doctor-config-flow.ts` | Telegram account resolution for doctor command                  |
| `src/test-utils/`                    | Test utilities need provider types                              |
| `src/agents/tools/`                  | Agent tools for specific providers                              |
| `src/agents/pi-embedded-runner/`     | Embedded runner reaction levels                                 |

## Adding New Exceptions

If you need to add a new exemption:

1. First consider whether the dependency can be inverted (DI pattern in `src/cli/deps.ts`)
2. If exemption is truly needed, add the path to `EXEMPT_PATHS` in `scripts/check-architecture.ts`
3. Add a comment explaining why
4. The harness audit tracks exception count — growth triggers a WARN

## Error Messages

When the linter catches a violation, it outputs:

```
VIOLATION: Module boundary crossed
  File:   src/telegram/bot.ts:14
  Import: from "../discord/accounts.js"
  Rule:   Channel providers must not import from other channel providers.
  Fix:    Move shared logic to src/channels/ or src/shared/.
          For types, move to src/types/.
```

The fix instructions tell you exactly what to do. Follow them.
