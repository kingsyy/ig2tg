---
intent: tool
stage: working
share_target: working
next: "Run QNAP acceptance tests, then build and recreate"
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
The deployed commit (`437436f`) works but fails silently in three ways, all now addressed on
`feat/reliability-and-replies`:

- MQTT disconnects left the bridge at status `error` with no reconnect and no recovery of messages
  delivered during the gap. There is now a bounded reconnect loop and a bounded missed-message check.
- Outgoing Telegram messages were sent straight through with no record. They are now persisted in
  `outbound_queue` before Instagram is contacted, retried on transient failures, and kept visible and
  retryable (`/retry`) across container restarts.
- Telegram replies became ordinary Instagram messages. They now become native replies when the
  bridge has a mapping, and fall back to an ordinary send when it does not.

Also in this branch: disappearing media gets an explicit "Open Instagram" notice and is never
fetched; messages sent from the Instagram app are mirrored into Telegram as "📤 You: …"; `/status`
reports session, realtime, last check, and queue depth separately; and no message text or credential
reaches the logs. 106 tests pass, type-check and build are clean.

**Not yet deployed.** The branch is pushed and reviewed but the QNAP still runs the old commit, and
the manual acceptance tests need a secondary Instagram account and a person.

## Next
- Back up `/share/docker/ig2tg/data` with the container stopped (WAL sidecars included).
- Check out the branch on the QNAP, `compose build --pull=false`, `compose up -d --force-recreate`.
- Work the acceptance checklist in `QNAP-DEPLOY.md`, especially the simulated outage and the
  failed-send-survives-restart case.
