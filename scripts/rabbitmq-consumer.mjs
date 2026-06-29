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

  console.log(`[${new Date().toISOString()}] ${message.content.toString()}`);
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
