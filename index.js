import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";

const PROGRAM_ID =
  process.env.PROGRAM_ID ||
  "Dd9cWDgPA3hYKUzSbcmvXbaDStWd55TZ9pPakd7x3Tun";

const RPC_HTTP_URL =
  process.env.RPC_HTTP_URL || "https://api.mainnet-beta.solana.com";

const RPC_WS_URL =
  process.env.RPC_WS_URL || deriveWebSocketUrl(RPC_HTTP_URL);

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");

const STATE_DIR = process.env.STATE_DIR || "./data";
const STATE_FILE = path.join(STATE_DIR, "state.json");
const COMMITMENT = process.env.COMMITMENT || "confirmed";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

let ws;
let reconnectTimer;
let heartbeatTimer;
let subscriptionId;
let shuttingDown = false;
let processing = Promise.resolve();

await fs.mkdir(STATE_DIR, { recursive: true });
let state = await loadState();

console.log(`Watching Things Market program ${PROGRAM_ID}`);
console.log(`HTTP RPC: ${redactUrl(RPC_HTTP_URL)}`);
console.log(`WebSocket RPC: ${redactUrl(RPC_WS_URL)}`);

// Catch anything that happened while the process was offline before listening live.
await catchUp();
connect();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function connect() {
  clearTimeout(reconnectTimer);
  console.log("Connecting to Solana WebSocket…");

  ws = new WebSocket(RPC_WS_URL);

  ws.on("open", async () => {
    console.log("WebSocket connected.");
    startHeartbeat();

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [PROGRAM_ID] },
          { commitment: COMMITMENT }
        ]
      })
    );

    // A second catch-up closes the small gap between startup catch-up and subscription.
    enqueue(catchUp);
  });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.id === 1 && Number.isInteger(message.result)) {
      subscriptionId = message.result;
      console.log(`Subscribed with ID ${subscriptionId}.`);
      return;
    }

    if (message.method !== "logsNotification") return;

    const value = message?.params?.result?.value;
    if (!value?.signature || value.err) return;

    enqueue(() => processSignature(value.signature, "live"));
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("close", () => {
    stopHeartbeat();
    subscriptionId = undefined;
    if (!shuttingDown) {
      console.warn("WebSocket closed. Reconnecting in 3 seconds…");
      reconnectTimer = setTimeout(async () => {
        await catchUpSafely();
        connect();
      }, 3000);
    }
  });

  ws.on("error", error => {
    console.error("WebSocket error:", error.message);
    ws.close();
  });
}

function enqueue(task) {
  processing = processing
    .then(task)
    .catch(error => console.error("Processing error:", error));
}

async function catchUpSafely() {
  try {
    await catchUp();
  } catch (error) {
    console.error("Catch-up failed:", error);
  }
}

async function catchUp() {
  const newestProcessed = state.lastSeenSignature || null;
  const signatures = [];
  let before;

  for (let page = 0; page < 20; page++) {
    const options = { limit: 100, commitment: COMMITMENT };
    if (before) options.before = before;

    const batch = await rpc("getSignaturesForAddress", [PROGRAM_ID, options]);
    if (!Array.isArray(batch) || batch.length === 0) break;

    let reachedPrevious = false;
    for (const item of batch) {
      if (item.signature === newestProcessed) {
        reachedPrevious = true;
        break;
      }
      signatures.push(item);
    }

    if (reachedPrevious || batch.length < 100) break;
    before = batch.at(-1).signature;
  }

  if (!state.initialized) {
    state.initialized = true;
    if (signatures[0]?.signature) {
      state.lastSeenSignature = signatures[0].signature;
    }
    await saveState();
    console.log("Initialized at the current chain tip; old launches were not announced.");
    return;
  }

  if (signatures.length === 0) return;

  console.log(`Catch-up found ${signatures.length} unseen program transaction(s).`);

  for (const item of [...signatures].reverse()) {
    if (!item.err) {
      await processSignature(item.signature, "catch-up");
    }
  }
}

async function processSignature(signature, source) {
  if (state.processedSignatures.includes(signature)) return;

  const transaction = await retryGetTransaction(signature);
  if (!transaction) {
    console.warn(`Transaction ${signature} was not available after retries.`);
    return;
  }

  const launch = detectLaunch(transaction);
  if (launch) {
    const metadata = await getMetadata(launch.mint);
    await sendTelegram({
      ...launch,
      ...metadata,
      signature,
      source
    });
    console.log(`Launch detected: ${metadata.name || launch.mint}`);
  }

  state.lastSeenSignature = signature;
  state.processedSignatures.push(signature);
  state.processedSignatures = state.processedSignatures.slice(-5000);
  await saveState();
}

