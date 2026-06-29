import {
  appState,
  DEFAULT_RABBITMQ_EXCHANGE,
  DEFAULT_RABBITMQ_ROUTING_KEY,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_RABBITMQ_VHOST,
  emitBroadcastStateChanged,
} from "./shared.js";

const BROADCAST_STORAGE_KEY = "capture-video-preview-broadcast-v1";

const broadcasterState = {
  inFlight: false,
  pendingPayload: null,
};

function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function normalizeBroadcastUrl(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRabbitMqField(value, fallback = "") {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function hasWebhookTarget() {
  return Boolean(normalizeBroadcastUrl(appState.broadcastTargetUrl));
}

function isRabbitMqConfigured() {
  return Boolean(
    normalizeBroadcastUrl(appState.rabbitmqUrl) &&
      normalizeRabbitMqField(appState.rabbitmqVhost) &&
      normalizeRabbitMqField(appState.rabbitmqExchange) &&
      normalizeRabbitMqField(appState.rabbitmqRoutingKey),
  );
}

export function hasBroadcastDestination() {
  return isRabbitMqConfigured() || hasWebhookTarget();
}

function activeBroadcastMode() {
  if (isRabbitMqConfigured()) {
    return "rabbitmq";
  }

  if (hasWebhookTarget()) {
    return "webhook";
  }

  return "";
}

function persistBroadcastConfig() {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(
      BROADCAST_STORAGE_KEY,
      JSON.stringify({
        enabled: appState.broadcastEnabled,
        url: appState.broadcastTargetUrl,
        rabbitmqUrl: appState.rabbitmqUrl,
        rabbitmqVhost: appState.rabbitmqVhost,
        rabbitmqExchange: appState.rabbitmqExchange,
        rabbitmqRoutingKey: appState.rabbitmqRoutingKey,
      }),
    );
  } catch {
    // Ignore storage failures and keep the in-memory config.
  }
}

function readStoredBroadcastConfig() {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(BROADCAST_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    return {
      enabled: Boolean(parsed?.enabled),
      url: normalizeBroadcastUrl(parsed?.url),
      rabbitmqUrl: normalizeBroadcastUrl(parsed?.rabbitmqUrl),
      rabbitmqVhost: normalizeRabbitMqField(
        parsed?.rabbitmqVhost,
        DEFAULT_RABBITMQ_VHOST,
      ),
      rabbitmqExchange: normalizeRabbitMqField(
        parsed?.rabbitmqExchange,
        DEFAULT_RABBITMQ_EXCHANGE,
      ),
      rabbitmqRoutingKey: normalizeRabbitMqField(
        parsed?.rabbitmqRoutingKey,
        DEFAULT_RABBITMQ_ROUTING_KEY,
      ),
    };
  } catch {
    return null;
  }
}

function emitBroadcastStatus(text, state = "idle") {
  emitBroadcastStateChanged({ text, state });
}

function summarizeUrl(value) {
  const normalized = normalizeBroadcastUrl(value);

  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized, window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return normalized;
  }
}

function summarizeRabbitMq() {
  const url = normalizeBroadcastUrl(appState.rabbitmqUrl);
  const exchange = normalizeRabbitMqField(appState.rabbitmqExchange);
  const routingKey = normalizeRabbitMqField(appState.rabbitmqRoutingKey);

  if (!url) {
    return `RabbitMQ ${exchange}:${routingKey}`;
  }

  try {
    const parsed = new URL(url, window.location.href);
    return `RabbitMQ ${parsed.host} ${exchange}:${routingKey}`;
  } catch {
    return `RabbitMQ ${exchange}:${routingKey}`;
  }
}

function currentDestinationSummary() {
  return activeBroadcastMode() === "rabbitmq"
    ? summarizeRabbitMq()
    : summarizeUrl(appState.broadcastTargetUrl);
}

function resolveBroadcastRequestUrl(targetUrl) {
  const resolvedTargetUrl = new URL(targetUrl, window.location.href);
  const pageUrl = new URL(window.location.href);

  if (resolvedTargetUrl.origin === pageUrl.origin) {
    return resolvedTargetUrl.toString();
  }

  return `/broadcast?url=${encodeURIComponent(resolvedTargetUrl.toString())}`;
}

