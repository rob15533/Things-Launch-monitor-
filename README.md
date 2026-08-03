# Things Market Real-Time Launch Monitor

This is an always-on listener for every transaction that mentions the Things Market Solana program:

`Dd9cWDgPA3hYKUzSbcmvXbaDStWd55TZ9pPakd7x3Tun`

It uses Solana `logsSubscribe` over WebSocket for live detection. It then fetches each transaction and only alerts when the transaction initializes a new SPL token mint.

## Why it is designed not to miss launches

- Live WebSocket listener for immediate alerts.
- Automatic reconnect when the WebSocket drops.
- Historical catch-up using `getSignaturesForAddress` after startup and reconnect.
- Local persistent state to avoid duplicate alerts.
- Retries while a newly confirmed transaction becomes available through RPC.
- Filters out swaps and ordinary trades.

No internet service can honestly guarantee 100% delivery if every RPC provider is unavailable, but the live listener plus catch-up mechanism is designed to recover launches that occur during brief disconnections.

## Telegram setup

1. In Telegram, message `@BotFather`.
2. Send `/newbot` and follow its prompts.
3. Save the bot token privately.
4. Open the bot you created, press **Start**, and send it `hi`.
5. In Safari or Chrome, visit:

   `https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates`

6. Find `"chat":{"id":...}` and copy that number as your chat ID.

Never upload your real token to GitHub.

## Run on a computer

Install Node.js 20 or newer, then:

```bash
npm install
cp .env.example .env
```

Enter your Telegram bot token and chat ID in `.env`, then load the variables and start:

### Mac/Linux

```bash
set -a
source .env
set +a
npm start
```

### Windows PowerShell

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
npm start
```

## Recommended always-on deployment

Use an always-on service that supports:

- A Node.js process or Docker container
- Persistent disk mounted at `/app/data`
- Environment variables/secrets
- Outbound WebSocket connections

Deploy the repository or Dockerfile, add the environment variables from `.env.example`, and mount a small persistent disk at `/app/data`.

Required secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Recommended RPC variables:

- `RPC_HTTP_URL`
- `RPC_WS_URL`

The public Solana RPC may rate-limit or disconnect. For better reliability, use matching HTTP and WebSocket endpoints from a dedicated Solana RPC provider.

Optional:

- `HELIUS_API_KEY` adds token name, symbol, and image when available.
- Without it, alerts still include the mint and links.

## First startup behavior

The first run records the current newest transaction and does not send alerts for historical launches. Every later launch is processed live or recovered during catch-up.

## Telegram alert contents

- Token name and ticker when metadata is available
- Image when metadata is available
- Mint address
- Creator wallet
- Launch time
- Things Market link
- Solscan token and transaction links