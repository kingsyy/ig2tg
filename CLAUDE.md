# CLAUDE.md

## Project overview

ig2tg bridges Instagram DMs to Telegram via forum topics. It uses Instagram's MQTT protocol for real-time messaging and the Telegram Bot API (grammY) for the Telegram side, with SQLite for thread/message mapping.

## Code layout

- `source/bridge/` — **Our code.** The Telegram bot, message router, media handler, database layer, config loader, and entry point.
- `source/client.ts`, `source/session.ts`, `source/config.ts`, `source/types/instagram.ts`, `source/utils/message-parser.ts`, `source/utils/logger.ts` — **Derived from upstream** (`supreme-gg-gg/instagram-cli`). These files handle all Instagram API interaction.
- `patches/` — Patches to `instagram-private-api` applied via `patch-package` on `npm install`.

## Build & run

```bash
npm install          # installs deps + applies patches
npm run build        # tsc → dist/
npm start            # node dist/bridge/index.js
npm run dev          # tsx source/bridge/index.ts (no build step)
npx tsc --noEmit     # type-check only
```

## Key conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions even for `.ts` files.
- The bridge only processes messages from `config.telegram.owner_id` (one-user bridge, not multi-tenant).
- Echo prevention relies on `message_log` table: every forwarded message is logged. The router checks this table before forwarding to prevent infinite IG→TG→IG loops and to assure exactly-once read of the events from MQTT.
- Media is downloaded to in-memory buffers, never to disk temp files.
- `config.yaml` supports `${env:VAR_NAME}` for secrets. Never commit credentials.
- Instagram credentials are NOT in config — the user logs in via `/login` bot command in the Telegram General topic. The message is auto-deleted. Session is persisted and auto-restored on restart.

## Upstream sync workflow

The Instagram client files are extracted from https://github.com/supreme-gg-gg/instagram-cli. When Instagram changes their API or the upstream repo ships fixes, sync using this process:

### Adding the upstream remote (one-time)

```bash
git remote add upstream https://github.com/supreme-gg-gg/instagram-cli.git
git fetch upstream
```

### Syncing changes

The files we track from upstream are:

| Our path | Upstream path |
|---|---|
| `source/client.ts` | `source/client.ts` |
| `source/session.ts` | `source/session.ts` |
| `source/types/instagram.ts` | `source/types/instagram.ts` |
| `source/utils/message-parser.ts` | `source/utils/message-parser.ts` |
| `source/utils/logger.ts` | `source/utils/logger.ts` |
| `patches/` | `patches/` |

**`source/config.ts` is NOT synced** — we simplified it (removed TUI settings). Sync manually if upstream changes config structure.

### Steps to sync

1. `git fetch upstream`
2. Check upstream changes: `git log --oneline upstream/main -- source/client.ts source/session.ts source/types/instagram.ts source/utils/message-parser.ts source/utils/logger.ts patches/`
3. For each relevant commit, get the diff: `git show <commit> -- <file>`
4. Apply changes to our copies manually (or via cherry-pick if paths match).
5. After applying upstream changes to `client.ts`, re-apply our modifications:
   - We removed: `Fuse` import + `searchThreadsByTitle`/`searchThreadByUsername` methods, all Story/Reels methods (`getReelsTray`, `getStoriesForUser`, `markStoriesAsSeen`, `mapStoryItem`), `cleanupSessions`/`cleanupCache`/`cleanupLogs` static methods, `switchUser`, `logout`, `ensureThread` methods.
   - We added: `getUserId()`, `getUserCache()`, Buffer-based `sendPhoto(threadId, buffer)`, `sendVideo(threadId, buffer)`, `sendVoice(threadId, buffer)`, in-memory `downloadMedia(url): Buffer`.
   - We changed: `sendPhoto`/`sendVideo` signatures from file-path-based to Buffer-based.
6. Run `npx tsc --noEmit` to verify no type errors.
7. Test with `npm run dev`.

### Resolving conflicts

When upstream changes conflict with our modifications to `client.ts`:

- **New methods added upstream**: Keep them if useful for the bridge, drop them if they're TUI-only (anything referencing Ink, React, Fuse.js, sharp, or terminal rendering).
- **Changed method signatures**: Adapt our bridge code in `source/bridge/` to match. The bridge files are ours and can change freely.
- **New dependencies added upstream**: Only add them if our kept files actually import them. Check with `grep -r "from '" source/client.ts source/session.ts source/utils/ source/types/`.
- **New patches in `patches/`**: Copy them over and run `npm install` to apply.

### What to never sync

- `source/cli.ts`, `source/commands/`, `source/ui/`, `source/mocks/` — TUI code, we don't have it.
- `source/types/ui.ts` — TUI types.
- `source/utils/` files other than `message-parser.ts` and `logger.ts` — TUI utilities (emoji picker, autocomplete, mouse, etc.).

## Database schema

Two tables in `data/bridge.sqlite`:

- `thread_map` — maps `ig_thread_id` ↔ `tg_topic_id`, stores contact username/name.
- `message_log` — maps `ig_message_id` ↔ `tg_message_id`, used for dedup and echo prevention.

Migrations run automatically on startup in `source/bridge/db.ts`.
