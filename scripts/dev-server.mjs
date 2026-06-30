import { createReadStream, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
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

const HOST = envValue("HOST", "localhost");
const PORT = Number(envValue("PORT", 5500));
const RABBITMQ_URL = envValue("RABBITMQ_URL", "");
const RABBITMQ_AMQP_URL = envValue("RABBITMQ_AMQP_URL", "");
const RABBITMQ_HOST = envValue("RABBITMQ_HOST", "");
const RABBITMQ_PORT = Number(envValue("RABBITMQ_PORT", "5672"));
const RABBITMQ_PROTOCOL = envValue("RABBITMQ_PROTOCOL", RABBITMQ_PORT === 5671 ? "amqps" : "amqp");
const RABBITMQ_USERNAME = envValue("RABBITMQ_USERNAME", "");
const RABBITMQ_PASSWORD = envValue("RABBITMQ_PASSWORD", "");
const RABBITMQ_VHOST = envValue("RABBITMQ_VHOST", "/");
const RABBITMQ_EXCHANGE = envValue("RABBITMQ_EXCHANGE", "amq.direct");
const RABBITMQ_ROUTING_KEY = envValue("RABBITMQ_ROUTING_KEY", "card.detection");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m3u8", "application/vnd.apple.mpegurl; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".onnx", "application/octet-stream"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

const PLAYLIST_CONTENT_TYPE_RE =
  /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i;

const localBroadcastState = {
  lastPayload: null,
  receivedAt: "",
  totalReceived: 0,
};

const rabbitMqBroadcastState = {
  lastPayload: null,
  retainedPayload: null,
  lastRawModelOutput: null,
  publishedAt: "",
  totalPublished: 0,
  publishUrl: "",
  routed: null,
  lastError: "",
};

const detectorState = {
  lastPayload: null,
  updatedAt: "",
  totalReceived: 0,
  lastError: "",
};

const rabbitMqAmqpState = {
  connection: null,
  channel: null,
  connectionUrl: "",
};

function normalizeTextField(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maskSecretUrl(value) {
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

function buildAmqpConnectionUrl({ url, host, port, protocol, username, password, vhost }) {
  if (url) {
    return url;
  }

  if (!host || !username || !password) {
    return "";
  }

  return (
    `${protocol || "amqp"}://${encodeURIComponent(username)}:` +
    `${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(vhost || "/")}`
  );
}

async function getRabbitMqAmqpChannel(connectionUrl) {
  if (
    rabbitMqAmqpState.channel &&
    rabbitMqAmqpState.connection &&
    rabbitMqAmqpState.connectionUrl === connectionUrl
  ) {
    return rabbitMqAmqpState.channel;
  }

  if (rabbitMqAmqpState.channel) {
    try {
      await rabbitMqAmqpState.channel.close();
    } catch {
      // Ignore close errors while switching connections.
    }
  }

  if (rabbitMqAmqpState.connection) {
    try {
      await rabbitMqAmqpState.connection.close();
    } catch {
      // Ignore close errors while switching connections.
    }
  }

  const connection = await amqp.connect(connectionUrl);
  const channel = await connection.createChannel();

  connection.on("error", () => {
    rabbitMqAmqpState.connection = null;
    rabbitMqAmqpState.channel = null;
    rabbitMqAmqpState.connectionUrl = "";
  });

  connection.on("close", () => {
    rabbitMqAmqpState.connection = null;
    rabbitMqAmqpState.channel = null;
    rabbitMqAmqpState.connectionUrl = "";
  });

  rabbitMqAmqpState.connection = connection;
  rabbitMqAmqpState.channel = channel;
  rabbitMqAmqpState.connectionUrl = connectionUrl;

  return channel;
}

async function closeRabbitMqAmqpConnection() {
  if (rabbitMqAmqpState.channel) {
    try {
      await rabbitMqAmqpState.channel.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }

  if (rabbitMqAmqpState.connection) {
    try {
      await rabbitMqAmqpState.connection.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }

  rabbitMqAmqpState.connection = null;
  rabbitMqAmqpState.channel = null;
  rabbitMqAmqpState.connectionUrl = "";
}

function emptyCardPayload() {
  return [];
}

function normalizeCardValue(value) {
  if (Number.isFinite(value)) {
    return value >= 1 && value <= 13 ? value : null;
  }

  const normalized = String(value ?? "").trim().toUpperCase();

  if (normalized === "A") {
    return 1;
  }

  if (normalized === "J") {
    return 11;
  }

  if (normalized === "Q") {
    return 12;
  }

  if (normalized === "K") {
    return 13;
  }

  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) && numeric >= 2 && numeric <= 10 ? numeric : null;
}

function normalizeCardEntry(entry, fallbackSide = "", fallbackNumber = null) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const suit = typeof entry?.suit === "string" ? entry.suit.trim().toLowerCase() : "";
  const value = normalizeCardValue(entry?.value);
  const number = Number.parseInt(String(entry?.number ?? fallbackNumber ?? ""), 10);
  const side = String(entry?.side ?? fallbackSide ?? "").trim().toLowerCase();

  if (
    !suit ||
    value === null ||
    !Number.isFinite(number) ||
    number < 1 ||
    number > 3 ||
    (side !== "player" && side !== "banker")
  ) {
    return null;
  }

  return { suit, value, number, side };
}

function normalizeCardPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(source.cards)
      ? source.cards
      : [];
  const cards = [];

  for (const entry of entries) {
    const normalized = normalizeCardEntry(entry);

    if (normalized) {
      cards.push(normalized);
    }
  }

  if (cards.length > 0) {
    return cards.sort((left, right) => {
      if (left.side !== right.side) {
        return left.side === "player" ? -1 : 1;
      }

      return left.number - right.number;
    });
  }

  const legacyCards = [];

  for (const side of ["player", "banker"]) {
    for (const slot of [1, 2, 3]) {
      const normalized = normalizeCardEntry(source?.[side]?.[`card${slot}`], side, slot);

      if (normalized) {
        legacyCards.push(normalized);
      }
    }
  }

  return legacyCards.sort((left, right) => {
    if (left.side !== right.side) {
      return left.side === "player" ? -1 : 1;
    }

    return left.number - right.number;
  });
}

function setCorsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, Content-Type",
  );
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  const headers = new Headers({
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": contentType,
  });

  setCorsHeaders(headers);
  writeHeaders(res, statusCode, headers);
  res.end(body);
}

