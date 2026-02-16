---
name: keep
description: Save, search, and manage bookmarks in your Obsidian vault.
homepage: http://localhost:3377
metadata: { "openclaw": { "emoji": "📑", "requires": { "bins": ["node", "curl"] } } }
---

# Lionroot Keep

Self-hosted bookmark-to-markdown engine. Saves URLs as clean markdown in the Obsidian vault with auto-classification.

## Commands

### Save a URL (server fetches the page)

```bash
curl -s -X POST http://localhost:3377/save-url \
  -H "Content-Type: application/json" \
  -d '{"url":"URL_HERE","source":"agent"}'
```

Returns: `{ ok, title, type, path }`

### Search bookmarks by content or title

```bash
grep -ril "QUERY" ~/Obsidian/Lionroot_Vault/Bookmarks/
```

Or search YAML frontmatter:

```bash
grep -l "^title:.*QUERY" ~/Obsidian/Lionroot_Vault/Bookmarks/*.md
```

### List recent bookmarks

```bash
ls -t ~/Obsidian/Lionroot_Vault/Bookmarks/*.md | head -20
```

### List by type

```bash
grep -l "^type: coding" ~/Obsidian/Lionroot_Vault/Bookmarks/*.md
```

Types: `coding`, `marketing`, `creative`, `strategy`, `infrastructure`, `general`

### Read a bookmark

```bash
cat ~/Obsidian/Lionroot_Vault/Bookmarks/FILENAME.md
```

### Import Chrome bookmarks

```bash
node ~/programming_projects/lionroot-studio/lionroot-keep/import-chrome.js
```

### Check service health

```bash
curl -s http://localhost:3377/health
```

### Start the service

```bash
cd ~/programming_projects/lionroot-studio/lionroot-keep && node server.js
```

## Classification

Bookmarks are auto-classified and routed to agents:

| Type           | Agent  | Emoji |
| -------------- | ------ | ----- |
| coding         | Cody   | 💻    |
| marketing      | Grove  | 📈    |
| creative       | Artie  | 🎨    |
| strategy       | Leo    | 🎯    |
| infrastructure | Archie | 🔧    |
| general        | Clawdy | 🦞    |

## Storage

Markdown files at `~/Obsidian/Lionroot_Vault/Bookmarks/YYYY-MM-DD-slug.md` with YAML frontmatter (title, url, saved, type, tags, source).
