import { createReadStream, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
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

const HOST = envValue("HOST", "localhost");
const PORT = Number(envValue("PORT", 5500));
const RABBITMQ_URL = envValue("RABBITMQ_URL", "");
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

function normalizeTextField(value) {
  return typeof value === "string" ? value.trim() : "";
}

function emptyCardPayload() {
  return {
    player: [],
    banker: [],
  };
}

function normalizeCardEntry(entry) {
  return {
    name: typeof entry?.name === "string" ? entry.name : "",
    slot: Number.isFinite(entry?.slot) ? entry.slot : null,
  };
}

function sortCardEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftSlot = Number.isFinite(left?.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
    const rightSlot = Number.isFinite(right?.slot) ? right.slot : Number.MAX_SAFE_INTEGER;
    return leftSlot - rightSlot;
  });
}

function normalizeCardPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const player = Array.isArray(source.player) ? source.player : [];
  const banker = Array.isArray(source.banker) ? source.banker : [];

  return {
    player: sortCardEntries(player.map(normalizeCardEntry).filter((entry) => entry.name)),
    banker: sortCardEntries(banker.map(normalizeCardEntry).filter((entry) => entry.name)),
  };
}

function mergeCardPayload(previousPayload, nextPayload) {
  const previous = normalizeCardPayload(previousPayload);
  const next = normalizeCardPayload(nextPayload);

  const mergeSide = (previousEntries, nextEntries) => {
    const bySlot = new Map();

    for (const entry of previousEntries) {
      if (!Number.isFinite(entry.slot)) {
        continue;
      }

      bySlot.set(entry.slot, entry);
    }

    for (const entry of nextEntries) {
      if (!Number.isFinite(entry.slot)) {
        continue;
      }

      bySlot.set(entry.slot, entry);
    }

    return sortCardEntries([...bySlot.values()]);
  };

  return {
    player: mergeSide(previous.player, next.player),
    banker: mergeSide(previous.banker, next.banker),
  };
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

  if (!baseUrl || !username || !password || !exchange || !routingKey) {
    sendText(
      res,
      400,
      "RabbitMQ config requires url, username, password, exchange, and routingKey. Set them in env or request body.",
    );
    return;
  }

  let publishUrl;

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

  const normalizedPayload = normalizeCardPayload(payload);

  rabbitMqBroadcastState.lastPayload = normalizedPayload;
  rabbitMqBroadcastState.retainedPayload = mergeCardPayload(
    rabbitMqBroadcastState.retainedPayload || emptyCardPayload(),
    normalizedPayload,
  );
  rabbitMqBroadcastState.lastRawModelOutput = rawModelOutput;
  rabbitMqBroadcastState.publishedAt = new Date().toISOString();
  rabbitMqBroadcastState.totalPublished += 1;
  rabbitMqBroadcastState.publishUrl = publishUrl;
  rabbitMqBroadcastState.routed = responseJson?.routed ?? true;
  rabbitMqBroadcastState.lastError = "";

  console.log(
    `[broadcast/rabbitmq] published #${rabbitMqBroadcastState.totalPublished} at ${rabbitMqBroadcastState.publishedAt}`,
  );
  console.log(JSON.stringify(payload, null, 2));

  sendJson(res, 200, {
    ok: true,
    routed: responseJson?.routed ?? true,
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

  const body = rabbitMqBroadcastState.retainedPayload || emptyCardPayload();

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

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
