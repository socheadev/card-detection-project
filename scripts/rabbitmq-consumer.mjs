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

const RABBITMQ_URL = envValue("RABBITMQ_URL", "");
const RABBITMQ_HOST =
  envValue("RABBITMQ_HOST", "") || hostFromRabbitMqUrl(RABBITMQ_URL) || "rabbitmq.sclabproxserver.qzz.io";
const RABBITMQ_PORT = Number(envValue("RABBITMQ_PORT", "5672"));
const RABBITMQ_USERNAME = envValue("RABBITMQ_USERNAME");
const RABBITMQ_PASSWORD = envValue("RABBITMQ_PASSWORD");
const RABBITMQ_VHOST = envValue("RABBITMQ_VHOST", "/");
const RABBITMQ_QUEUE = envValue("RABBITMQ_QUEUE", "card_detection_queue");

if (!RABBITMQ_USERNAME || !RABBITMQ_PASSWORD) {
  throw new Error("Set RABBITMQ_USERNAME and RABBITMQ_PASSWORD in .env or process env before running the consumer");
}

const connectionUrl =
  `amqp://${encodeURIComponent(RABBITMQ_USERNAME)}:` +
  `${encodeURIComponent(RABBITMQ_PASSWORD)}@${RABBITMQ_HOST}:` +
  `${RABBITMQ_PORT}/${encodeURIComponent(RABBITMQ_VHOST)}`;

console.log(`Connecting to ${RABBITMQ_HOST}:${RABBITMQ_PORT}, queue ${RABBITMQ_QUEUE}`);

const connection = await amqp.connect(connectionUrl);
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
