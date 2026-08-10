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

`./data` is mounted at `/app/data`. It holds the SQLite mapping database, Instagram session, bridge config, and logs. Back it up while the container is stopped:

```sh
D=/share/CACHEDEV2_DATA/.qpkg/container-station/usr/bin/docker
$D -H unix:///var/run/docker.sock stop ig2tg
tar -C /share/docker -czf /share/docker/ig2tg-backup-$(date +%F).tgz ig2tg/data
$D -H unix:///var/run/docker.sock start ig2tg
```

The `.env` file contains the Telegram bot token; store it separately with permissions `0600`.

## Intentional update procedure

1. Review upstream changes and select a commit deliberately.
2. Merge/cherry-pick it into this fork and run the local checks.
3. Back up `data`.
4. Update `compose.yaml`'s immutable image tag to the selected fork commit.
5. On the QNAP: `git pull --ff-only`, then manually run `compose build --pull=false` and `compose up -d --force-recreate`.
6. Verify `/status` in Telegram and inspect the container log.

For rollback, check out the previous reviewed fork commit, restore its image tag in `compose.yaml`, and rebuild. The persistent `data` directory is retained.
