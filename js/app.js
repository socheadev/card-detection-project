import {
  AUTO_LOAD_STREAM,
  COPY_BUTTON_IDLE_TEXT,
  DEFAULT_CONFIDENCE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_IOU,
  DEFAULT_STREAM_URL,
  MODEL_BADGE_IDLE_TEXT,
  RAW_MODEL_OUTPUT_IDLE_TEXT,
  STATUS_WAITING_FOR_STREAM_TEXT,
  els,
  MODEL_BADGE_ERROR_TEXT,
  onPreviewEvent,
  PREVIEW_EVENTS,
  runtimeView,
} from "./shared.js";
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
  loadVideoFile,
  openVideoFilePicker,
} from "./stream.js";

const COPY_BUTTON_RESET_MS = 1400;

let copyButtonResetTimer = 0;
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
  stopDetection();

  const loaded = await loadFn(value);

  if (loaded) {
    await startDetection();
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
  resizeOverlay();
  drawOverlay();
  renderRoiEditor();
}

function bindEvents() {
  els.loadStreamBtn?.addEventListener("click", () => {
    reload(loadStreamFromInput);
  });

  els.openVideoBtn?.addEventListener("click", openVideoFilePicker);
  els.copyRawModelBtn?.addEventListener("click", copyRawModelOutput);

  els.videoFileInput?.addEventListener("change", (event) => {
    reload(loadVideoFile, event.target.files?.[0] || null);
  });

  els.sourceInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      reload(loadStreamFromInput);
    }
  });

  els.video?.addEventListener("loadedmetadata", redrawStage);
  els.video?.addEventListener("play", () => {
    startDetection();
  });

  window.addEventListener("resize", redrawStage);

  if (window.ResizeObserver && els.video) {
    resizeObserver = new ResizeObserver(redrawStage);
    resizeObserver.observe(els.video);
  }
}

function bindPreviewEvents() {
  onPreviewEvent(PREVIEW_EVENTS.runtimeViewChanged, renderDetectionUi);
  onPreviewEvent(PREVIEW_EVENTS.overlayInvalidated, drawOverlay);
  onPreviewEvent(PREVIEW_EVENTS.statusChanged, (event) => {
    if (els.statusText) {
      els.statusText.textContent = event.detail.text;
    }
  });
  onPreviewEvent(PREVIEW_EVENTS.modelPresentationChanged, (event) => {
    applyModelPresentation(event.detail);
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

  if (els.rawModelOutput) {
    els.rawModelOutput.textContent = RAW_MODEL_OUTPUT_IDLE_TEXT;
  }
}

function bindLifecycle() {
  window.addEventListener("beforeunload", () => {
    stopDetection();

    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  });
}

async function init() {
  applyDefaults();
  bindEvents();
  bindPreviewEvents();
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
