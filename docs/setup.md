# Telegram Setup Guide

How to get `supergroup_id` and `owner_id` for your `config.yaml`.

---

## owner_id — your Telegram user ID

This is the numeric ID of your personal Telegram account. The bridge uses it to restrict all commands and message forwarding to you only.

1. Open Telegram and search for **@userinfobot**
2. Start a conversation and send any message
3. The bot replies with your account info, including a line like:
   ```
   Id: 123456789
   ```
4. Copy that number into your config:
   ```yaml
   telegram:
     owner_id: 123456789
   ```

**Alternative — @RawDataBot:** Start a chat with **@RawDataBot** and send any message. Look for the `"id"` field inside the `"from"` object.

---

## bot_token — from BotFather

If you haven't created a bot yet:

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts — pick a name and username
4. BotFather replies with a token like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
5. Set it as an environment variable:
   ```bash
   export TG_BOT_TOKEN="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
   ```

**Important:** Disable privacy mode so the bot can read messages in topics:

1. In BotFather, send `/mybots` → select your bot → **Bot Settings** → **Group Privacy** → **Turn off**

Without this, the bot only sees commands — it won't receive messages you type in topics, so TG→IG forwarding won't work.


---

## supergroup_id — your forum-enabled supergroup

This is the numeric chat ID of the Telegram supergroup where the bridge creates forum topics. It's a negative number starting with `-100`.

### Step 1: Create the supergroup

1. Open Telegram → New Group
2. Add at least one member (you can remove them later) — Telegram requires it to create a group
3. Give it a name (e.g. "Instagram Bridge")
4. After creation, open group settings → **Edit** → enable **Topics**

> Enabling Topics converts the group into a supergroup with forum-style threads. This is required — the bridge creates one topic per Instagram contact.

### Step 2: Add your bot as admin

1. Go to group settings → **Administrators** → **Add Administrator**
2. Search for your bot by its username
3. Grant these permissions:
   - **Manage Topics** — to create/close/reopen topics
   - **Post Messages** — to forward messages into topics
   - **Delete Messages** — to auto-delete `/login` messages containing credentials
4. Save

### Step 3: Get the chat ID

1. Open [web.telegram.org](https://web.telegram.org) and navigate to your supergroup
2. Look at the URL — it will be something like:
   ```
   https://web.telegram.org/a/#-1001234567890
   ```
3. The number after `#` is your `supergroup_id`

### Step 4: Add to config

```yaml
telegram:
  bot_token: "${env:TG_BOT_TOKEN}"
  supergroup_id: -1001234567890
  owner_id: 123456789
```
