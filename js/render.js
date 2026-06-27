import {
  cardAssetUrl,
  cardsOverlayKey,
  els,
  fullFrameRoiBounds,
  groupDetectionsBySide,
  overlayCtx,
  ROI_ORDER,
  ROI_SIDE,
  runtimeView,
  SIDE_ORDER,
  TIMING_IDLE_TEXT,
} from "./shared.js";

let cardsMarkupKey = "";

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

function formatRawModelOutput(runtimeView) {
  if (!runtimeView.displayedDetections.length) {
    return "";
  }

  const grouped = groupDetectionsBySide(
    runtimeView.displayedDetections.filter(
      (detection) => normalizedCardLabel(detection.label),
    ),
  );

  return JSON.stringify(
    {
      PLAYER: (grouped.PLAYER || []).map((detection) => ({
        label: normalizedCardLabel(detection.label),
        classId: detection.classId,
        score: roundNumber(detection.score, 5),
      })),
      BANKER: (grouped.BANKER || []).map((detection) => ({
        label: normalizedCardLabel(detection.label),
        classId: detection.classId,
        score: roundNumber(detection.score, 5),
      })),
    },
    null,
    2,
  );
}

function drawRawDetectionBoxes(frameRect) {
  for (const detection of runtimeView.rawDetections) {
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

export function currentVisibleFrameRect() {
  const videoWidth = els.video?.videoWidth || 0;
  const videoHeight = els.video?.videoHeight || 0;
  const rect = els.video?.getBoundingClientRect();

  if (!videoWidth || !videoHeight || !rect?.width || !rect?.height) {
    return null;
  }

  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;

  return {
    scale,
    x: (rect.width - width) / 2,
    y: (rect.height - height) / 2,
    width,
    height,
  };
}

export function resizeOverlay() {
  if (!overlayCtx || !els.overlay || !els.video) {
    return;
  }

  const rect = els.video.getBoundingClientRect();

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
  if (!overlayCtx || !els.overlay || !els.video) {
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

  const roiBounds = fullFrameRoiBounds(
    els.video.videoWidth,
    els.video.videoHeight,
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
  const bestScore = runtimeView.displayedDetections.reduce(
    (highestScore, detection) => Math.max(highestScore, detection.score || 0),
    0,
  );

  if (els.countValue) {
    els.countValue.textContent = String(runtimeView.displayedDetections.length);
  }

  if (els.bestScoreValue) {
    els.bestScoreValue.textContent = bestScore.toFixed(2);
  }

  if (els.timingText) {
    els.timingText.textContent =
      runtimeView.lastTotalMs > 0
        ? `Total ${runtimeView.lastTotalMs.toFixed(1)} ms | Model ${runtimeView.lastInferenceMs.toFixed(1)} ms | Post ${runtimeView.lastPostprocessMs.toFixed(1)} ms | UI ${runtimeView.lastUiRenderMs.toFixed(1)} ms`
        : TIMING_IDLE_TEXT;
  }
}

export function renderRawModelOutput(runtimeView) {
  if (els.rawModelOutput) {
    els.rawModelOutput.textContent = formatRawModelOutput(runtimeView);
  }
}

function renderCardsMarkup(detections) {
  return detections
    .map((detection, index) => {
      const rawLabel = normalizedCardLabel(detection.label);

      if (!rawLabel) {
        return "";
      }

      const label = escapeHtml(rawLabel);
      const scorePercent = Math.round((detection.score || 0) * 100);
      const title = `${label} (${scorePercent}%)`;
      const imageMarkup = `<img class="cards-hand-image" src="${escapeHtml(cardAssetUrl(rawLabel))}" alt="${label}" />`;

      return `
        <figure class="cards-hand-card" data-card-index="${index}" data-state="stable" title="${escapeHtml(title)}">
          ${imageMarkup}
          <figcaption class="cards-hand-score">
            ${label}
          </figcaption>
        </figure>
      `;
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

  if (cardsMarkupKey !== nextKey) {
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
