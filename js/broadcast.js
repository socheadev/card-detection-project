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
  lastSentKey: "",
};
function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function normalizeRabbitMqField(value, fallback = "") {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function isRabbitMqConfigured() {
  return Boolean(
    normalizeRabbitMqField(appState.rabbitmqVhost) &&
      normalizeRabbitMqField(appState.rabbitmqExchange) &&
      normalizeRabbitMqField(appState.rabbitmqRoutingKey),
  );
}

export function hasBroadcastDestination() {
  return isRabbitMqConfigured();
}

function activeBroadcastMode() {
  if (isRabbitMqConfigured()) {
    return "rabbitmq";
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

function summarizeRabbitMq() {
  const exchange = normalizeRabbitMqField(appState.rabbitmqExchange);
  const routingKey = normalizeRabbitMqField(appState.rabbitmqRoutingKey);

  return `RabbitMQ ${exchange}:${routingKey}`;
}

function currentDestinationSummary() {
  return summarizeRabbitMq();
}

async function postBroadcastPayload(payload) {
  if (!appState.broadcastEnabled || !hasBroadcastDestination()) {
    return;
  }

  const message =
    payload && typeof payload === "object" && "payload" in payload
      ? payload
      : { payload, rawModelOutput: null };

  const response = await fetch("/broadcast/rabbitmq", {
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

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const detail = errorText ? `: ${errorText}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
}

function broadcastPayloadKey(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
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
      const payloadKey = broadcastPayloadKey(payload);

      if (payloadKey && payloadKey === broadcasterState.lastSentKey) {
        continue;
      }

      emitBroadcastStatus("Sending...", "loading");
      await postBroadcastPayload(payload);
      broadcasterState.lastSentKey = payloadKey;

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
}

function enableBroadcastingState() {
  appState.broadcastEnabled = true;
}

export function initBroadcasting() {
  const storedConfig = readStoredBroadcastConfig();

  appState.broadcastTargetUrl = "";
  appState.rabbitmqUrl = DEFAULT_RABBITMQ_URL;
  appState.rabbitmqVhost = storedConfig?.rabbitmqVhost || DEFAULT_RABBITMQ_VHOST;
  appState.rabbitmqExchange =
    storedConfig?.rabbitmqExchange || DEFAULT_RABBITMQ_EXCHANGE;
  appState.rabbitmqRoutingKey =
    storedConfig?.rabbitmqRoutingKey || DEFAULT_RABBITMQ_ROUTING_KEY;
  appState.broadcastEnabled = hasBroadcastDestination();

  if (appState.broadcastEnabled) {
    emitBroadcastStatus(`Enabled: ${currentDestinationSummary()}`, "ready");
    return;
  }

  emitBroadcastStatus("Disabled", "idle");
}

export function queueBroadcastPayload(payload) {
  if (!appState.broadcastEnabled || !hasBroadcastDestination() || !payload) {
    return;
  }

  const payloadKey = broadcastPayloadKey(payload);

  if (payloadKey && payloadKey === broadcasterState.lastSentKey) {
    return;
  }

  broadcasterState.pendingPayload = payload;
  void flushBroadcastQueue();
}
