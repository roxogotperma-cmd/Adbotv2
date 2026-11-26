# Telegram AdBot — main bot + update bot + userbot ads (Node.js)

## Quick start (Render)
1. @BotFather: make 2 bots (main + update).
2. Make a PRIVATE channel, add the MAIN bot as admin (post / edit / pin). Its id (-100...) = DB_CHANNEL_ID.
3. my.telegram.org -> API_ID / API_HASH.
4. Push this folder to GitHub -> Render "New Web Service" (render.yaml included) or:
   Build `npm install`   Start `npm start`
5. Fill env vars (see .env.example). ENC_KEY: long random text, NEVER change it later.
6. Open both bots and press /start.

## Local run
cp .env.example .env  (fill it) -> npm install -> npm start

## Tests (offline, 21 tests, no tokens/network)
npm test

## Admin commands
/admin /stats /bdc /premium id|@u 1|7|30|lifetime /remove id|@u /ban /unban /info /addadmin /rmadmin /emojiid

## Notes
- Edit emoji.js to change premium emoji (normal emoji = premium id), then redeploy.
- Data lives in memory, saved every 60s to data/db.json and to the DB channel (one pinned file, edited in place),
  and reloaded from the channel on every boot. Sessions are AES-256-GCM encrypted.
- Use secondary accounts for ads; heavy automated posting can get accounts limited.

## Ad
Set Ad -> user just sends the text (or photo/video/GIF/file + caption). Formatting & premium emoji are kept.
Forwarding a public channel post also works (bot forwards it, falls back to a normal post if forwarding is blocked).

## All limits are env variables
See .env.example (FREE_DAILY, FREE_GROUPS, FREE_ACCOUNTS, PREMIUM_*, *_TIMERS, GROUP_DELAY_MS ...).
/admin -> Limits can override them live; "Reset all to env values" brings env back.

## Flow
/start -> Add Account -> Phone Login -> number -> code (1 2 3 4 5) -> [2FA] -> added -> Set Ad -> Start.
The menu opens ONLY with /start.
