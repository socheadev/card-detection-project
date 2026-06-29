import {
  AUTO_LOAD_STREAM,
  BROADCAST_STATUS_IDLE_TEXT,
  COPY_BUTTON_IDLE_TEXT,
  DEFAULT_CONFIDENCE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_IOU,
  DEFAULT_RABBITMQ_EXCHANGE,
  DEFAULT_RABBITMQ_ROUTING_KEY,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_RABBITMQ_VHOST,
  DEFAULT_STREAM_URL,
  MODEL_BADGE_IDLE_TEXT,
  RAW_MODEL_OUTPUT_IDLE_TEXT,
  STATUS_WAITING_FOR_STREAM_TEXT,
  appState,
  emitStatusChanged,
  els,
  MODEL_BADGE_ERROR_TEXT,
  onPreviewEvent,
  PREVIEW_EVENTS,
  runtimeView,
} from "./shared.js";
import {
  hasBroadcastDestination,
  initBroadcasting,
  setRabbitMqConfig,
  startBroadcasting,
  stopBroadcasting,
  setBroadcastTargetUrl,
  toggleBroadcasting,
} from "./broadcast.js";
import { startDetection, stopDetection } from "./inference.js";
import {
  drawOverlay,
  renderCardsOverlay,
  renderRawModelOutput,
  renderRuntimeSummary,
  resizeOverlay,
} from "./render.js";
import { initRoiEditor, renderRoiEditor } from "./roi-editor.js";
import {
  loadStreamFromInput,
} from "./stream.js";

const COPY_BUTTON_RESET_MS = 1400;
const RABBITMQ_VIEWER_POLL_MS = 1000;
const RABBITMQ_VIEWER_IDLE_TEXT = "Waiting for first HTTP publish";
const RABBITMQ_VIEWER_EMPTY_OUTPUT = "";

let copyButtonResetTimer = 0;
let resizeObserver = null;
let detectRequestId = 0;
let rabbitMqViewerPollTimer = 0;
let rabbitMqViewerRequestInFlight = false;

function setElementState(element, stateName) {
  if (element) {
    element.dataset.state = stateName;
  }
}

function applyModelPresentation({ badgeText, badgeState } = {}) {
  if (typeof badgeText === "string" && els.modelBadge) {
    els.modelBadge.textContent = badgeText;
  }

  if (typeof badgeState === "string") {
    setElementState(els.modelBadge, badgeState);
  }
}

function renderDetectionUi() {
  const uiStartedAt = performance.now();

  drawOverlay();
  renderCardsOverlay(runtimeView.displayedDetections);
  renderRawModelOutput(runtimeView);

  runtimeView.lastUiRenderMs = performance.now() - uiStartedAt;

  renderRuntimeSummary(runtimeView);
}

async function reload(loadFn, value) {
  if (appState.loadingStream) {
    return false;
  }

  stopDetection();
  appState.loadingStream = true;
  syncDetectionControls();

  try {
    return await loadFn(value);
  } finally {
    appState.loadingStream = false;
    syncDetectionControls();
  }
}

function syncDetectionControls() {
  if (els.loadStreamBtn) {
    els.loadStreamBtn.disabled =
      appState.loadingStream || appState.preparingDetection || appState.startingDetection;
    els.loadStreamBtn.textContent = appState.loadingStream
      ? "Loading..."
      : "Load Stream";
  }

  if (els.startDetectBtn) {
    els.startDetectBtn.disabled =
      appState.loadingStream ||
      appState.preparingDetection ||
      appState.detecting ||
      appState.startingDetection;
    els.startDetectBtn.textContent =
      appState.preparingDetection || appState.startingDetection
        ? "Starting..."
        : appState.streamReady
          ? "Start Detect"
          : "Load + Detect";
  }

  if (els.stopDetectBtn) {
    els.stopDetectBtn.disabled =
      !appState.preparingDetection && !appState.detecting && !appState.startingDetection;
  }
}