function writeHeaders(res, statusCode, headers) {
  const plainHeaders = Object.fromEntries(headers.entries());
  res.writeHead(statusCode, plainHeaders);
}

function sendJson(res, statusCode, value) {
  sendText(res, statusCode, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function isSafePath(filePath) {
  const relativePath = path.relative(projectRoot, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function resolveStaticPath(requestPathname) {
  const safePathname = requestPathname === "/" ? "/index.html" : requestPathname;
  const filePath = path.resolve(projectRoot, `.${safePathname}`);
  return isSafePath(filePath) ? filePath : "";
}

function getMimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function buildProxyPath(targetUrl) {
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function rewritePlaylistLine(line, baseUrl) {
  if (!line || line.startsWith("#EXTM3U")) {
    return line;
  }

  if (!line.startsWith("#")) {
    return buildProxyPath(new URL(line, baseUrl).toString());
  }

  return line.replace(/URI="([^"]+)"/g, (_match, value) => {
    const absoluteUrl = new URL(value, baseUrl).toString();
    return `URI="${buildProxyPath(absoluteUrl)}"`;
  });
}

function rewritePlaylistManifest(body, baseUrl) {
  return body
    .split(/\r?\n/)
    .map((line) => rewritePlaylistLine(line, baseUrl))
    .join("\n");
}

function isPlaylistResponse(targetUrl, contentType) {
  return (
    targetUrl.toLowerCase().endsWith(".m3u8") ||
    PLAYLIST_CONTENT_TYPE_RE.test(contentType || "")
  );
}

function copyResponseHeaders(sourceHeaders, overrides = {}) {
  const headers = new Headers();
  const allowedHeaders = [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ];

  for (const name of allowedHeaders) {
    const value = sourceHeaders.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  setCorsHeaders(headers);
  return headers;
}

async function readRequestBuffer(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

async function handleProxy(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawTargetUrl = requestUrl.searchParams.get("url")?.trim();

  if (!rawTargetUrl) {
    sendText(res, 400, "Missing ?url=... query parameter");
    return;
  }

  let targetUrl;

  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    sendText(res, 400, "Invalid target URL");
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendText(res, 400, "Only http:// and https:// targets are supported");
    return;
  }

  const upstreamHeaders = new Headers();
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    upstreamHeaders.set("Range", rangeHeader);
  }

  const acceptHeader = req.headers.accept;

  if (acceptHeader) {
    upstreamHeaders.set("Accept", acceptHeader);
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetch(targetUrl, {
      headers: upstreamHeaders,
      method: req.method,
      redirect: "follow",
    });
  } catch (error) {
    sendText(res, 502, `Proxy request failed: ${error.message}`);
    return;
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";

  if (isPlaylistResponse(upstreamResponse.url, contentType)) {
    const playlistBody = req.method === "HEAD" ? "" : await upstreamResponse.text();
    const rewrittenBody =
      req.method === "HEAD"
        ? ""
        : rewritePlaylistManifest(playlistBody, upstreamResponse.url);
    const headers = copyResponseHeaders(upstreamResponse.headers, {
      "content-length":
        req.method === "HEAD" ? upstreamResponse.headers.get("content-length") : null,
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    });

    if (req.method !== "HEAD") {
      headers.set("content-length", String(Buffer.byteLength(rewrittenBody)));
    }

    writeHeaders(res, upstreamResponse.status, headers);
    res.end(req.method === "HEAD" ? undefined : rewrittenBody);
    return;
  }

  const headers = copyResponseHeaders(upstreamResponse.headers);

  writeHeaders(res, upstreamResponse.status, headers);

  if (req.method === "HEAD" || !upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

async function handleBroadcast(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawTargetUrl = requestUrl.searchParams.get("url")?.trim();

  if (!rawTargetUrl) {
    sendText(res, 400, "Missing ?url=... query parameter");
    return;
  }

  let targetUrl;

  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    sendText(res, 400, "Invalid target URL");
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendText(res, 400, "Only http:// and https:// targets are supported");
    return;
  }

  const body = await readRequestBuffer(req);
  const upstreamHeaders = new Headers();
  const contentType = req.headers["content-type"];

  if (contentType) {
    upstreamHeaders.set("Content-Type", contentType);
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body,
      redirect: "follow",
    });
  } catch (error) {
    sendText(res, 502, `Broadcast request failed: ${error.message}`);
    return;
  }

  const headers = copyResponseHeaders(upstreamResponse.headers);
  writeHeaders(res, upstreamResponse.status, headers);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

function rabbitMqPublishUrl(baseUrl, vhost, exchange) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  url.pathname =
    `${normalizedPath}/api/exchanges/${encodeURIComponent(vhost)}/${encodeURIComponent(exchange)}/publish`;
  url.search = "";
  return url.toString();
}

async function handleRabbitMqBroadcast(req, res) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawBody = await readRequestBuffer(req);
  const rawText = rawBody.toString("utf8");

  let parsedBody;

  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    sendText(res, 400, "RabbitMQ request body must be valid JSON");
    return;
  }

  const rabbitmq = parsedBody?.rabbitmq || {};
  const payload = parsedBody?.payload;
  const rawModelOutput = parsedBody?.rawModelOutput ?? null;
  const baseUrl = normalizeTextField(rabbitmq.url) || RABBITMQ_URL;
  const username = normalizeTextField(rabbitmq.username) || RABBITMQ_USERNAME;
  const password =
    (typeof rabbitmq.password === "string" ? rabbitmq.password : "") ||
    RABBITMQ_PASSWORD;
  const vhost = normalizeTextField(rabbitmq.vhost) || RABBITMQ_VHOST;
  const exchange = normalizeTextField(rabbitmq.exchange) || RABBITMQ_EXCHANGE;
  const routingKey =
    normalizeTextField(rabbitmq.routingKey) || RABBITMQ_ROUTING_KEY;
  const amqpConnectionUrl = buildAmqpConnectionUrl({
    url: normalizeTextField(rabbitmq.amqpUrl) || RABBITMQ_AMQP_URL,
    host: normalizeTextField(rabbitmq.host) || RABBITMQ_HOST,
    port: Number(rabbitmq.port) || RABBITMQ_PORT,
    protocol: normalizeTextField(rabbitmq.protocol) || RABBITMQ_PROTOCOL,
    username,
    password,
    vhost,
  });
  const usingHttpApi = Boolean(baseUrl);
  const usingAmqp = Boolean(amqpConnectionUrl);

  if ((!usingHttpApi && !usingAmqp) || !username || !password || !exchange || !routingKey) {
    sendText(
      res,
      400,
      "RabbitMQ config requires either RABBITMQ_URL or RABBITMQ_AMQP_URL plus username, password, exchange, and routingKey.",
    );
    return;
  }
  let publishUrl = "";
  let routed = true;

  if (usingHttpApi) {
    try {
      publishUrl = rabbitMqPublishUrl(baseUrl, vhost, exchange);
    } catch {
      sendText(res, 400, "RabbitMQ URL is invalid");
      return;
    }

    const publishBody = {
      properties: {},
      routing_key: routingKey,
      payload: JSON.stringify(payload),
      payload_encoding: "string",
    };

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(publishUrl, {
        method: "POST",
        headers: {
          Authorization:
            `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(publishBody),
        redirect: "follow",
      });
    } catch (error) {
      rabbitMqBroadcastState.lastError = `RabbitMQ publish failed: ${error.message}`;
      rabbitMqBroadcastState.publishUrl = publishUrl;
      sendText(res, 502, `RabbitMQ publish failed: ${error.message}`);
      return;
    }

    const responseText = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      rabbitMqBroadcastState.lastError =
        responseText || `RabbitMQ publish request failed with HTTP ${upstreamResponse.status}`;
      rabbitMqBroadcastState.publishUrl = publishUrl;
      sendText(
        res,
        upstreamResponse.status,
        responseText || "RabbitMQ publish request failed",
        upstreamResponse.headers.get("content-type") || "text/plain; charset=utf-8",
      );
      return;
    }

    let responseJson = null;

    try {
      responseJson = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseJson = null;
    }

    if (responseJson && responseJson.routed === false) {
      rabbitMqBroadcastState.lastError = "RabbitMQ accepted the request but did not route it";
      rabbitMqBroadcastState.publishUrl = publishUrl;
      rabbitMqBroadcastState.routed = false;
      sendJson(res, 502, {
        ok: false,
        routed: false,
        publishUrl,
        rabbitmqResponse: responseJson,
      });
      return;
    }

    routed = responseJson?.routed ?? true;
  } else {
    publishUrl = `${maskSecretUrl(amqpConnectionUrl)} -> ${exchange}:${routingKey}`;

    try {
      const channel = await getRabbitMqAmqpChannel(amqpConnectionUrl);
      channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          contentType: "application/json",
          deliveryMode: 2,
        },
      );
    } catch (error) {
      rabbitMqBroadcastState.lastError = `RabbitMQ AMQP publish failed: ${error.message}`;
      rabbitMqBroadcastState.publishUrl = publishUrl;
      sendText(res, 502, `RabbitMQ AMQP publish failed: ${error.message}`);
      return;
    }
  }

  const normalizedPayload = normalizeCardPayload(payload);

  rabbitMqBroadcastState.lastPayload = normalizedPayload;
  rabbitMqBroadcastState.retainedPayload = normalizedPayload;
  rabbitMqBroadcastState.lastRawModelOutput = rawModelOutput;
  rabbitMqBroadcastState.publishedAt = new Date().toISOString();
  rabbitMqBroadcastState.totalPublished += 1;
  rabbitMqBroadcastState.publishUrl = publishUrl;
  rabbitMqBroadcastState.routed = routed;
  rabbitMqBroadcastState.lastError = "";

  console.log(
    `[broadcast/rabbitmq] published #${rabbitMqBroadcastState.totalPublished} at ${rabbitMqBroadcastState.publishedAt}`,
  );
  console.log(JSON.stringify(payload, null, 2));

  sendJson(res, 200, {
    ok: true,
    routed,
    publishUrl,
  });
}

async function handleRabbitMqViewer(req, res) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const body = rabbitMqBroadcastState.lastPayload || emptyCardPayload();

  if (req.method === "HEAD") {
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
    });
    setCorsHeaders(headers);
    writeHeaders(res, 200, headers);
    res.end();
    return;
  }

  sendJson(res, 200, body);
}

