# Deploying ig2tg to k3s

Step-by-step guide to run ig2tg on a local k3s cluster.

---

## Prerequisites

- A running k3s cluster with `kubectl` configured
- Docker installed locally (to build the image)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram supergroup with **Topics** enabled and your bot added as admin

## 1. Build the Docker image

From the repo root:

```bash
docker build -t ig2tg:latest .
```

This produces a ~375MB Alpine image with Node.js 22 and ffmpeg (for voice note conversion).

## 2. Import the image into k3s

k3s uses containerd, not Docker, so the image needs to be imported:

```bash
docker save ig2tg:latest | sudo k3s ctr images import -
```

Verify it's available:

```bash
sudo k3s crictl images | grep ig2tg
```

## 3. Edit the manifests

All Kubernetes manifests live in `deploy/`. You need to edit two files before applying.

### Secret — `deploy/secret.yaml`

Replace the `CHANGEME` value with your Telegram bot token:

```yaml
stringData:
  TG_BOT_TOKEN: "123456:ABC-your-actual-bot-token"
```

### Config — `deploy/configmap.yaml`

Edit the `config.yaml` block inside the ConfigMap:

```yaml
telegram:
  bot_token: "${env:TG_BOT_TOKEN}"   # leave as-is, resolved from Secret
  supergroup_id: -1001234567890       # ← your supergroup's chat ID
  owner_id: 123456789                # ← your Telegram user ID
```

**How to get these values:**

- **supergroup_id**: Add [@RawDataBot](https://t.me/RawDataBot) to your supergroup, it will print the chat ID (starts with `-100`). Remove the bot after.
- **owner_id**: Message [@userinfobot](https://t.me/userinfobot) on Telegram, it replies with your user ID.

## 4. Deploy

Apply everything at once with kustomize:

```bash
kubectl apply -k deploy/
```

This creates:

| Resource | Name | Purpose |
|---|---|---|
| Namespace | `ig2tg` | Isolates all resources |
| Secret | `ig2tg-secrets` | TG bot token |
| ConfigMap | `ig2tg-config` | Bridge config.yaml |
| PVC | `ig2tg-data` | 1Gi volume for SQLite + session data |
| Deployment | `ig2tg` | Single-replica pod running the bridge |

## 5. Verify it's running

```bash
# Check pod status
kubectl -n ig2tg get pods

# Watch logs
kubectl -n ig2tg logs -f deployment/ig2tg

# You should see:
# [bridge:main] Config loaded
# [bridge:main] No saved session. Use /login in the Telegram supergroup to connect Instagram.
# [bridge:main] Starting Telegram bot polling...
# [bridge:main] Bridge is running. Press Ctrl+C to stop.
```

## 6. Connect Instagram

Open the supergroup's **General** topic and send:

```
/login your_ig_username your_ig_password
```

The message is automatically deleted for security. If your account has 2FA enabled, the bot will reply asking for a code:

```
/2fa 123456
```

This is a one-time step. The session is saved to the PVC and survives pod restarts.

## 7. Test the bridge

1. Send a DM to your Instagram account from another account
2. A new forum topic should appear in your Telegram supergroup
3. Reply in that topic — the message should arrive on Instagram

## Updating

After code changes:

```bash
docker build -t ig2tg:latest .
docker save ig2tg:latest | sudo k3s ctr images import -
kubectl -n ig2tg rollout restart deployment/ig2tg
```

The pod will auto-reconnect to Instagram using the saved session — no need to `/login` again.

## Updating config

Edit the ConfigMap and restart:

```bash
kubectl -n ig2tg edit configmap ig2tg-config
kubectl -n ig2tg rollout restart deployment/ig2tg
```

Or edit `deploy/configmap.yaml` and re-apply:

```bash
kubectl apply -k deploy/
kubectl -n ig2tg rollout restart deployment/ig2tg
```

## Backing up data

The SQLite database and Instagram session are stored on the PVC. To back up:

```bash
# Find the pod name
POD=$(kubectl -n ig2tg get pod -l app=ig2tg -o jsonpath='{.items[0].metadata.name}')

# Copy data out
kubectl -n ig2tg cp "$POD:/app/data" ./backup
```

## Uninstalling

```bash
kubectl delete -k deploy/
```

This removes everything including the PVC. Back up your data first if you need it.

## Troubleshooting

### Pod is in CrashLoopBackOff

Check logs:

```bash
kubectl -n ig2tg logs deployment/ig2tg --previous
```

Common causes:
- **"Environment variable TG_BOT_TOKEN is not set"** — the Secret isn't mounted correctly. Check `kubectl -n ig2tg describe pod`.
- **Config parse error** — invalid YAML in the ConfigMap.

### Instagram session expires

Instagram invalidates sessions periodically. When this happens the bridge will log a warning and stop forwarding messages, but the pod stays running. Just send `/login` again in the General topic to re-authenticate.

### Image not found

If the pod shows `ErrImagePull`, the image wasn't imported into k3s:

```bash
docker save ig2tg:latest | sudo k3s ctr images import -
```

The Deployment uses `imagePullPolicy: IfNotPresent` so it won't try to pull from a registry.

### PVC stuck in Pending

k3s ships with the `local-path` storage class. If your cluster uses a different one, edit `deploy/pvc.yaml`:

```yaml
storageClassName: your-storage-class
```
