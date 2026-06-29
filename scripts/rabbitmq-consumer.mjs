import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import amqp from "amqplib";

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

function hostFromRabbitMqUrl(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function normalizeProtocol(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "amqps" ? "amqps" : "amqp";
}

function maskConnectionUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    if (url.password) {
      url.password = "******";
    }

    return url.toString();
  } catch {
    return value;
  }
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

function cardCode(card) {
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
}

function summarizeSide(label, cards) {
  const source = Array.isArray(cards) ? cards : [];
  const parts = ["card1", "card2", "card3"].map(
    (key, index) => {
      const entry = source.find((card) => card.number === index + 1) || null;
      const plainCode = cardCode(entry).padEnd(3, " ");
      const color = suitColor(plainCode.trim().slice(-1));
      return `${colorize(`${key}=`, ANSI.dim)}${colorize(plainCode, color)}`;
    },
  );

  const sideLabelColor = label === "PLAYER" ? ANSI.blue : ANSI.yellow;
  return `${colorize(label.padEnd(6, " "), `${ANSI.bold}${sideLabelColor}`)} ${parts.join("  ")}`;
}

function printFormattedMessage(message) {
  const timestamp = new Date().toISOString();
  const contentType = message?.properties?.contentType || "";
  const routingKey = Array.isArray(message?.fields?.routingKey)
    ? message.fields.routingKey.join(".")
    : message?.fields?.routingKey || "";
  const rawBody = message.content.toString();
  const parsedBody = parseJsonIfPossible(rawBody);

  console.log(
    `${colorize(`[${timestamp}]`, ANSI.dim)} ` +
      `${colorize(`routing_key=${routingKey || "-"}`, ANSI.cyan)} ` +
      `${colorize(`content_type=${contentType || "-"}`, ANSI.dim)}`,
  );

  if (!parsedBody) {
    console.log(rawBody);
    return;
  }

  const cards = normalizePayloadCards(parsedBody);
  console.log(JSON.stringify(cards.length > 0 ? cards : parsedBody, null, 4));
  console.log("");
}

const RABBITMQ_URL = envValue("RABBITMQ_URL", "");
const RABBITMQ_AMQP_URL = envValue("RABBITMQ_AMQP_URL", "");
const RABBITMQ_HOST =
  envValue("RABBITMQ_HOST", "") || hostFromRabbitMqUrl(RABBITMQ_URL) || "rabbitmq.sclabproxserver.qzz.io";
const RABBITMQ_PORT = Number(envValue("RABBITMQ_PORT", "5672"));
const RABBITMQ_PROTOCOL = normalizeProtocol(
  envValue("RABBITMQ_PROTOCOL", RABBITMQ_PORT === 5671 ? "amqps" : "amqp"),
);
const RABBITMQ_USERNAME = envValue("RABBITMQ_USERNAME");
const RABBITMQ_PASSWORD = envValue("RABBITMQ_PASSWORD");
const RABBITMQ_VHOST = envValue("RABBITMQ_VHOST", "/");
const RABBITMQ_QUEUE = envValue("RABBITMQ_QUEUE", "card_detection_queue");

if (!RABBITMQ_AMQP_URL && (!RABBITMQ_USERNAME || !RABBITMQ_PASSWORD)) {
  throw new Error("Set RABBITMQ_USERNAME and RABBITMQ_PASSWORD in .env or process env before running the consumer");
}

const connectionUrl = RABBITMQ_AMQP_URL || (
  `${RABBITMQ_PROTOCOL}://${encodeURIComponent(RABBITMQ_USERNAME)}:` +
  `${encodeURIComponent(RABBITMQ_PASSWORD)}@${RABBITMQ_HOST}:` +
  `${RABBITMQ_PORT}/${encodeURIComponent(RABBITMQ_VHOST)}`
);

console.log(
  `Connecting to ${maskConnectionUrl(connectionUrl)}, queue ${RABBITMQ_QUEUE}`,
);

let connection;

try {
  connection = await amqp.connect(connectionUrl);
} catch (error) {
  const code = error?.code || error?.cause?.code || "";

  if (!RABBITMQ_AMQP_URL && (code === "ETIMEDOUT" || code === "EHOSTUNREACH")) {
    console.error(
      [
        "AMQP connection could not reach the broker.",
        "The RabbitMQ HTTP publish endpoint may still work on HTTPS while raw AMQP is blocked on this host.",
        "Set RABBITMQ_AMQP_URL to the broker's real AMQP or AMQPS endpoint, for example:",
        "RABBITMQ_AMQP_URL=amqps://user:pass@real-broker-host:5671/%2F",
      ].join("\n"),
    );
  }

  throw error;
}

const channel = await connection.createChannel();

await channel.assertQueue(RABBITMQ_QUEUE, { durable: true });

channel.consume(RABBITMQ_QUEUE, (message) => {
  if (!message) {
    return;
  }

  printFormattedMessage(message);
  channel.ack(message);
});

const shutdown = async () => {
  try {
    await channel.close();
  } catch {
    // Ignore close errors during shutdown.
  }

  try {
    await connection.close();
  } catch {
    // Ignore close errors during shutdown.
  }

  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
