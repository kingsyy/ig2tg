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

## Two things about this NAS that will trip you up

**There is no `git` on the QNAP.** `/share/docker/ig2tg` is a plain file copy, not
a checkout. The deployed revision is recorded in the `DEPLOYED_COMMIT` file, which
you update by hand. Transfer the source with `rsync` from the reviewed clone.

**The default `HOME` for this account is not writable**, so `docker compose build`
fails with `mkdir …/container-station/homes/jvrooijen: permission denied`. Override
`HOME` and `DOCKER_CONFIG` for build and compose commands, as shown below.

## Intentional update procedure

1. Review the change and select a commit deliberately.
2. Run the checks in the reviewed clone: `npm run check` (type-check + tests),
   then `npm run build`.
3. Review the diff for message-body or credential logging.
4. Back up `data` as above.
5. Keep the current source for rollback, and tag the currently-running image so a
   rollback does not require a rebuild:

   ```sh
   D=/share/CACHEDEV2_DATA/.qpkg/container-station/usr/bin/docker
   S="-H unix:///var/run/docker.sock"
   mkdir -p /share/docker/ig2tg-source-$(cat /share/docker/ig2tg/DEPLOYED_COMMIT | cut -c1-7)
   rsync -a --exclude data/ /share/docker/ig2tg/ /share/docker/ig2tg-source-$(cat /share/docker/ig2tg/DEPLOYED_COMMIT | cut -c1-7)/
   $D $S tag "$($D $S inspect ig2tg --format '{{.Image}}')" ig2tg:rollback-$(cat /share/docker/ig2tg/DEPLOYED_COMMIT | cut -c1-7)
   ```

6. From the reviewed clone on your workstation, sync the source. `--delete` keeps
   the NAS free of stale files; the excludes protect `.env`, the data volume, and
   `DEPLOYED_COMMIT`:

   ```sh
   rsync -a --delete \
     --exclude '.git' --exclude '.claude/' --exclude 'node_modules' \
     --exclude 'dist/' --exclude 'data/' --exclude '.env' --exclude 'DEPLOYED_COMMIT' \
     -e 'ssh -p 12344' ./ jvrooijen@qnap:/share/docker/ig2tg/
   ```

7. Build. This does not touch the running container — it keeps running from the
   image it started with, by ID, even though the tag now points elsewhere:

   ```sh
   cd /share/docker/ig2tg
   # Deliberately outside the deployment directory: the rsync in step 6 uses
   # --delete and would wipe buildx state kept inside it.
   export HOME=/share/docker/.ig2tg-buildhome
   export DOCKER_CONFIG=$HOME/.docker
   mkdir -p "$DOCKER_CONFIG"
   $D $S compose build --pull=false
   ```

8. Recreate, then record the new revision:

   ```sh
   $D $S compose up -d --force-recreate
   printf '%s\n' "<full-commit-sha>" > /share/docker/ig2tg/DEPLOYED_COMMIT
   ```

9. Inspect a bounded slice of the log: `$D $S logs --tail=100 ig2tg`. A healthy
   start logs the migrations, `Auto-logged in as @…`, `Bridge is running`, and a
   `Reconciliation complete: …` line.
10. Verify `/status` in Telegram, then run the acceptance checks below.

### Rollback

```sh
$D $S tag ig2tg:rollback-<short-sha> ig2tg:manual-pinned
rsync -a /share/docker/ig2tg-source-<short-sha>/ /share/docker/ig2tg/
$D $S compose up -d --force-recreate
```

Database migrations are additive and idempotent, so the old code runs against the
migrated database without restoring the backup — the extra columns and tables are
simply ignored. Restore the data backup only if the data itself is wrong.

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
