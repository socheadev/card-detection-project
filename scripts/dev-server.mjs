import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5500);

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

function setCorsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
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

  await handleStatic(req, res, requestUrl);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