function syncBroadcastControls() {
  if (els.toggleBroadcastBtn) {
    els.toggleBroadcastBtn.textContent = appState.broadcastEnabled
      ? "Stop Broadcast"
      : "Start Broadcast";
    els.toggleBroadcastBtn.dataset.state = appState.broadcastEnabled ? "ready" : "idle";
  }
}

async function ensureStreamReadyForDetection() {
  if (appState.streamReady) {
    return true;
  }

  if (!els.sourceInput?.value?.trim()) {
    emitStatusChanged("Enter a stream URL first");
    return false;
  }

  emitStatusChanged("Loading stream before detection...");
  return reload(loadStreamFromInput);
}

async function writeTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");

  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";

  document.body.append(textArea);
  textArea.select();

  const copied = document.execCommand("copy");

  textArea.remove();

  if (!copied) {
    throw new Error("Clipboard copy is not available in this browser");
  }
}

function setCopyButtonState(text, stateName) {
  if (!els.copyRawModelBtn) {
    return;
  }

  els.copyRawModelBtn.textContent = text;
  els.copyRawModelBtn.dataset.state = stateName;
}

function scheduleCopyButtonReset() {
  window.clearTimeout(copyButtonResetTimer);
  copyButtonResetTimer = window.setTimeout(() => {
    setCopyButtonState(COPY_BUTTON_IDLE_TEXT, "idle");
  }, COPY_BUTTON_RESET_MS);
}

async function copyRawModelOutput() {
  const text = els.rawModelOutput?.textContent?.trim() || "";

  if (!text || text === RAW_MODEL_OUTPUT_IDLE_TEXT) {
    setCopyButtonState("No Data", "error");
    scheduleCopyButtonReset();
    return;
  }

  try {
    await writeTextToClipboard(text);
    setCopyButtonState("Copied", "success");
  } catch {
    setCopyButtonState("Copy Failed", "error");
  }

  scheduleCopyButtonReset();
}

function setRabbitMqViewerStatus(text, state = "idle") {
  if (!els.rabbitmqViewerStatus) {
    return;
  }

  els.rabbitmqViewerStatus.textContent = text;
  els.rabbitmqViewerStatus.dataset.state = state;
}

function renderRabbitMqViewer(snapshot = {}) {
  if (els.rabbitmqViewerCount) {
    els.rabbitmqViewerCount.textContent = String(snapshot.totalPublished || 0);
  }

  if (els.rabbitmqViewerOutput) {
    els.rabbitmqViewerOutput.textContent = snapshot.payload
      ? JSON.stringify(snapshot.payload, null, 2)
      : RABBITMQ_VIEWER_EMPTY_OUTPUT;
  }

  if (snapshot.lastError) {
    setRabbitMqViewerStatus(`Publish error: ${snapshot.lastError}`, "error");
    return;
  }

  if (snapshot.publishedAt) {
    const publishedAt = new Date(snapshot.publishedAt);
    const publishedText = Number.isNaN(publishedAt.getTime())
      ? snapshot.publishedAt
      : publishedAt.toLocaleTimeString();

    setRabbitMqViewerStatus(`Live: ${publishedText}`, "ready");
    return;
  }

  setRabbitMqViewerStatus(RABBITMQ_VIEWER_IDLE_TEXT, "idle");
}