async function handleRabbitMqLocalClear(req, res) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  rabbitMqBroadcastState.lastPayload = emptyCardPayload();
  rabbitMqBroadcastState.retainedPayload = emptyCardPayload();
  rabbitMqBroadcastState.lastRawModelOutput = null;

  sendJson(res, 200, {
    ok: true,
    clearedAt: new Date().toISOString(),
  });
}

async function handleLocalBroadcast(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  const isLatestPath = requestUrl.pathname.endsWith("/latest");

  if (isLatestPath && (req.method === "GET" || req.method === "HEAD")) {

    const body = {
      ok: true,
      receivedAt: localBroadcastState.receivedAt || null,
      totalReceived: localBroadcastState.totalReceived,
      payload: localBroadcastState.lastPayload,
    };

    if (req.method === "HEAD") {
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
      });
      setCorsHeaders(headers);
      writeHeaders(res, 200, headers);
      res.end();
      return;
    }

    sendJson(res, 200, body);
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawBody = await readRequestBuffer(req);
  const rawText = rawBody.toString("utf8");

  let payload;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    sendText(res, 400, "Broadcast payload must be valid JSON");
    return;
  }

  localBroadcastState.lastPayload = payload;
  localBroadcastState.receivedAt = new Date().toISOString();
  localBroadcastState.totalReceived += 1;

  console.log(
    `[broadcast/local-test] received #${localBroadcastState.totalReceived} at ${localBroadcastState.receivedAt}`,
  );
  console.log(JSON.stringify(payload, null, 2));

  sendJson(res, 200, {
    ok: true,
    receivedAt: localBroadcastState.receivedAt,
    totalReceived: localBroadcastState.totalReceived,
  });
}

