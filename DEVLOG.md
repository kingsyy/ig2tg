# DEVLOG

## 2026-08-12 · Reliability pass: reconnect, reconciliation, durable outbound, native replies
**What:** Added an application-owned MQTT reconnect loop with bounded backoff, bounded
missed-message reconciliation (post-reconnect, on startup, and via `/sync`), a durable
`outbound_queue` table with bounded retries and `/retry`, native Instagram replies via a stored
item ID, an explicit disappearing-media notice, mirroring of self-sent Instagram messages, and a
106-test `node:test` suite. Also closed several message-body/credential logging leaks.

**Why:**
- *Reconnection is ours, not the library's.* `instagram_mqtt` defaults `autoReconnect` to true, but
  its reconnects don't re-fetch iris data or tell the bridge anything, and production sat at status
  `error` through seven `ClientDisconnectedError` events. Disabling it and owning the loop means
  every reconnect also re-subscribes and triggers a gap check. Rejected: leaving library
  auto-reconnect and only fixing the status reporting — that would still lose the messages
  delivered during the gap.
- *Inbound durability via reconciliation, not an inbound queue.* A failed inbound forward is simply
  not written to `message_log`, so it stays discoverable. Rejected an inbound retry table: it would
  duplicate what `message_log` + a bounded thread scan already give us, for a personal bridge.
- *`RealtimeClient` is constructed directly instead of via `withRealtime()`.* `withRealtime` uses
  `Object.defineProperty` without `configurable: true`, so calling it a second time on the same
  `IgApiClient` throws `Cannot redefine property`. Reconnect would have crashed.
- *Text sends bypass `entity.broadcastText()` and call `directThread.broadcast()` directly.* That is
  the only way to supply our own `client_context`, which is the idempotency token that makes a retry
  after a mid-send crash safe. Cost: a message containing a URL is no longer converted to a link
  item. Instagram still renders it as a tappable link, so this was judged an acceptable trade.
  Rejected: extending `patches/instagram-private-api+1.46.1.patch` — more sync burden for a cosmetic
  gain.
- *Reversible Instagram item IDs are now stored.* `message_log.ig_message_id` is a SHA-256 hash and
  native replies need the real ID, which a hash cannot recover. Added `ig_item_id` alongside the hash
  rather than un-hashing: dedup keeps working and rows migrated from the old schema simply have a
  null `ig_item_id` (they can't be reply targets). Message bodies are still never stored for this.
- *Self-sent messages are mirrored (Arthur asked for it mid-session).* The `ig_self_to_tg` path
  existed but was commented out, presumably because echo detection was a 60s-per-thread time window.
  Now the bridge chooses the `client_context` for text sends and matches the echo exactly, so
  mirroring is safe. Photo/video/voice still fall back to the time window (Instagram's upload flow
  gives us no control over `client_context` there), narrowed to 45s.
- *Warnings are held for 45s before being sent.* Notifying on every MQTT error would have produced
  seven notifications on Aug 11. One per real outage; blips that self-heal stay silent.

**Also fixed, unprompted but in scope:** `utils/logger.ts` called `debugModule.enable('ig:*')`
unconditionally, piping every Instagram request and response — message text, media URLs, session
cookies — into the log file on the persistent volume. It is now strictly opt-in via `DEBUG`. And
`bridge/logger.ts` wrote `debug` lines to that file regardless of the configured log level. The
30-character text preview named in the handoff was the smallest of the three leaks.

**Next:** Manual acceptance tests on the QNAP against a secondary Instagram account (checklist in
`QNAP-DEPLOY.md`), then build and recreate the container.
