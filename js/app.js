import {
  AUTO_LOAD_STREAM,
  BROADCAST_STATUS_IDLE_TEXT,
  COPY_BUTTON_IDLE_TEXT,
  DEFAULT_CONFIDENCE,
  DEFAULT_DETECT_EVERY_NTH_FRAME,
  DEFAULT_INTERVAL_MS,
  DEFAULT_IOU,
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
  clearLocalBroadcastPayload,
  hasBroadcastDestination,
  initBroadcasting,
  startBroadcasting,
  stopBroadcasting,
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

async function reload(loadFn, value) {
  if (appState.loadingStream) {
    return false;
  }

  stopDetection();
  stopBroadcasting();
  clearLocalBroadcastPayload();
  appState.loadingStream = true;
  appState.preparingDetection = true;
  syncDetectionControls();

  try {
    const loaded = await loadFn(value);

    if (!loaded) {
      return false;
    }

    if (appState.streamMode === "iframe") {
      emitStatusChanged(
        "Remote player loaded. Press Start Detection to receive detector results.",
      );
    } else {
      emitStatusChanged("Stream loaded. Press Start Detection to begin detection.");
    }

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

  if (els.startBtn) {
    const canStart =
      appState.streamReady &&
      !appState.loadingStream &&
      !appState.preparingDetection &&
      !appState.startingDetection &&
      !appState.detecting;
    els.startBtn.disabled = !canStart;
    els.startBtn.classList.toggle("is-ready", canStart);
    els.startBtn.classList.toggle("is-running", appState.detecting);
  }

  if (els.stopBtn) {
    const canStop = appState.detecting || appState.startingDetection;
    els.stopBtn.disabled = !canStop;
    els.stopBtn.classList.toggle("is-ready", canStop);
  }
}

function syncBroadcastControls() {}

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

  if (!appState.detecting) {
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

async function handleStartClick() {
  if (appState.streamMode === "iframe") {
    appState.detecting = true;
    appState.startingDetection = false;
    lastDetectorUpdatedAt = "";
    emitStatusChanged("Waiting for detector results...");

    if (hasBroadcastDestination()) {
      startBroadcasting();
    }

    syncDetectionControls();
    return;
  }

  await startDetection();

  if (appState.detecting && hasBroadcastDestination()) {
    startBroadcasting();
  }

  syncDetectionControls();
}

function handleStopClick() {
  stopDetection();
  stopBroadcasting();
  clearLocalBroadcastPayload();

  if (appState.streamReady) {
    emitStatusChanged("Detection stopped. Press Start Detection to run again.");
  } else {
    emitStatusChanged(STATUS_WAITING_FOR_STREAM_TEXT);
  }

  syncDetectionControls();
}

function bindEvents() {
  els.loadStreamBtn?.addEventListener("click", () => {
    reload(loadStreamFromInput);
  });
  els.startBtn?.addEventListener("click", handleStartClick);
  els.stopBtn?.addEventListener("click", handleStopClick);
  els.copyRawModelBtn?.addEventListener("click", copyRawModelOutput);

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
    stopBroadcasting();
    clearLocalBroadcastPayload();

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
