import {
  appState,
  clamp,
  currentRoiConfig,
  currentRoiSlotConfig,
  els,
  emitStatusChanged,
  exportRoiLayout,
  importRoiLayout,
  onPreviewEvent,
  PREVIEW_EVENTS,
  referencePixelsToRoiBounds,
  resetRoiConfig,
  ROI_ORDER,
  ROI_REFERENCE_FRAME,
  ROI_SIDE,
  ROI_SLOT_OPTIONS,
  roiBoundsToReferencePixels,
  roiSlotValue,
  runtimeView,
  updateRoiConfig,
  updateRoiSlotConfig,
} from "./shared.js";
import { currentVisibleFrameRect } from "./render.js";

const HANDLE_ORDER = ["nw", "ne", "sw", "se"];

let interaction = null;

function currentEditorSourceSize() {
  const detectedWidth = Math.round(runtimeView.rawModelOutput?.frame?.width || 0);
  const detectedHeight = Math.round(runtimeView.rawModelOutput?.frame?.height || 0);

  if (detectedWidth && detectedHeight) {
    return {
      width: detectedWidth,
      height: detectedHeight,
    };
  }

  if (appState.streamMode === "iframe") {
    const frameRect = els.remoteFrame?.getBoundingClientRect();

    if (frameRect?.width && frameRect?.height) {
      return {
        width: Math.round(frameRect.width),
        height: Math.round(frameRect.height),
      };
    }
  }

  return {
    width: els.video?.videoWidth || 0,
    height: els.video?.videoHeight || 0,
  };
}

function renderRoiLabel(roi) {
  return `${roi} · slot ${roiSlotValue(roi)}`;
}

function setEditorButtonState() {
  if (!els.toggleRoiEditorBtn) {
    return;
  }

  els.toggleRoiEditorBtn.textContent = appState.roiEditorEnabled
    ? "Done"
    : "Edit Boxs";
  els.toggleRoiEditorBtn.dataset.state = appState.roiEditorEnabled
    ? "editing"
    : "idle";
}

function renderBoxMarkup(roi) {
  return `
    <div class="roi-editor-box" data-roi="${roi}" data-side="${ROI_SIDE[roi]}">
      <span class="roi-editor-label">${renderRoiLabel(roi)}</span>
      ${HANDLE_ORDER.map(
        (handle) =>
          `<span class="roi-editor-handle" data-roi="${roi}" data-handle="${handle}"></span>`,
      ).join("")}
    </div>
  `;
}

function renderInputMarkup(roi) {
  const bounds = roiBoundsToReferencePixels(currentRoiConfig()[roi]);
  const slot = currentRoiSlotConfig()[roi];

  return `
    <div class="roi-input-row" data-roi-row="${roi}">
      <div class="roi-input-name" data-side="${ROI_SIDE[roi]}">${roi}</div>
      <label class="field roi-slot-field">
        <span>Slot</span>
        <select data-roi-slot="${roi}">
          ${ROI_SLOT_OPTIONS.map(
            (value) =>
              `<option value="${value}"${value === slot ? " selected" : ""}>${value}</option>`,
          ).join("")}
        </select>
      </label>
      <label class="field roi-mini-field">
        <span>X1</span>
        <input type="number" min="0" max="${ROI_REFERENCE_FRAME.width}" step="1" data-roi-input="${roi}" data-key="x1" value="${bounds.x1}" />
      </label>
      <label class="field roi-mini-field">
        <span>Y1</span>
        <input type="number" min="0" max="${ROI_REFERENCE_FRAME.height}" step="1" data-roi-input="${roi}" data-key="y1" value="${bounds.y1}" />
      </label>
      <label class="field roi-mini-field">
        <span>W</span>
        <input type="number" min="1" max="${ROI_REFERENCE_FRAME.width}" step="1" data-roi-input="${roi}" data-key="width" value="${bounds.width}" />
      </label>
      <label class="field roi-mini-field">
        <span>H</span>
        <input type="number" min="1" max="${ROI_REFERENCE_FRAME.height}" step="1" data-roi-input="${roi}" data-key="height" value="${bounds.height}" />
      </label>
    </div>
  `;
}

function renderRoiInputs() {
  if (!els.roiInputsPanel) {
    return;
  }

  els.roiInputsPanel.innerHTML = `
    <div class="roi-inputs-header">
      <p class="roi-inputs-note">
        Box inputs use the ${ROI_REFERENCE_FRAME.width}x${ROI_REFERENCE_FRAME.height} reference frame.
      </p>
      <button
        type="button"
        class="roi-inputs-toggle"
        data-roi-inputs-toggle
        aria-expanded="${appState.roiInputsCollapsed ? "false" : "true"}"
        aria-controls="roiInputsGrid"
      >
        ${appState.roiInputsCollapsed ? "Expand" : "Collapse"}
      </button>
    </div>
    ${
      appState.roiInputsCollapsed
        ? ""
        : `
      <div class="roi-inputs-grid" id="roiInputsGrid">
        ${ROI_ORDER.map(renderInputMarkup).join("")}
      </div>
    `
    }
  `;
}

