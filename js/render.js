import {
  appState,
  cardAssetUrl,
  cardsOverlayKey,
  els,
  fullFrameRoiBounds,
  groupDetectionsBySide,
  overlayCtx,
  ROI_ORDER,
  ROI_REFERENCE_FRAME,
  ROI_SIDE,
  roiSlotValue,
  runtimeView,
  SIDE_ORDER,
} from "./shared.js";

let cardsMarkupKey = "";
let rawOutputKey = "";
const DEFAULT_VIEWER_ASPECT_RATIO = "16 / 9";

const ROI_STYLES = {
  PLAYER: {
    fill: "rgba(37, 99, 235, 0.12)",
    stroke: "rgba(96, 165, 250, 0.9)",
  },
  BANKER: {
    fill: "rgba(217, 119, 6, 0.12)",
    stroke: "rgba(251, 191, 36, 0.9)",
  },
};

const RAW_BOX_STYLE = {
  stroke: "rgba(16, 185, 129, 0.95)",
  fill: "rgba(16, 185, 129, 0.12)",
  text: "#d1fae5",
};

function roundNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function normalizedCardLabel(value) {
  const label = String(value ?? "").trim();

  if (!label || label === "null" || label === "undefined") {
    return "";
  }

  return label;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDetection(detection) {
  return {
    label: detection.label,
    classId: detection.classId,
    score: roundNumber(detection.score, 5),
    roi: detection.roi || null,
    side: detection.side || null,
    box: {
      x1: roundNumber(detection.x, 4),
      y1: roundNumber(detection.y, 4),
      x2: roundNumber(detection.x + detection.width, 4),
      y2: roundNumber(detection.y + detection.height, 4),
    },
  };
}

function emptyCardPayload() {
  return {
    player: {
      card1: null,
      card2: null,
      card3: null,
    },
    banker: {
      card1: null,
      card2: null,
      card3: null,
    },
  };
}

function normalizeCardPayloadValue(value) {
  const normalized = String(value ?? "").trim().toUpperCase();

  return /^(10|[2-9AJQK])$/.test(normalized) ? normalized : null;
}

function normalizeCardPayloadEntry(entry) {
  const suit = typeof entry?.suit === "string" ? entry.suit : "";
  const value = normalizeCardPayloadValue(entry?.value);

  if (!suit || value === null) {
    return null;
  }

  return {
    suit,
    value,
  };
}

function normalizeCardPayload(source) {
  const payload = emptyCardPayload();

  for (const side of ["player", "banker"]) {
    for (const slot of ["card1", "card2", "card3"]) {
      payload[side][slot] = normalizeCardPayloadEntry(source?.[side]?.[slot]);
    }
  }

  return payload;
}

function payloadValue(rank) {
  const normalized = String(rank || "").trim().toUpperCase();

  return /^(10|[2-9AJQK])$/.test(normalized) ? normalized : null;
}

function payloadCardFromLabel(label) {
  const text = String(label || "").trim().toUpperCase();
  const match = text.match(/^(10|[2-9AJQK])([CDHS])$/);

  if (!match) {
    return null;
  }

  const SUIT_NAMES = {
    C: "clubs",
    D: "diamonds",
    H: "hearts",
    S: "spades",
  };
  const [, rank, suitCode] = match;
  const suit = SUIT_NAMES[suitCode] || null;
  const value = payloadValue(rank);

  if (!suit || value === null) {
    return null;
  }

  return {
    suit,
    value,
  };
}

function payloadFromDisplayedDetections(displayedDetections) {
  const payload = emptyCardPayload();

  for (const detection of displayedDetections || []) {
    const side = String(detection?.side || "").toUpperCase();
    const slot = detection?.roi ? roiSlotValue(detection.roi) : null;
    const card = payloadCardFromLabel(detection?.label);
    const key = Number.isFinite(slot) ? `card${slot}` : "";

    if (!key || !card) {
      continue;
    }

    if (side === "PLAYER") {
      payload.player[key] = card;
    } else if (side === "BANKER") {
      payload.banker[key] = card;
    }
  }

  return payload;
}

export function formatCardGroupsForDisplay(payload) {
  const grouped = {
    player: [],
    banker: [],
  };

  for (const side of ["player", "banker"]) {
    const items = Array.isArray(payload?.[side]) ? payload[side] : [];

    for (const item of items) {
      grouped[side].push({
        name: item?.name || "",
        slot: Number.isFinite(item?.slot) ? item.slot : null,
      });
    }
  }

  const compareCards = (left, right) => {
    const leftSlot = Number.isFinite(left?.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
    const rightSlot = Number.isFinite(right?.slot) ? right.slot : Number.MAX_SAFE_INTEGER;

    if (leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }
    
    return 0;
  };

  grouped.player.sort(compareCards);
  grouped.banker.sort(compareCards);

  return JSON.stringify(
    {
      player: grouped.player,
      banker: grouped.banker,
    },
    null,
    2,
  );
}

function formatRawModelOutput(runtimeView) {
  if (!runtimeView.rawModelOutput && !(runtimeView.displayedDetections || []).length) {
    return "";
  }

  const hasStructuredPayload =
    runtimeView.rawModelOutput?.player &&
    runtimeView.rawModelOutput?.banker;
  const payload = hasStructuredPayload
    ? normalizeCardPayload(runtimeView.rawModelOutput)
    : payloadFromDisplayedDetections(runtimeView.displayedDetections);

  return JSON.stringify(payload, null, 2);
}

function rawOutputDisplayKey(displayedDetections) {
  const grouped = groupDetectionsBySide(displayedDetections || []);
  return cardsOverlayKey(grouped);
}

function drawRawDetectionBoxes(frameRect) {
  for (const detection of runtimeView.displayedDetections) {
    const rectX = frameRect.x + detection.x * frameRect.scale;
    const rectY = frameRect.y + detection.y * frameRect.scale;
    const rectWidth = detection.width * frameRect.scale;
    const rectHeight = detection.height * frameRect.scale;

    overlayCtx.save();
    overlayCtx.fillStyle = RAW_BOX_STYLE.fill;
    overlayCtx.strokeStyle = RAW_BOX_STYLE.stroke;
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([]);
    overlayCtx.fillRect(rectX, rectY, rectWidth, rectHeight);
    overlayCtx.strokeRect(rectX, rectY, rectWidth, rectHeight);
    overlayCtx.font = "12px sans-serif";
    overlayCtx.fillStyle = RAW_BOX_STYLE.text;
    overlayCtx.fillText(
      `${detection.label} ${(detection.score || 0).toFixed(2)}`,
      rectX + 4,
      Math.max(14, rectY - 6),
    );
    overlayCtx.restore();
  }
}

function currentFrameSourceSize() {
  if (appState.streamMode === "iframe") {
    const detectedWidth = Math.round(runtimeView.rawModelOutput?.frame?.width || 0);
    const detectedHeight = Math.round(runtimeView.rawModelOutput?.frame?.height || 0);

    if (detectedWidth && detectedHeight) {
      return {
        width: detectedWidth,
        height: detectedHeight,
      };
    }

    const iframeRect = els.remoteFrame?.getBoundingClientRect();

    if (iframeRect?.width && iframeRect?.height) {
      return {
        width: Math.round(iframeRect.width),
        height: Math.round(iframeRect.height),
      };
    }

    return {
      width: ROI_REFERENCE_FRAME.width,
      height: ROI_REFERENCE_FRAME.height,
    };
  }

  const width = els.video?.videoWidth || 0;
  const height = els.video?.videoHeight || 0;

  if (!width || !height) {
    return null;
  }

  return { width, height };
}

export function currentVisibleFrameRect() {
  const frameSourceSize = currentFrameSourceSize();
  const rect =
    els.overlay?.getBoundingClientRect() ||
    (appState.streamMode !== "video"
      ? els.remoteFrame?.getBoundingClientRect()
      : null) ||
    els.viewerStage?.getBoundingClientRect() ||
    els.video?.getBoundingClientRect();

  if (!frameSourceSize || !rect?.width || !rect?.height) {
    return null;
  }

  const scale = Math.max(
    rect.width / frameSourceSize.width,
    rect.height / frameSourceSize.height,
  );
  const width = frameSourceSize.width * scale;
  const height = frameSourceSize.height * scale;

  return {
    scale,
    x: (rect.width - width) / 2,
    y: (rect.height - height) / 2,
    width,
    height,
  };
}

export function syncViewerStageAspectRatio() {
  if (!els.viewerStage) {
    return;
  }

  if (appState.streamMode !== "video") {
    els.viewerStage.style.aspectRatio = DEFAULT_VIEWER_ASPECT_RATIO;
    return;
  }

  const videoWidth = els.video?.videoWidth || 0;
  const videoHeight = els.video?.videoHeight || 0;

  els.viewerStage.style.aspectRatio =
    videoWidth && videoHeight
      ? `${videoWidth} / ${videoHeight}`
      : DEFAULT_VIEWER_ASPECT_RATIO;
}

export function resizeOverlay() {
  if (!overlayCtx || !els.overlay) {
    return;
  }

  const rect =
    (appState.streamMode !== "video"
      ? els.remoteFrame?.getBoundingClientRect()
      : null) ||
    els.viewerStage?.getBoundingClientRect() ||
    els.video?.getBoundingClientRect();

  if (!rect.width || !rect.height) {
    return;
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);

  els.overlay.width = Math.round(width * pixelRatio);
  els.overlay.height = Math.round(height * pixelRatio);
  els.overlay.style.width = `${width}px`;
  els.overlay.style.height = `${height}px`;

  overlayCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

export function drawOverlay() {
  if (!overlayCtx || !els.overlay) {
    return;
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const cssWidth = els.overlay.width / pixelRatio;
  const cssHeight = els.overlay.height / pixelRatio;

  overlayCtx.clearRect(0, 0, cssWidth, cssHeight);

  const frameRect = currentVisibleFrameRect();

  if (!frameRect) {
    return;
  }

  const frameSourceSize = currentFrameSourceSize();

  if (!frameSourceSize) {
    return;
  }

  const roiBounds = fullFrameRoiBounds(
    frameSourceSize.width,
    frameSourceSize.height,
  );

  for (const roi of ROI_ORDER) {
    const bounds = roiBounds[roi];
    const style = ROI_STYLES[ROI_SIDE[roi]];

    if (!bounds || !style) {
      continue;
    }

    const rectX = frameRect.x + bounds.x * frameRect.scale;
    const rectY = frameRect.y + bounds.y * frameRect.scale;
    const rectWidth = bounds.width * frameRect.scale;
    const rectHeight = bounds.height * frameRect.scale;

    overlayCtx.save();
    overlayCtx.fillStyle = style.fill;
    overlayCtx.strokeStyle = style.stroke;
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([10, 8]);
    overlayCtx.fillRect(rectX, rectY, rectWidth, rectHeight);
    overlayCtx.strokeRect(rectX, rectY, rectWidth, rectHeight);
    overlayCtx.restore();
  }

  drawRawDetectionBoxes(frameRect);
}

export function renderRuntimeSummary(runtimeView) {
  void runtimeView;
}

export function renderRawModelOutput(runtimeView) {
  if (!els.rawModelOutput) {
    return;
  }

  const hasRawOutput = Boolean(runtimeView.rawModelOutput);

  if (!hasRawOutput) {
    if (rawOutputKey) {
      els.rawModelOutput.textContent = "";
      rawOutputKey = "";
    }

    return;
  }

  const nextKey = rawOutputDisplayKey(runtimeView.displayedDetections);

  if (rawOutputKey !== nextKey || !els.rawModelOutput.textContent.trim()) {
    els.rawModelOutput.textContent = formatRawModelOutput(runtimeView);
    rawOutputKey = nextKey;
  }
}

function renderCardsMarkup(detections) {
  return detections
    .map((detection) => {
      const rawLabel = normalizedCardLabel(detection.label);

      if (!rawLabel) {
        return "";
      }

      const label = escapeHtml(rawLabel);
      return `<img class="cards-hand-image" src="${escapeHtml(cardAssetUrl(rawLabel))}" alt="${label}" width="52" height="73" decoding="async" />`;
    })
    .join("");
}

export function renderCardsOverlay(displayedDetections) {
  if (!els.cardsOverlay) {
    return;
  }

  const validDetections = displayedDetections.filter(
    (detection) => normalizedCardLabel(detection.label),
  );

  if (!validDetections.length) {
    if (cardsMarkupKey) {
      els.cardsOverlay.innerHTML = "";
      cardsMarkupKey = "";
    }

    return;
  }

  const grouped = groupDetectionsBySide(validDetections);
  const nextKey = cardsOverlayKey(grouped);

  if (cardsMarkupKey !== nextKey || !els.cardsOverlay.innerHTML.trim()) {
    els.cardsOverlay.innerHTML = SIDE_ORDER.map((side) => `
      <section class="cards-side cards-side-${side.toLowerCase()}">
        <div class="cards-hand cards-hand-${side.toLowerCase()}" data-roi="${side}">
          ${renderCardsMarkup(grouped[side] || [])}
        </div>
      </section>
    `).join("");

    cardsMarkupKey = nextKey;
  }
}
