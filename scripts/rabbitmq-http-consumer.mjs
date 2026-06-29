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

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
};

const useColors =
  Boolean(process.stdout?.isTTY) &&
  !process.env.NO_COLOR &&
  String(process.env.TERM || "").toLowerCase() !== "dumb";

function colorize(text, color) {
  if (!useColors || !color) {
    return text;
  }

  return `${color}${text}${ANSI.reset}`;
}

function suitColor(suitCode) {
  if (suitCode === "H") {
    return ANSI.red;
  }

  if (suitCode === "D") {
    return ANSI.magenta;
  }

  if (suitCode === "C") {
    return ANSI.green;
  }

  if (suitCode === "S") {
    return ANSI.cyan;
  }

  return "";
}

function rankLabel(value) {
  const numeric = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(numeric)) {
    return "?";
  }

  if (numeric === 1) {
    return "A";
  }

  if (numeric === 11) {
    return "J";
  }

  if (numeric === 12) {
    return "Q";
  }

  if (numeric === 13) {
    return "K";
  }

  return numeric >= 2 && numeric <= 10 ? String(numeric) : "?";
}

function normalizePayloadCards(payload) {
  if (Array.isArray(payload)) {
    return payload
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        suit: String(entry.suit || "").trim().toLowerCase(),
        value: Number.parseInt(String(entry.value ?? ""), 10),
        number: Number.parseInt(String(entry.number ?? ""), 10),
        side: String(entry.side || "").trim().toLowerCase(),
      }))
      .filter(
        (entry) =>
          entry.suit &&
          Number.isFinite(entry.value) &&
          entry.value >= 1 &&
          entry.value <= 13 &&
          Number.isFinite(entry.number) &&
          entry.number >= 1 &&
          entry.number <= 3 &&
          (entry.side === "player" || entry.side === "banker"),
      );
  }

  const cards = [];

  for (const side of ["player", "banker"]) {
    const sourceSide = payload?.[side];

    for (const number of [1, 2, 3]) {
      const entry = sourceSide?.[`card${number}`];

      if (!entry || typeof entry !== "object") {
        continue;
      }

      const valueText = String(entry.value ?? "").trim().toUpperCase();
      const value =
        valueText === "A"
          ? 1
          : valueText === "J"
            ? 11
            : valueText === "Q"
              ? 12
              : valueText === "K"
                ? 13
                : Number.parseInt(valueText, 10);

      if (!Number.isFinite(value)) {
        continue;
      }

      cards.push({
        suit: String(entry.suit || "").trim().toLowerCase(),
        value,
        number,
        side,
      });
    }
  }

  return cards;
}

function summarizeCards(cards) {
  const source = Array.isArray(cards) ? cards : [];
  const cardCode = (card) => {
    if (!card || typeof card !== "object") {
      return "--";
    }

    const value = rankLabel(card?.value);
    const suit = String(card?.suit ?? "").trim().toLowerCase();
    const suitCode =
      suit === "clubs"
        ? "C"
        : suit === "diamonds"
          ? "D"
          : suit === "hearts"
            ? "H"
            : suit === "spades"
              ? "S"
              : "";

    return value && suitCode ? `${value}${suitCode}` : "--";
  };

  return ["card1", "card2", "card3"]
    .map((key, index) => {
      const entry = source.find((card) => card.number === index + 1) || null;
      const plainCode = cardCode(entry).padEnd(3, " ");
      const color = suitColor(plainCode.trim().slice(-1));
      return `${colorize(`${key}=`, ANSI.dim)}${colorize(plainCode, color)}`;
    })
    .join("  ");
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
      `${colorize(`[${new Date().toISOString()}]`, ANSI.dim)} ` +
        `${colorize(`routing_key=${routingKey || "-"}`, ANSI.cyan)} ` +
        `${colorize(`content_type=${contentType || "-"}`, ANSI.dim)}`,
    );

    if (!parsedBody) {
      console.log(body);
      continue;
    }

    const cards = normalizePayloadCards(parsedBody);
    console.log(JSON.stringify(cards.length > 0 ? cards : parsedBody, null, 4));
    console.log("");
  }

  await delay(RABBITMQ_HTTP_POLL_MS);
}
