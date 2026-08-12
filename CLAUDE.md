# CLAUDE.md

## Project overview

ig2tg bridges Instagram DMs to Telegram via forum topics. It uses Instagram's MQTT protocol for real-time messaging and the Telegram Bot API (grammY) for the Telegram side, with SQLite for thread/message mapping.

## Code layout

- `source/bridge/` — **Our code.** The Telegram bot, message router, media handler, database layer, config loader, and entry point.
  - `sync.ts` — inbound (IG→TG) routing and outbound (TG→IG) intake.
  - `outbound.ts` — the durable outbound queue: enqueue, classify, retry, worker.
  - `reconcile.ts` — bounded missed-message recovery, and per-thread inbound retries.
  - `connection.ts` — turns realtime state changes into at most one Telegram notice per outage.
  - `health.ts` — bridge liveness state behind `/status`.
  - `notifier.ts` — the operational notice texts and a throttled sender.
- `source/utils/redact.ts` — **Our code.** Safe error description and log-field helpers.
- `source/client.ts`, `source/session.ts`, `source/config.ts`, `source/types/instagram.ts`, `source/utils/message-parser.ts`, `source/utils/logger.ts` — **Derived from upstream** (`supreme-gg-gg/instagram-cli`). These files handle all Instagram API interaction.
- `test/` — **Our code.** `node:test` suites run through `tsx`; `test/helpers.ts` holds the Telegram and Instagram fakes.
- `patches/` — Patches to `instagram-private-api` applied via `patch-package` on `npm install`.

## Build & run

```bash
npm install          # installs deps + applies patches
npm run build        # tsc → dist/
npm start            # node dist/bridge/index.js
npm run dev          # tsx source/bridge/index.ts (no build step)
npm test             # node:test suites via tsx
npm run typecheck    # type-check source and test
npm run check        # typecheck + test — run this before every deployment
```

`better-sqlite3@11` does not build on Node 26. Use Node 20 or 22 locally; the
container is Node 22.

## Key conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions even for `.ts` files.
- The bridge only processes messages from `config.telegram.owner_id` (one-user bridge, not multi-tenant).
- Echo prevention relies on `message_log` table: every forwarded message is logged. The router checks this table before forwarding to prevent infinite IG→TG→IG loops and to assure exactly-once read of the events from MQTT.
- Media is downloaded to in-memory buffers, never to disk temp files.
- `config.yaml` supports `${env:VAR_NAME}` for secrets. Never commit credentials.
- Instagram credentials are NOT in config — the user logs in via `/login` bot command in the Telegram General topic. The message is auto-deleted. Session is persisted and auto-restored on restart.

### Reliability model

The bridge may fail, but it must not fail silently. Three mechanisms carry that:

- **Nothing is logged as delivered until it was.** An inbound message that fails to
  reach Telegram is deliberately *not* written to `message_log`, which is exactly
  what lets reconciliation find it again. Never write a `message_log` row on a
  path where delivery might not have happened.
- **Outbound messages are persisted before Instagram is contacted.** `outbound_queue`
  holds a row from the moment the Telegram update arrives. It is only marked
  `sent` once Instagram returns an item ID. The `client_context` on the row is a
  stable idempotency token reused across retries, so a retry after a mid-send
  crash does not produce a duplicate.
- **The bridge owns MQTT reconnection.** `autoReconnect` is disabled in the
  underlying library so every reconnect re-subscribes with fresh iris data and
  triggers a bounded missed-message check. Reconnect never re-logs in: repeated
  full logins are what trigger Instagram challenges.

### Logging rules

Private messages and credentials pass through this process, so:

- Never log message text, captions, media URLs, or queue payloads — not even a
  short preview.
- Never pass a raw error object or `error.message` to a logger. Instagram and
  grammY errors carry the HTTP request/response body, which for a direct message
  *is* the message text. Use `describeError()` from `source/utils/redact.ts`.
- Identify threads and messages by `logTag(id)`, not by raw Instagram IDs or
  contact usernames.
- `DEBUG` must stay unset in production. Setting it enables the Instagram
  library's request logging, which writes bodies and session cookies into the log
  file on the persistent volume.
- `bridge/logger.ts` drops `debug` output entirely below the configured level,
  rather than only hiding it from the console — otherwise it still reaches disk.

### Disappearing media

One-time photos and videos are announced and never touched: no download, no
forward, no proxy, no marking as viewed, no URL in logs. `parseMessageItem`
detects them before the item-type switch — including the `visual_media` envelope
variant — and returns a placeholder with no `media` field, so the downloadable
media path is unreachable for them.

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

Four tables in `data/bridge.sqlite`:

- `thread_map` — maps `ig_thread_id` ↔ `tg_topic_id`, stores contact username/name.
- `message_log` — maps `ig_message_id` ↔ `tg_message_id`, used for dedup and echo
  prevention. `ig_message_id` is a SHA-256 hash; `ig_item_id` holds the original
  Instagram item ID, which a hash cannot recover and which native replies need.
  Message bodies are never stored here.
- `outbound_queue` — durable state for outgoing messages: `pending` → `sending` →
  `sent` / `failed`, with `attempt_count`, `next_attempt_at`, `last_error`, and the
  stable `client_context`. Text payloads store the text (needed for retry); media
  payloads store a Telegram `file_id`, never bytes.
- `bridge_state` — small key/value store so `/status` survives restarts.

Migrations run automatically on startup in `source/bridge/db.ts` and must stay
**idempotent**: every statement is `IF NOT EXISTS`, guarded by a `migrations`
marker row, or guarded by a `PRAGMA table_info` column check. They run against
the live production database, so no migration may drop or rewrite an existing
`thread_map` or `message_log` row. `test/migrations.test.ts` runs them against a
replica of the pre-change schema and asserts this.