function detectLaunch(transaction) {
  const instructions = collectInstructions(transaction);
  const mintCandidates = new Set();

  for (const instruction of instructions) {
    const parsed = instruction?.parsed;
    if (
      (parsed?.type === "initializeMint" ||
        parsed?.type === "initializeMint2") &&
      parsed?.info?.mint
    ) {
      mintCandidates.add(parsed.info.mint);
    }
  }

  if (mintCandidates.size === 0) return null;

  const accountKeys =
    transaction?.transaction?.message?.accountKeys?.map(key =>
      typeof key === "string" ? key : key.pubkey
    ) || [];

  const creator =
    accountKeys.find((_, index) => {
      const entry = transaction.transaction.message.accountKeys[index];
      return typeof entry === "object" && entry.signer;
    }) || null;

  return {
    mint: [...mintCandidates][0],
    creator,
    blockTime: transaction.blockTime || null,
    slot: transaction.slot
  };
}

function collectInstructions(transaction) {
  const outer = transaction?.transaction?.message?.instructions || [];
  const inner =
    transaction?.meta?.innerInstructions?.flatMap(group =>
      group.instructions || []
    ) || [];
  return [...outer, ...inner];
}

async function retryGetTransaction(signature) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const result = await rpc("getTransaction", [
      signature,
      {
        commitment: COMMITMENT,
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0
      }
    ]);

    if (result) return result;
    await sleep(Math.min(attempt * 750, 5000));
  }
  return null;
}

async function getMetadata(mint) {
  if (!HELIUS_API_KEY) return { name: null, symbol: null, image: null };

  try {
    const response = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(
        HELIUS_API_KEY
      )}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAsset",
          params: { id: mint }
        })
      }
    );

    if (!response.ok) return { name: null, symbol: null, image: null };

    const body = await response.json();
    const metadata = body?.result?.content?.metadata || {};
    const files = body?.result?.content?.files || [];

    return {
      name: metadata.name?.trim() || null,
      symbol: metadata.symbol?.trim() || null,
      image: files.find(file => file.mime?.startsWith("image/"))?.uri || null
    };
  } catch {
    return { name: null, symbol: null, image: null };
  }
}

async function sendTelegram(launch) {
  const title =
    launch.name && launch.symbol
      ? `${escapeHtml(launch.name)} ($${escapeHtml(launch.symbol)})`
      : launch.name
        ? escapeHtml(launch.name)
        : "New Things Market launch";

  const time = launch.blockTime
    ? new Date(launch.blockTime * 1000).toISOString()
    : "Unknown";

  const lines = [
    `☁️ <b>${title}</b>`,
    "",
    `<b>Mint:</b> <code>${escapeHtml(launch.mint)}</code>`,
    launch.creator
      ? `<b>Creator:</b> <code>${escapeHtml(launch.creator)}</code>`
      : null,
    `<b>Time:</b> ${escapeHtml(time)}`,
    `<b>Slot:</b> ${launch.slot}`,
    "",
    `<a href="https://www.things.market/tokens/${launch.mint}">Open on Things Market</a>`,
    `<a href="https://solscan.io/token/${launch.mint}">Token on Solscan</a>`,
    `<a href="https://solscan.io/tx/${launch.signature}">Launch transaction</a>`
  ].filter(Boolean);

  const endpoint = launch.image ? "sendPhoto" : "sendMessage";
  const payload = launch.image
    ? {
        chat_id: TELEGRAM_CHAT_ID,
        photo: launch.image,
        caption: lines.join("\n"),
        parse_mode: "HTML"
      }
    : {
        chat_id: TELEGRAM_CHAT_ID,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true
      };

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram failed: ${await response.text()}`);
  }
}

async function rpc(method, params) {
  const response = await fetch(RPC_HTTP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed.initialized),
      lastSeenSignature: parsed.lastSeenSignature || null,
      processedSignatures: Array.isArray(parsed.processedSignatures)
        ? parsed.processedSignatures
        : []
    };
  } catch {
    return {
      initialized: false,
      lastSeenSignature: null,
      processedSignatures: []
    };
  }
}

async function saveState() {
  const temp = `${STATE_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, STATE_FILE);
}

function startHeartbeat() {
  stopHeartbeat();
  ws.isAlive = true;

  heartbeatTimer = setInterval(() => {
    if (ws.isAlive === false) {
      console.warn("WebSocket heartbeat failed.");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 25000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
}

async function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  await processing;
  if (ws?.readyState === WebSocket.OPEN && subscriptionId) {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "logsUnsubscribe",
        params: [subscriptionId]
      })
    );
  }
  ws?.close();
  process.exit(0);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function deriveWebSocketUrl(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of ["api-key", "apikey", "token"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}