export function renderRoiEditor() {
  if (!els.roiEditorOverlay) {
    return;
  }

  renderRoiInputs();
  setEditorButtonState();

  if (!appState.roiEditorEnabled) {
    els.roiEditorOverlay.classList.remove("is-enabled");
    els.roiEditorOverlay.innerHTML = "";
    return;
  }

  const frameRect = currentVisibleFrameRect();
  const { width: videoWidth, height: videoHeight } = currentEditorSourceSize();

  els.roiEditorOverlay.classList.add("is-enabled");

  if (!frameRect || !videoWidth || !videoHeight) {
    els.roiEditorOverlay.innerHTML = "";
    return;
  }

  if (!els.roiEditorOverlay.childElementCount) {
    els.roiEditorOverlay.innerHTML = ROI_ORDER.map(renderBoxMarkup).join("");
  }

  const roiConfig = currentRoiConfig();

  for (const roi of ROI_ORDER) {
    const boxNode = els.roiEditorOverlay.querySelector(`[data-roi="${roi}"]`);
    const bounds = roiConfig[roi];

    if (!boxNode || !bounds) {
      continue;
    }

    const labelNode = boxNode.querySelector(".roi-editor-label");

    if (labelNode) {
      labelNode.textContent = renderRoiLabel(roi);
    }

    const left = frameRect.x + bounds.minX * videoWidth * frameRect.scale;
    const top = frameRect.y + bounds.minY * videoHeight * frameRect.scale;
    const width = (bounds.maxX - bounds.minX) * videoWidth * frameRect.scale;
    const height = (bounds.maxY - bounds.minY) * videoHeight * frameRect.scale;

    boxNode.style.left = `${left}px`;
    boxNode.style.top = `${top}px`;
    boxNode.style.width = `${width}px`;
    boxNode.style.height = `${height}px`;
  }
}

function startInteraction(event) {
  if (!appState.roiEditorEnabled) {
    return;
  }

  const handleNode = event.target.closest("[data-handle]");
  const boxNode = event.target.closest(".roi-editor-box");
  const roi = handleNode?.dataset.roi || boxNode?.dataset.roi || "";

  if (!roi) {
    return;
  }

  const frameRect = currentVisibleFrameRect();
  const { width: videoWidth, height: videoHeight } = currentEditorSourceSize();

  if (!frameRect || !videoWidth || !videoHeight) {
    return;
  }

  event.preventDefault();

  interaction = {
    roi,
    mode: handleNode?.dataset.handle || "move",
    startX: event.clientX,
    startY: event.clientY,
    startBounds: currentRoiConfig()[roi],
    scale: frameRect.scale,
    videoWidth,
    videoHeight,
  };
}

function movedBounds(startBounds, dx, dy) {
  const width = startBounds.maxX - startBounds.minX;
  const height = startBounds.maxY - startBounds.minY;
  let minX = startBounds.minX + dx;
  let maxX = startBounds.maxX + dx;
  let minY = startBounds.minY + dy;
  let maxY = startBounds.maxY + dy;

  if (minX < 0) {
    maxX -= minX;
    minX = 0;
  }

  if (maxX > 1) {
    minX -= maxX - 1;
    maxX = 1;
  }

  if (minY < 0) {
    maxY -= minY;
    minY = 0;
  }

  if (maxY > 1) {
    minY -= maxY - 1;
    maxY = 1;
  }

  return {
    minX: clamp(minX, 0, 1 - width),
    maxX: clamp(maxX, width, 1),
    minY: clamp(minY, 0, 1 - height),
    maxY: clamp(maxY, height, 1),
  };
}

function resizedBounds(mode, startBounds, dx, dy, videoWidth, videoHeight) {
  const minWidth = 24 / videoWidth;
  const minHeight = 24 / videoHeight;
  const nextBounds = { ...startBounds };

  if (mode.includes("w")) {
    nextBounds.minX = clamp(startBounds.minX + dx, 0, startBounds.maxX - minWidth);
  }

  if (mode.includes("e")) {
    nextBounds.maxX = clamp(startBounds.maxX + dx, startBounds.minX + minWidth, 1);
  }

  if (mode.includes("n")) {
    nextBounds.minY = clamp(startBounds.minY + dy, 0, startBounds.maxY - minHeight);
  }

  if (mode.includes("s")) {
    nextBounds.maxY = clamp(startBounds.maxY + dy, startBounds.minY + minHeight, 1);
  }

  return nextBounds;
}