async function postBroadcastPayload(payload) {
  if (!appState.broadcastEnabled || !hasBroadcastDestination()) {
    return;
  }

  const message =
    payload && typeof payload === "object" && "payload" in payload
      ? payload
      : { payload, rawModelOutput: null };

  let response;

  if (activeBroadcastMode() === "rabbitmq") {
    response = await fetch("/broadcast/rabbitmq", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: message.payload,
        rawModelOutput: message.rawModelOutput || null,
        rabbitmq: {
          url: appState.rabbitmqUrl,
          vhost: appState.rabbitmqVhost,
          exchange: appState.rabbitmqExchange,
          routingKey: appState.rabbitmqRoutingKey,
        },
      }),
    });
  } else {
    const targetUrl = normalizeBroadcastUrl(appState.broadcastTargetUrl);
    response = await fetch(resolveBroadcastRequestUrl(targetUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message.payload),
    });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const detail = errorText ? `: ${errorText}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
}

async function flushBroadcastQueue() {
  if (broadcasterState.inFlight) {
    return;
  }

  broadcasterState.inFlight = true;

  try {
    while (appState.broadcastEnabled && broadcasterState.pendingPayload) {
      const payload = broadcasterState.pendingPayload;
      broadcasterState.pendingPayload = null;

      emitBroadcastStatus("Sending...", "loading");
      await postBroadcastPayload(payload);

      emitBroadcastStatus(
        `Sent ${new Date().toLocaleTimeString()}`,
        "ready",
      );
    }
  } catch (error) {
    emitBroadcastStatus(`Send failed: ${error.message}`, "error");
  } finally {
    broadcasterState.inFlight = false;

    if (appState.broadcastEnabled && broadcasterState.pendingPayload) {
      void flushBroadcastQueue();
    }
  }
}

function disableBroadcastingState() {
  appState.broadcastEnabled = false;
  broadcasterState.pendingPayload = null;
  persistBroadcastConfig();
}

function enableBroadcastingState() {
  appState.broadcastEnabled = true;
  persistBroadcastConfig();
}

export function initBroadcasting() {
  const storedConfig = readStoredBroadcastConfig();

  appState.broadcastTargetUrl = storedConfig?.url || "";
  appState.rabbitmqUrl = storedConfig?.rabbitmqUrl || DEFAULT_RABBITMQ_URL;
  appState.rabbitmqVhost = storedConfig?.rabbitmqVhost || DEFAULT_RABBITMQ_VHOST;
  appState.rabbitmqExchange =
    storedConfig?.rabbitmqExchange || DEFAULT_RABBITMQ_EXCHANGE;
  appState.rabbitmqRoutingKey =
    storedConfig?.rabbitmqRoutingKey || DEFAULT_RABBITMQ_ROUTING_KEY;
  appState.broadcastEnabled = Boolean(storedConfig?.enabled && hasBroadcastDestination());

  if (appState.broadcastEnabled) {
    emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
    return;
  }

  emitBroadcastStatus("Disabled", "idle");
}

export function setBroadcastTargetUrl(value) {
  appState.broadcastTargetUrl = normalizeBroadcastUrl(value);

  if (!hasBroadcastDestination() && appState.broadcastEnabled) {
    disableBroadcastingState();
    emitBroadcastStatus("Disabled", "idle");
  } else if (appState.broadcastEnabled && activeBroadcastMode() === "webhook") {
    emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
  }

  persistBroadcastConfig();
}

export function setRabbitMqConfig(patch) {
  appState.rabbitmqUrl = normalizeBroadcastUrl(
    patch?.url ?? appState.rabbitmqUrl,
  );
  appState.rabbitmqVhost = normalizeRabbitMqField(
    patch?.vhost ?? appState.rabbitmqVhost,
    DEFAULT_RABBITMQ_VHOST,
  );
  appState.rabbitmqExchange = normalizeRabbitMqField(
    patch?.exchange ?? appState.rabbitmqExchange,
    DEFAULT_RABBITMQ_EXCHANGE,
  );
  appState.rabbitmqRoutingKey = normalizeRabbitMqField(
    patch?.routingKey ?? appState.rabbitmqRoutingKey,
    DEFAULT_RABBITMQ_ROUTING_KEY,
  );

  if (!hasBroadcastDestination() && appState.broadcastEnabled) {
    disableBroadcastingState();
    emitBroadcastStatus("Disabled", "idle");
  } else if (appState.broadcastEnabled && activeBroadcastMode() === "rabbitmq") {
    emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
  }

  persistBroadcastConfig();
}

export function toggleBroadcasting() {
  if (appState.broadcastEnabled) {
    disableBroadcastingState();
    emitBroadcastStatus("Disabled", "idle");
    return false;
  }

  if (!hasBroadcastDestination()) {
    emitBroadcastStatus("Enter a broadcast URL or RabbitMQ config first", "error");
    return false;
  }

  enableBroadcastingState();
  emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
  return true;
}

export function startBroadcasting() {
  if (appState.broadcastEnabled) {
    emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
    return true;
  }

  if (!hasBroadcastDestination()) {
    emitBroadcastStatus("Enter a broadcast URL or RabbitMQ config first", "error");
    return false;
  }

  enableBroadcastingState();
  emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
  return true;
}

export function stopBroadcasting() {
  if (!appState.broadcastEnabled) {
    emitBroadcastStatus("Disabled", "idle");
    return false;
  }

  disableBroadcastingState();
  emitBroadcastStatus("Disabled", "idle");
  return true;
}

export function queueBroadcastPayload(payload) {
  if (!appState.broadcastEnabled || !hasBroadcastDestination() || !payload) {
    return;
  }

  broadcasterState.pendingPayload = payload;
  void flushBroadcastQueue();
}