async function refreshRabbitMqViewer() {
  if (rabbitMqViewerRequestInFlight) {
    return;
  }

  rabbitMqViewerRequestInFlight = true;

  try {
    const response = await fetch("/broadcast/rabbitmq/latest", {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const snapshot = await response.json();
    renderRabbitMqViewer(snapshot);
  } catch (error) {
    setRabbitMqViewerStatus(`Viewer unavailable: ${error.message}`, "error");
  } finally {
    rabbitMqViewerRequestInFlight = false;
  }
}

function startRabbitMqViewerPolling() {
  window.clearInterval(rabbitMqViewerPollTimer);
  rabbitMqViewerPollTimer = window.setInterval(() => {
    void refreshRabbitMqViewer();
  }, RABBITMQ_VIEWER_POLL_MS);
  void refreshRabbitMqViewer();
}

function redrawStage() {
  resizeOverlay();
  drawOverlay();
  renderRoiEditor();
}

function bindEvents() {
  els.loadStreamBtn?.addEventListener("click", () => {
    reload(loadStreamFromInput);
  });

  els.startDetectBtn?.addEventListener("click", async () => {
    if (appState.preparingDetection || appState.detecting || appState.startingDetection) {
      syncDetectionControls();
      return;
    }

    const requestId = ++detectRequestId;
    appState.preparingDetection = true;
    syncDetectionControls();

    try {
      const streamReady = await ensureStreamReadyForDetection();

      if (requestId !== detectRequestId || !appState.preparingDetection) {
        return;
      }

      if (!streamReady) {
        return;
      }

      if (hasBroadcastDestination()) {
        startBroadcasting();
      }

      appState.preparingDetection = false;
      await startDetection();
    } finally {
      if (requestId === detectRequestId) {
        appState.preparingDetection = false;
      }
      syncDetectionControls();
    }
  });
  els.stopDetectBtn?.addEventListener("click", () => {
    detectRequestId += 1;
    appState.preparingDetection = false;
    stopDetection();
    if (appState.broadcastEnabled) {
      stopBroadcasting();
    }
    emitStatusChanged("Detection stopped");
    syncBroadcastControls();
    syncDetectionControls();
  });
  els.toggleBroadcastBtn?.addEventListener("click", () => {
    toggleBroadcasting();
    syncBroadcastControls();
  });
  els.copyRawModelBtn?.addEventListener("click", copyRawModelOutput);
  els.broadcastUrlInput?.addEventListener("input", (event) => {
    setBroadcastTargetUrl(event.currentTarget?.value || "");
    syncBroadcastControls();
  });
  els.rabbitmqUrlInput?.addEventListener("input", (event) => {
    setRabbitMqConfig({ url: event.currentTarget?.value || "" });
    syncBroadcastControls();
  });
  els.rabbitmqVhostInput?.addEventListener("input", (event) => {
    setRabbitMqConfig({ vhost: event.currentTarget?.value || "" });
    syncBroadcastControls();
  });
  els.rabbitmqExchangeInput?.addEventListener("input", (event) => {
    setRabbitMqConfig({ exchange: event.currentTarget?.value || "" });
    syncBroadcastControls();
  });
  els.rabbitmqRoutingKeyInput?.addEventListener("input", (event) => {
    setRabbitMqConfig({ routingKey: event.currentTarget?.value || "" });
    syncBroadcastControls();
  });

  els.sourceInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      reload(loadStreamFromInput);
    }
  });

  els.video?.addEventListener("loadedmetadata", redrawStage);
  els.video?.addEventListener("loadeddata", redrawStage);
  els.video?.addEventListener("canplay", redrawStage);
  els.video?.addEventListener("playing", redrawStage);
  window.addEventListener("resize", redrawStage);

  if (window.ResizeObserver && els.video) {
    resizeObserver = new ResizeObserver(redrawStage);
    resizeObserver.observe(els.video);
  }
}

function bindPreviewEvents() {
  onPreviewEvent(PREVIEW_EVENTS.runtimeViewChanged, () => {
    renderDetectionUi();
    redrawStage();
    syncDetectionControls();
  });
  onPreviewEvent(PREVIEW_EVENTS.overlayInvalidated, drawOverlay);
  onPreviewEvent(PREVIEW_EVENTS.statusChanged, (event) => {
    if (els.statusText) {
      els.statusText.textContent = event.detail.text;
    }

    syncDetectionControls();
  });
  onPreviewEvent(PREVIEW_EVENTS.modelPresentationChanged, (event) => {
    applyModelPresentation(event.detail);
  });
  onPreviewEvent(PREVIEW_EVENTS.broadcastStateChanged, (event) => {
    if (els.broadcastStatusValue) {
      els.broadcastStatusValue.textContent = event.detail.text;
      els.broadcastStatusValue.dataset.state = event.detail.state;
    }

    syncBroadcastControls();
  });
}

