import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function readDotEnv(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const values = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values[key] = value;
    }

    return values;
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv(path.resolve(projectRoot, ".env"));

function envValue(name, fallback = "") {
  return process.env[name] ?? dotEnv[name] ?? fallback;
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number.parseInt(String(value || ""), 10);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}

function normalizeAckMode(value) {
  const normalized = String(value || "").trim();
  const supported = new Set([
    "ack_requeue_true",
    "reject_requeue_true",
    "ack_requeue_false",
    "reject_requeue_false",
  ]);

  return supported.has(normalized) ? normalized : "ack_requeue_false";
}

function queueGetUrl(baseUrl, vhost, queueName) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  url.pathname =
    `${normalizedPath}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName)}/get`;
  url.search = "";
  return url.toString();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonIfPossible(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return "-";
  }

  return cards
    .map((card) => {
      const name = typeof card?.name === "string" ? card.name : "?";
      const slot = Number.isFinite(card?.slot) ? `#${card.slot}` : "#?";
      const confidence = Number.isFinite(card?.confidence)
        ? ` ${(card.confidence * 100).toFixed(1)}%`
        : "";
      return `${slot} ${name}${confidence}`;
    })
    .join(", ");
}

const RABBITMQ_URL = envValue("RABBITMQ_URL", "");
const RABBITMQ_USERNAME = envValue("RABBITMQ_USERNAME", "");
const RABBITMQ_PASSWORD = envValue("RABBITMQ_PASSWORD", "");
const RABBITMQ_VHOST = envValue("RABBITMQ_VHOST", "/");
const RABBITMQ_QUEUE = envValue("RABBITMQ_QUEUE", "card_detection_queue");
const RABBITMQ_HTTP_POLL_MS = clampInteger(
  envValue("RABBITMQ_HTTP_POLL_MS", "1000"),
  1000,
  250,
  60000,
);
const RABBITMQ_HTTP_BATCH_SIZE = clampInteger(
  envValue("RABBITMQ_HTTP_BATCH_SIZE", "1"),
  1,
  1,
  100,
);
const RABBITMQ_HTTP_ACKMODE = normalizeAckMode(
  envValue("RABBITMQ_HTTP_ACKMODE", "ack_requeue_false"),
);
const RABBITMQ_HTTP_TRUNCATE = clampInteger(
  envValue("RABBITMQ_HTTP_TRUNCATE", "50000"),
  50000,
  128,
  1_000_000,
);

if (!RABBITMQ_URL || !RABBITMQ_USERNAME || !RABBITMQ_PASSWORD) {
  throw new Error(
    "Set RABBITMQ_URL, RABBITMQ_USERNAME, and RABBITMQ_PASSWORD in .env or process env before running the HTTP consumer",
  );
}

const getUrl = queueGetUrl(RABBITMQ_URL, RABBITMQ_VHOST, RABBITMQ_QUEUE);
const authHeader = `Basic ${Buffer.from(`${RABBITMQ_USERNAME}:${RABBITMQ_PASSWORD}`).toString("base64")}`;

console.log(
  [
    `Polling ${getUrl}`,
    `queue=${RABBITMQ_QUEUE}`,
    `ackmode=${RABBITMQ_HTTP_ACKMODE}`,
    `batch=${RABBITMQ_HTTP_BATCH_SIZE}`,
    `interval=${RABBITMQ_HTTP_POLL_MS}ms`,
  ].join(" "),
);

let stopped = false;

process.on("SIGINT", () => {
  stopped = true;
});

process.on("SIGTERM", () => {
  stopped = true;
});

while (!stopped) {
  let response;

  try {
    response = await fetch(getUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        count: RABBITMQ_HTTP_BATCH_SIZE,
        ackmode: RABBITMQ_HTTP_ACKMODE,
        encoding: "auto",
        truncate: RABBITMQ_HTTP_TRUNCATE,
      }),
    });
  } catch (error) {
    console.error(`HTTP consumer request failed: ${error.message}`);
    await delay(RABBITMQ_HTTP_POLL_MS);
    continue;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error(
      `HTTP consumer failed: HTTP ${response.status}${errorText ? ` ${errorText}` : ""}`,
    );
    await delay(RABBITMQ_HTTP_POLL_MS);
    continue;
  }

  let messages = [];

  try {
    const payload = await response.json();
    messages = Array.isArray(payload) ? payload : [];
  } catch (error) {
    console.error(`HTTP consumer returned invalid JSON: ${error.message}`);
    await delay(RABBITMQ_HTTP_POLL_MS);
    continue;
  }

  for (const message of messages) {
    const routingKey = message?.routing_key || "";
    const contentType = message?.properties?.content_type || "";
    const body = message?.payload ?? "";
    const parsedBody = parseJsonIfPossible(body);

    console.log(
      `[${new Date().toISOString()}] routing_key=${routingKey} content_type=${contentType}`,
    );

    if (!parsedBody) {
      console.log(body);
      continue;
    }

    const playerCards = Array.isArray(parsedBody.player) ? parsedBody.player : [];
    const bankerCards = Array.isArray(parsedBody.banker) ? parsedBody.banker : [];
    const resultCards = Array.isArray(parsedBody.results) ? parsedBody.results : [];

    console.log(`PLAYER ${summarizeCards(playerCards)}`);
    console.log(`BANKER ${summarizeCards(bankerCards)}`);

    if (resultCards.length > 0) {
      console.log(`RESULTS ${resultCards.length}`);
    }

    console.log(JSON.stringify(parsedBody, null, 2));
  }

  await delay(RABBITMQ_HTTP_POLL_MS);
}
