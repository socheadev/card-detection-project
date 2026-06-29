import {
  AUTO_LOAD_STREAM,
  BROADCAST_STATUS_IDLE_TEXT,
  COPY_BUTTON_IDLE_TEXT,
  DEFAULT_CONFIDENCE,
  DEFAULT_DETECT_EVERY_NTH_FRAME,
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
  setBroadcastTargetUrl,
  toggleBroadcasting,
} from "./broadcast.js";
import {
  applyExternalDetections,
  startDetection,
  stopDetection,
} from "./inference.js";
import {
  drawOverlay,
  renderCardsOverlay,
  renderRawModelOutput,
  renderRuntimeSummary,
  resizeOverlay,
  syncViewerStageAspectRatio,
} from "./render.js";
import { initRoiEditor, renderRoiEditor } from "./roi-editor.js";
import {
  loadStreamFromInput,
} from "./stream.js";

const COPY_BUTTON_RESET_MS = 1400;
const DETECTOR_POLL_MS = 500;

let copyButtonResetTimer = 0;
let detectorPollTimer = 0;
let lastDetectorUpdatedAt = "";
let resizeObserver = null;

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

async function startAutoDetection() {
  if (appState.streamMode === "iframe") {
    return;
  }

  if (hasBroadcastDestination()) {
    startBroadcasting();
  }

  await startDetection();
}

async function reload(loadFn, value) {
  if (appState.loadingStream) {
    return false;
  }

  stopDetection();
  appState.loadingStream = true;
  appState.preparingDetection = true;
  syncDetectionControls();

  try {
    const loaded = await loadFn(value);

    if (!loaded) {
      return false;
    }

    await startAutoDetection();
    return true;
  } finally {
    appState.loadingStream = false;
    appState.preparingDetection = false;
    syncDetectionControls();
  }
}

function syncDetectionControls() {
  if (els.loadStreamBtn) {
    els.loadStreamBtn.disabled =
      appState.loadingStream || appState.preparingDetection || appState.startingDetection;
    els.loadStreamBtn.textContent = appState.loadingStream || appState.startingDetection
      ? "Loading..."
      : "Load Stream";
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

function redrawStage() {
  syncViewerStageAspectRatio();
  resizeOverlay();
  drawOverlay();
  renderRoiEditor();
}

async function pollDetectorResults() {
  if (appState.streamMode !== "iframe") {
    return;
  }

  try {
    const response = await fetch("/detector/latest", {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json();

    if (!payload?.payload || !payload?.updatedAt) {
      return;
    }

    if (payload.updatedAt === lastDetectorUpdatedAt) {
      return;
    }

    lastDetectorUpdatedAt = payload.updatedAt;
    applyExternalDetections(payload.payload);
  } catch {
    // Ignore detector polling failures and keep the current UI state.
  }
}

function bindEvents() {
  els.loadStreamBtn?.addEventListener("click", () => {
    reload(loadStreamFromInput);
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

  if (els.frameSkipInput) {
    els.frameSkipInput.value = String(DEFAULT_DETECT_EVERY_NTH_FRAME);
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
  if (els.rawModelOutput) {
    els.rawModelOutput.textContent = RAW_MODEL_OUTPUT_IDLE_TEXT;
  }

  syncDetectionControls();
  syncBroadcastControls();
}

function bindLifecycle() {
  detectorPollTimer = window.setInterval(pollDetectorResults, DETECTOR_POLL_MS);

  window.addEventListener("beforeunload", () => {
    stopDetection();

    if (detectorPollTimer) {
      window.clearInterval(detectorPollTimer);
      detectorPollTimer = 0;
    }

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