async function handleDetectorResults(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCorsHeaders(headers);
    writeHeaders(res, 204, headers);
    res.end();
    return;
  }

  const isLatestPath = requestUrl.pathname.endsWith("/latest");

  if (isLatestPath && (req.method === "GET" || req.method === "HEAD")) {
    const body = {
      ok: true,
      updatedAt: detectorState.updatedAt || null,
      totalReceived: detectorState.totalReceived,
      lastError: detectorState.lastError || null,
      payload: detectorState.lastPayload,
    };

    if (req.method === "HEAD") {
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
      });
      setCorsHeaders(headers);
      writeHeaders(res, 200, headers);
      res.end();
      return;
    }

    sendJson(res, 200, body);
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawBody = await readRequestBuffer(req);
  const rawText = rawBody.toString("utf8");

  let payload;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    detectorState.lastError = "Detector payload must be valid JSON";
    sendText(res, 400, detectorState.lastError);
    return;
  }

  detectorState.lastPayload = payload;
  detectorState.updatedAt = new Date().toISOString();
  detectorState.totalReceived += 1;
  detectorState.lastError = "";

  sendJson(res, 200, {
    ok: true,
    updatedAt: detectorState.updatedAt,
    totalReceived: detectorState.totalReceived,
  });
}

async function handleStatic(req, res, requestUrl) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const filePath = resolveStaticPath(requestUrl.pathname);

  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    await access(filePath);
    const fileStats = await stat(filePath);

    if (!fileStats.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }

    const headers = new Headers({
      "Content-Length": String(fileStats.size),
      "Content-Type": getMimeType(filePath),
    });

    setCorsHeaders(headers);
    writeHeaders(res, 200, headers);

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

  if (requestUrl.pathname === "/proxy") {
    await handleProxy(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/broadcast") {
    await handleBroadcast(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/broadcast/rabbitmq") {
    await handleRabbitMqBroadcast(req, res);
    return;
  }

  if (requestUrl.pathname === "/broadcast/rabbitmq/latest") {
    await handleRabbitMqViewer(req, res);
    return;
  }

  if (requestUrl.pathname === "/broadcast/rabbitmq/clear-local") {
    await handleRabbitMqLocalClear(req, res);
    return;
  }

  if (
    requestUrl.pathname === "/broadcast/local-test" ||
    requestUrl.pathname === "/broadcast/local-test/latest"
  ) {
    await handleLocalBroadcast(req, res, requestUrl);
    return;
  }

  if (
    requestUrl.pathname === "/detector/results" ||
    requestUrl.pathname === "/detector/latest"
  ) {
    await handleDetectorResults(req, res, requestUrl);
    return;
  }

  await handleStatic(req, res, requestUrl);
});

process.on("SIGINT", async () => {
  await closeRabbitMqAmqpConnection();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", async () => {
  await closeRabbitMqAmqpConnection();
  server.close(() => process.exit(0));
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
