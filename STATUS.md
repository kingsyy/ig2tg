---
intent: tool
stage: working
share_target: working
next: "Run the 10 manual acceptance checks with a second IG account"
blocker: null
updated: 2026-08-12
---

# ig2tg — Instagram DMs bridged into Telegram forum topics

## What it is
A fork of [GYovchev/ig2tg](https://github.com/GYovchev/ig2tg) running on the QNAP as the `ig2tg`
container. Each Instagram DM thread becomes a Telegram forum topic in a private supergroup, so one
personal Instagram connection stays reachable from Telegram without opening the Instagram app.
Updates are deliberately manual — no Watchtower, no `latest` tag, no unattended upstream merges.

## Current state
Deployed and running as `0c11cc5` (branch `feat/reliability-and-replies`). The previous commit
(`437436f`) worked but failed silently in three ways, all now addressed:

- MQTT disconnects left the bridge at status `error` with no reconnect and no recovery of messages
  delivered during the gap. There is now a bounded reconnect loop and a bounded missed-message check.
- Outgoing Telegram messages were sent straight through with no record. They are now persisted in
  `outbound_queue` before Instagram is contacted, retried on transient failures, and kept visible and
  retryable (`/retry`) across container restarts.
- Telegram replies became ordinary Instagram messages. They now become native replies when the
  bridge has a mapping, and fall back to an ordinary send when it does not.

Also live: disappearing media gets an explicit "Open Instagram" notice and is never fetched;
messages sent from the Instagram app are mirrored into Telegram as "📤 You: …"; `/status` reports
session, realtime, last check, and queue depth separately; and no message text or credential
reaches the logs. 106 tests pass; type-check and build are clean.

The first startup on the NAS confirmed the point of the exercise: reconciliation forwarded **6
messages that the old deployment had lost**, skipped 5 it already knew, and failed on none. The new
log file is 15 lines of metadata where the previous one had grown to 2.2 MB containing 27 outgoing
message bodies.

Rollback is one command — `ig2tg:rollback-437436f` is tagged and the old source is at
`/share/docker/ig2tg-source-437436f`. See `QNAP-DEPLOY.md`.

## Next
- Work the 10 manual acceptance checks in `QNAP-DEPLOY.md` with a second Instagram account. The
  reply, disappearing-media, simulated-outage, and failed-send-survives-restart cases are the ones
  automated tests cannot cover.
- Delete the pre-fix log file, which contains outgoing message text:
  `/share/docker/ig2tg/data/.ig2tg/logs/session-2026-08-11_10.log`.
- Decide whether to merge the branch to `master` on the fork now that it is the deployed revision.