function updateInteraction(event) {
  if (!interaction) {
    return;
  }

  event.preventDefault();

  const dx =
    (event.clientX - interaction.startX) /
    (interaction.scale * interaction.videoWidth);
  const dy =
    (event.clientY - interaction.startY) /
    (interaction.scale * interaction.videoHeight);

  const nextBounds =
    interaction.mode === "move"
      ? movedBounds(interaction.startBounds, dx, dy)
      : resizedBounds(
          interaction.mode,
          interaction.startBounds,
          dx,
          dy,
          interaction.videoWidth,
          interaction.videoHeight,
        );

  updateRoiConfig(interaction.roi, nextBounds);
  renderRoiEditor();
}

function stopInteraction() {
  interaction = null;
}

function toggleRoiEditor() {
  appState.roiEditorEnabled = !appState.roiEditorEnabled;
  renderRoiEditor();
  emitStatusChanged(
    appState.roiEditorEnabled ? "ROI editor enabled" : "ROI editor disabled",
  );
}

function resetEditorRois() {
  resetRoiConfig();
  renderRoiEditor();
  emitStatusChanged("ROIs reset to defaults");
}

function saveEditorRois() {
  const blob = new Blob([JSON.stringify(exportRoiLayout(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = "roi-layout.json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  emitStatusChanged("ROI layout saved");
}

function openRoiFilePicker() {
  els.roiFileInput?.click();
}

async function loadEditorRois(event) {
  const file = event.target?.files?.[0];

  if (!file) {
    return;
  }

  try {
    importRoiLayout(JSON.parse(await file.text()));
    renderRoiEditor();
    emitStatusChanged("ROI layout loaded");
  } catch (error) {
    emitStatusChanged(`ROI load failed: ${error.message}`);
  } finally {
    if (els.roiFileInput) {
      els.roiFileInput.value = "";
    }
  }
}

function updateRoiFromInputs(roi) {
  const inputNodes = els.roiInputsPanel?.querySelectorAll(`[data-roi-input="${roi}"]`);

  if (!inputNodes?.length) {
    return;
  }

  const values = Array.from(inputNodes).reduce((nextValues, input) => {
    const key = input.dataset.key;
    const value = Number.parseInt(input.value, 10);

    nextValues[key] = Number.isFinite(value) ? value : 0;
    return nextValues;
  }, {});

  const width = clamp(values.width || 1, 1, ROI_REFERENCE_FRAME.width);
  const height = clamp(values.height || 1, 1, ROI_REFERENCE_FRAME.height);
  const x1 = clamp(values.x1 || 0, 0, ROI_REFERENCE_FRAME.width - width);
  const y1 = clamp(values.y1 || 0, 0, ROI_REFERENCE_FRAME.height - height);

  updateRoiConfig(
    roi,
    referencePixelsToRoiBounds({
      x1,
      y1,
      width,
      height,
    }),
  );
  renderRoiEditor();
}

function handlePanelClick(event) {
  if (event.target?.closest("[data-roi-inputs-toggle]")) {
    appState.roiInputsCollapsed = !appState.roiInputsCollapsed;
    renderRoiEditor();
  }
}

function handlePanelChange(event) {
  const roiInput = event.target?.dataset?.roiInput;
  const roiSlot = event.target?.dataset?.roiSlot;

  if (roiInput) {
    updateRoiFromInputs(roiInput);
    return;
  }

  if (roiSlot) {
    updateRoiSlotConfig(roiSlot, event.target.value);
    renderRoiEditor();
  }
}

export function initRoiEditor() {
  renderRoiInputs();
  setEditorButtonState();

  els.toggleRoiEditorBtn?.addEventListener("click", toggleRoiEditor);
  els.loadRoiEditorBtn?.addEventListener("click", openRoiFilePicker);
  els.saveRoiEditorBtn?.addEventListener("click", saveEditorRois);
  els.resetRoiEditorBtn?.addEventListener("click", resetEditorRois);
  els.roiFileInput?.addEventListener("change", loadEditorRois);
  els.roiInputsPanel?.addEventListener("click", handlePanelClick);
  els.roiInputsPanel?.addEventListener("change", handlePanelChange);
  els.roiEditorOverlay?.addEventListener("pointerdown", startInteraction);
  window.addEventListener("pointermove", updateInteraction);
  window.addEventListener("pointerup", stopInteraction);
  window.addEventListener("pointercancel", stopInteraction);

  onPreviewEvent(PREVIEW_EVENTS.overlayInvalidated, renderRoiEditor);
}