function applyDefaults() {
  if (els.sourceInput && !els.sourceInput.value) {
    els.sourceInput.value = DEFAULT_STREAM_URL;
  }

  if (els.confidenceInput) {
    els.confidenceInput.value = String(DEFAULT_CONFIDENCE);
  }

  if (els.iouInput) {
    els.iouInput.value = String(DEFAULT_IOU);
  }

  if (els.intervalInput) {
    els.intervalInput.value = String(DEFAULT_INTERVAL_MS);
  }

  initBroadcasting();

  if (els.broadcastUrlInput) {
    els.broadcastUrlInput.value = appState.broadcastTargetUrl;
  }
  if (els.rabbitmqUrlInput) {
    els.rabbitmqUrlInput.value = appState.rabbitmqUrl || DEFAULT_RABBITMQ_URL;
  }
  if (els.rabbitmqVhostInput) {
    els.rabbitmqVhostInput.value = appState.rabbitmqVhost || DEFAULT_RABBITMQ_VHOST;
  }
  if (els.rabbitmqExchangeInput) {
    els.rabbitmqExchangeInput.value =
      appState.rabbitmqExchange || DEFAULT_RABBITMQ_EXCHANGE;
  }
  if (els.rabbitmqRoutingKeyInput) {
    els.rabbitmqRoutingKeyInput.value =
      appState.rabbitmqRoutingKey || DEFAULT_RABBITMQ_ROUTING_KEY;
  }

  if (els.modelBadge) {
    els.modelBadge.textContent = MODEL_BADGE_IDLE_TEXT;
    setElementState(els.modelBadge, "idle");
  }

  if (els.statusText) {
    els.statusText.textContent = STATUS_WAITING_FOR_STREAM_TEXT;
  }

  if (els.copyRawModelBtn) {
    els.copyRawModelBtn.textContent = COPY_BUTTON_IDLE_TEXT;
    setElementState(els.copyRawModelBtn, "idle");
  }

  if (els.broadcastStatusValue) {
    if (!els.broadcastStatusValue.textContent?.trim()) {
      els.broadcastStatusValue.textContent = BROADCAST_STATUS_IDLE_TEXT;
    }
  }

  renderRabbitMqViewer();

  if (els.rawModelOutput) {
    els.rawModelOutput.textContent = RAW_MODEL_OUTPUT_IDLE_TEXT;
  }

  syncDetectionControls();
  syncBroadcastControls();
}

function bindLifecycle() {
  window.addEventListener("beforeunload", () => {
    stopDetection();
    window.clearInterval(rabbitMqViewerPollTimer);

    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  });
}

async function init() {
  bindPreviewEvents();
  applyDefaults();
  bindEvents();
  bindLifecycle();
  initRoiEditor();
  renderDetectionUi();
  startRabbitMqViewerPolling();
  redrawStage();

  if (AUTO_LOAD_STREAM && els.sourceInput?.value?.trim()) {
    await reload(loadStreamFromInput);
  }
}

try {
  Promise.resolve(init()).catch((error) => {
    applyModelPresentation({
      badgeText: MODEL_BADGE_ERROR_TEXT,
      badgeState: "error",
    });

    if (els.statusText) {
      els.statusText.textContent = `Initialization failed: ${error.message}`;
    }

    throw error;
  });
} catch (error) {
  applyModelPresentation({
    badgeText: MODEL_BADGE_ERROR_TEXT,
    badgeState: "error",
  });

  if (els.statusText) {
    els.statusText.textContent = `Initialization failed: ${error.message}`;
  }

  throw error;
}
