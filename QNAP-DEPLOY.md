# QNAP deployment (manual, pinned updates)

This deployment is deliberately **not automatically updated**:

- Container Station runs the local-only image tag `ig2tg:manual-pinned`; the checked-out Git commit is the reviewed source version.
- There is no Watchtower, `latest` tag, scheduled pull, or automated Git sync.
- The app starts only when you manually build and recreate the container.

## First deployment

On the QNAP, deploy this repository at `/share/docker/ig2tg`:

```sh
cd /share/docker/ig2tg
cp .env.example .env
chmod 600 .env
# Edit .env with the Telegram bot token, forum-enabled supergroup ID, and owner ID.
```

Build and start through Container Station's Compose interface, or with its bundled Docker CLI:

```sh
D=/share/CACHEDEV2_DATA/.qpkg/container-station/usr/bin/docker
$D -H unix:///var/run/docker.sock compose build --pull=false
$D -H unix:///var/run/docker.sock compose up -d --force-recreate
$D -H unix:///var/run/docker.sock logs --tail=100 ig2tg
```

After it starts, send `/login <instagram-username> <instagram-password>` in the Telegram supergroup's **General** topic. Complete `/2fa <code>` there if prompted, then run `/status`.

## Persistence and backup

`./data` is mounted at `/app/data`. It holds the SQLite mapping database, Instagram session, bridge config, and logs.

The database runs in WAL mode, so `bridge.sqlite` on its own is **not** a
complete copy — the most recent writes live in `bridge.sqlite-wal`. Stop the
container first so SQLite checkpoints and the whole directory is consistent:

```sh
D=/share/CACHEDEV2_DATA/.qpkg/container-station/usr/bin/docker
$D -H unix:///var/run/docker.sock stop ig2tg
tar -C /share/docker -czf /share/docker/ig2tg-backup-$(date +%F).tgz ig2tg/data
$D -H unix:///var/run/docker.sock start ig2tg
```

Verify the archive contains the database *and* its sidecars before relying on it:

```sh
tar -tzf /share/docker/ig2tg-backup-$(date +%F).tgz | grep bridge.sqlite
```

To back up without stopping the bridge, use SQLite's online backup rather than
copying the file — never copy `bridge.sqlite` while ignoring `-wal` and `-shm`:

```sh
sqlite3 /share/docker/ig2tg/data/bridge.sqlite ".backup '/share/docker/ig2tg-bridge-$(date +%F).sqlite'"
```

The `.env` file contains the Telegram bot token; store it separately with permissions `0600`.

Keep `DEBUG` unset in `.env`. Setting it makes the Instagram library write full
request and response bodies — message text and session cookies — into the log
files on this volume.

## Intentional update procedure

1. Review the change and select a commit deliberately.
2. Run the local checks in the fork: `npm run check` (type-check + test suite),
   then `npm run build`.
3. Review the diff for message-body or credential logging.
4. Back up `data` as above, and keep the previous checkout for rollback.
5. Update `compose.yaml`'s immutable image tag if it is being pinned to a new
   fork commit.
6. On the QNAP: `git fetch && git checkout <commit>`, then manually run
   `compose build --pull=false` and `compose up -d --force-recreate`.
7. Inspect a bounded slice of the log: `$D logs --tail=100 ig2tg`.
8. Verify `/status` in Telegram, then run the acceptance checks below.

For rollback, check out the previous reviewed fork commit, restore its image tag in `compose.yaml`, and rebuild. The persistent `data` directory is retained.

Database migrations are idempotent and additive, so a rollback to the previous
commit works against the migrated database without restoring the backup. Restore
the backup only if the data itself is wrong.

## Post-deployment acceptance checks

Use a secondary Instagram account. These need a person; they are not automated.

1. Send an ordinary Instagram text — it reaches the right Telegram topic.
2. Reply in Telegram — Instagram shows a native reply, not a loose message.
3. Send a one-time photo — Telegram shows only
   "📷 You received a disappearing photo or video. Open Instagram to view it."
4. Send a message from the Instagram app yourself — Telegram shows it as
   "📤 You: …", exactly once.
5. `/status` reports `connected` while healthy.
6. Break connectivity (e.g. `$D network disconnect bridge ig2tg`), confirm
   `/status` shows `reconnecting` or `error` and that a disconnect warning arrives
   in the General topic after ~45s. Send a message from the other account during
   the outage. Restore connectivity and confirm the reconnect notice, the
   missed-message check notice, and the message itself all arrive.
7. Simulate an Instagram send failure (e.g. `/logout`, then send in a topic):
   the Telegram message stays visible, a "❌ Not delivered to Instagram" notice
   appears, and `/status` counts one failed outgoing message.
8. Restart the container (`compose up -d --force-recreate`) and confirm `/status`
   still counts that failed message.
9. Log in again and reply `/retry` to the failure notice — it is delivered once,
   and "✅ Delivered to Instagram after retry" appears.
10. Confirm the log contains no message text:

    ```sh
    $D -H unix:///var/run/docker.sock logs --tail=500 ig2tg | grep -iE "text=|password|sessionid"
    ```

    Only `content_type=text` style metadata should match.
