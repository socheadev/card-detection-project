import {
  appState,
  applyRuntimeView,
  buildRuntimeView,
  currentThresholds,
  els,
  emitRuntimeViewChanged,
  emitStatusChanged,
  ROI_ORDER,
  ROI_SIDE,
  roiPixelBounds,
  roiSlotValue,
  resetRuntimeView,
} from "./shared.js";
import { queueBroadcastPayload } from "./broadcast.js";
import { loadModel, runModelInference } from "./model.js";

const DISPLAY_CONFIRM_FRAMES = 1;
const DISPLAY_MISS_TOLERANCE = 1;
const FAST_REPLACE_SCORE = 0.9;
const FAST_REPLACE_DELTA = 0.12;
const DEBUG_PREVIEW_LIMIT = 6;
const ROI_CROP_PADDING = 24;

let displayedByRoi = new Map();
let cachedRoiBounds = null;
let lastObservedVideoTime = -1;
let observedVideoFrameCount = 0;

function getRoiBounds(sourceWidth, sourceHeight) {
  if (
    cachedRoiBounds &&
    cachedRoiBounds.width === sourceWidth &&
    cachedRoiBounds.height === sourceHeight
  ) {
    return cachedRoiBounds.bounds;
  }

  const bounds = Object.fromEntries(
    ROI_ORDER.map((roi) => [roi, roiPixelBounds(roi, sourceWidth, sourceHeight)]),
  );

  cachedRoiBounds = {
    width: sourceWidth,
    height: sourceHeight,
    bounds,
  };

  return bounds;
}

function getDetectionCropBounds(roiBounds, sourceWidth, sourceHeight) {
  let minX = sourceWidth;
  let minY = sourceHeight;
  let maxX = 0;
  let maxY = 0;

  for (const roi of ROI_ORDER) {
    const bounds = roiBounds[roi];

    if (!bounds) {
      continue;
    }

    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  const paddedX = Math.max(0, Math.floor(minX - ROI_CROP_PADDING));
  const paddedY = Math.max(0, Math.floor(minY - ROI_CROP_PADDING));
  const paddedRight = Math.min(sourceWidth, Math.ceil(maxX + ROI_CROP_PADDING));
  const paddedBottom = Math.min(sourceHeight, Math.ceil(maxY + ROI_CROP_PADDING));

  return {
    x: paddedX,
    y: paddedY,
    width: Math.max(1, paddedRight - paddedX),
    height: Math.max(1, paddedBottom - paddedY),
  };
}

function offsetDetections(detections, cropBounds) {
  return detections.map((detection) => ({
    ...detection,
    x: detection.x + cropBounds.x,
    y: detection.y + cropBounds.y,
  }));
}

function detectionOverlap(detection, bounds) {
  const x1 = Math.max(detection.x, bounds.x);
  const y1 = Math.max(detection.y, bounds.y);
  const x2 = Math.min(detection.x + detection.width, bounds.x + bounds.width);
  const y2 = Math.min(detection.y + detection.height, bounds.y + bounds.height);

  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function detectionCenterInside(detection, bounds) {
  const centerX = detection.x + (detection.width / 2);
  const centerY = detection.y + (detection.height / 2);

  return (
    centerX >= bounds.x &&
    centerX <= bounds.x + bounds.width &&
    centerY >= bounds.y &&
    centerY <= bounds.y + bounds.height
  );
}

function matchDetectionsToRois(detections, roiBounds) {
  const candidates = [];

  detections.forEach((detection, detectionIndex) => {
    for (const roi of ROI_ORDER) {
      const bounds = roiBounds[roi];

      if (!bounds) {
        continue;
      }

      const centerInside = detectionCenterInside(detection, bounds);
      const overlapArea = detectionOverlap(detection, bounds);

      if (!centerInside && !overlapArea) {
        continue;
      }

      candidates.push({
        ...detection,
        roi,
        side: ROI_SIDE[roi],
        centerInside,
        overlapArea,
        detectionIndex,
      });
    }
  });

  candidates.sort((left, right) => {
    if (left.centerInside !== right.centerInside) {
      return left.centerInside ? -1 : 1;
    }

    if (left.overlapArea !== right.overlapArea) {
      return right.overlapArea - left.overlapArea;
    }

    return (right.score || 0) - (left.score || 0);
  });

  const matched = [];
  const usedDetections = new Set();
  const usedRois = new Set();

  for (const candidate of candidates) {
    if (
      usedDetections.has(candidate.detectionIndex) ||
      usedRois.has(candidate.roi)
    ) {
      continue;
    }

    usedDetections.add(candidate.detectionIndex);
    usedRois.add(candidate.roi);
    matched.push(candidate);
  }

  return {
    matchedDetections: matched,
    unmatchedDetections: detections.filter(
      (_, detectionIndex) => !usedDetections.has(detectionIndex),
    ),
  };
}

function sameCard(left, right) {
  return Boolean(
    left &&
      right &&
      left.roi === right.roi &&
      left.label === right.label &&
      left.classId === right.classId,
  );
}

function clearDisplayedState() {
  displayedByRoi = new Map();
}

function nextDisplayedDetections(frameDetections) {
  const incomingByRoi = new Map(
    frameDetections
      .filter((detection) => detection?.roi)
      .map((detection) => [detection.roi, detection]),
  );

  const nextState = new Map();
  const displayed = [];
  let resetTriggered = false;

  for (const roi of ROI_ORDER) {
    const previous = displayedByRoi.get(roi) || {
      displayed: null,
      candidate: null,
      candidateHits: 0,
      missCount: 0,
    };
    const incoming = incomingByRoi.get(roi) || null;
    const state = { ...previous };

    if (!incoming) {
      state.candidate = null;
      state.candidateHits = 0;

      if (state.displayed) {
        state.missCount += 1;

        if (state.missCount <= DISPLAY_MISS_TOLERANCE) {
          displayed.push(state.displayed);
        } else {
          state.displayed = null;
          state.missCount = 0;
          resetTriggered = true;
        }
      }

      nextState.set(roi, state);
      continue;
    }

    state.missCount = 0;

    if (!state.displayed || sameCard(state.displayed, incoming)) {
      state.displayed = incoming;
      state.candidate = null;
      state.candidateHits = 0;
      displayed.push(state.displayed);
      nextState.set(roi, state);
      continue;
    }

    const wasSameCandidate = sameCard(state.candidate, incoming);
    const scoreDelta = (incoming.score || 0) - (state.displayed.score || 0);

    state.candidate = incoming;
    state.candidateHits = wasSameCandidate ? state.candidateHits + 1 : 1;

    if (
      state.candidateHits >= DISPLAY_CONFIRM_FRAMES ||
      (
        (incoming.score || 0) >= FAST_REPLACE_SCORE &&
        scoreDelta >= FAST_REPLACE_DELTA
      )
    ) {
      state.displayed = incoming;
      state.candidate = null;
      state.candidateHits = 0;
    }

    if (state.displayed) {
      displayed.push(state.displayed);
    }

    nextState.set(roi, state);
  }

  displayedByRoi = nextState;

  return {
    displayedDetections: displayed,
    resetTriggered,
  };
}

function detectionPreview(detections) {
  return detections.slice(0, DEBUG_PREVIEW_LIMIT).map((detection) => ({
    label: detection.label,
    score: detection.score,
    roi: detection.roi || null,
    side: detection.side || null,
    box: {
      x1: detection.x,
      y1: detection.y,
      x2: detection.x + detection.width,
      y2: detection.y + detection.height,
    },
  }));
}

function buildBroadcastPayload(detections) {
  const payload = [];

  const SUIT_NAMES = {
    C: "clubs",
    D: "diamonds",
    H: "hearts",
    S: "spades",
  };

  const payloadValue = (rank) => {
    const normalized = String(rank || "").trim().toUpperCase();

    if (normalized === "A") {
      return 1;
    }

    if (normalized === "J") {
      return 11;
    }

    if (normalized === "Q") {
      return 12;
    }

    if (normalized === "K") {
      return 13;
    }

    const numeric = Number.parseInt(normalized, 10);
    return Number.isFinite(numeric) && numeric >= 2 && numeric <= 10 ? numeric : null;
  };

  const broadcastCardFromLabel = (label) => {
    const text = String(label || "").trim().toUpperCase();
    const match = text.match(/^(10|[2-9AJQK])([CDHS])$/);

    if (!match) {
      return null;
    }

    const [, rank, suitCode] = match;
    const suit = SUIT_NAMES[suitCode] || null;
    const value = payloadValue(rank);

    if (!suit || value === null) {
      return null;
    }

    return { suit, value };
  };

  for (const detection of detections) {
    const number = detection.roi ? roiSlotValue(detection.roi) : null;
    const card = broadcastCardFromLabel(detection.label);
    const side = String(detection.side || "").toLowerCase();

    if (!Number.isFinite(number) || !card || (side !== "player" && side !== "banker")) {
      continue;
    }

    payload.push({
      ...card,
      number,
      side,
    });
  }

  return payload.sort((left, right) => {
    if (left.side !== right.side) {
      return left.side === "player" ? -1 : 1;
    }

    return left.number - right.number;
  });
}

function buildBroadcastResults(detections) {
  return detections.map((detection) => ({
    name: detection.label,
    class: detection.classId,
    confidence: detection.score,
    side: detection.side || null,
    slot: detection.roi ? roiSlotValue(detection.roi) : null,
    roi: detection.roi || null,
  }));
}

function hasPayloadCards(payload) {
  return Array.isArray(payload) && payload.length > 0;
}

function buildBroadcastMessage({
  displayedDetections,
  rawModelOutput,
  lastInferenceMs = 0,
  lastPostprocessMs = 0,
  lastTotalMs = 0,
  debugText = "",
}) {
  const payload = buildBroadcastPayload(displayedDetections);

  return {
    payload,
    rawModelOutput: {
      ...(rawModelOutput || {}),
      results: buildBroadcastResults(displayedDetections),
      cards: payload,
      lastInferenceMs,
      lastPostprocessMs,
      lastTotalMs,
      debugText,
    },
  };
}

async function captureFrameBitmap(cropBounds = null) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is not available in this browser");
  }

  try {
    if (cropBounds) {
      return await createImageBitmap(
        els.video,
        cropBounds.x,
        cropBounds.y,
        cropBounds.width,
        cropBounds.height,
      );
    }

    return await createImageBitmap(els.video);
  } catch (error) {
    if (error?.name === "SecurityError") {
      throw new Error(
        "The stream is tainting the canvas. Use the local proxy or enable CORS on the video host for browser inference.",
      );
    }

    throw error;
  }
}

function isRecoverableFrameError(error) {
  const message = String(error?.message || error || "");

  return (
    message.includes("Video frame is not ready yet") ||
    message.includes("The object is in an invalid state") ||
    message.includes("createImageBitmap") ||
    message.includes("Load a stream before starting detection")
  );
}

function normalizeExternalDetection(detection) {
  return {
    id: detection?.id || "",
    label: detection?.label || "",
    classId: Number.isFinite(detection?.classId) ? detection.classId : -1,
    score: Number.isFinite(detection?.score) ? detection.score : 0,
    objectness: Number.isFinite(detection?.objectness) ? detection.objectness : 0,
    classScore: Number.isFinite(detection?.classScore) ? detection.classScore : 0,
    x: Number.isFinite(detection?.x) ? detection.x : 0,
    y: Number.isFinite(detection?.y) ? detection.y : 0,
    width: Number.isFinite(detection?.width) ? detection.width : 0,
    height: Number.isFinite(detection?.height) ? detection.height : 0,
  };
}

export function applyExternalDetections(payload = {}) {
  const sourceWidth = Math.round(payload?.frame?.width || 0);
  const sourceHeight = Math.round(payload?.frame?.height || 0);

  if (!sourceWidth || !sourceHeight) {
    return false;
  }

  const rawDetections = Array.isArray(payload?.detections)
    ? payload.detections.map(normalizeExternalDetection)
    : [];
  const roiBounds = getRoiBounds(sourceWidth, sourceHeight);
  const { matchedDetections, unmatchedDetections } = matchDetectionsToRois(
    rawDetections,
    roiBounds,
  );
  const { displayedDetections, resetTriggered } =
    nextDisplayedDetections(matchedDetections);
  const nextRawModelOutput = {
    ...(payload.rawModelOutput || {}),
    inferenceMode: "puppeteer-screenshot",
    frame: {
      width: sourceWidth,
      height: sourceHeight,
    },
    capturedAt: payload.capturedAt || null,
    roiBounds,
    rawDetectionCount: rawDetections.length,
    matchedDetectionCount: matchedDetections.length,
    unmatchedDetectionCount: unmatchedDetections.length,
    displayedDetectionCount: displayedDetections.length,
    rawDetectionsPreview: detectionPreview(rawDetections),
    displayedDetectionsPreview: detectionPreview(displayedDetections),
  };
  const broadcastMessage = buildBroadcastMessage({
    displayedDetections,
    rawModelOutput: nextRawModelOutput,
    lastInferenceMs: Number.isFinite(payload.inferenceMs) ? payload.inferenceMs : 0,
    lastPostprocessMs: Number.isFinite(payload.postprocessMs) ? payload.postprocessMs : 0,
    lastTotalMs: Number.isFinite(payload.totalMs) ? payload.totalMs : 0,
    debugText:
      `screenshot ${sourceWidth}x${sourceHeight}` +
      ` raw ${rawDetections.length}` +
      ` matched ${matchedDetections.length}` +
      ` displayed ${displayedDetections.length}`,
  });

  if (hasPayloadCards(broadcastMessage.payload)) {
    queueBroadcastPayload(broadcastMessage);
  }

  appState.lastRunAt = performance.now();

  applyRuntimeView(
    buildRuntimeView({
      rawDetections,
      matchedDetections,
      displayedDetections,
      rawModelOutput: nextRawModelOutput,
      lastInferenceMs: Number.isFinite(payload.inferenceMs) ? payload.inferenceMs : 0,
      lastPostprocessMs: Number.isFinite(payload.postprocessMs) ? payload.postprocessMs : 0,
      lastTotalMs: Number.isFinite(payload.totalMs) ? payload.totalMs : 0,
      debugText: broadcastMessage.rawModelOutput.debugText,
    }),
  );

  if (resetTriggered) {
    emitStatusChanged("Display reset. Detection still running");
  }

  emitRuntimeViewChanged();
  return true;
}

async function runInferenceFrame(sessionId) {
  if (!appState.streamReady || appState.detectionSessionId !== sessionId) {
    return false;
  }

  const sourceWidth = els.video.videoWidth || 0;
  const sourceHeight = els.video.videoHeight || 0;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Video frame is not ready yet");
  }

  const thresholds = currentThresholds();
  const startedAt = performance.now();
  const roiBounds = getRoiBounds(sourceWidth, sourceHeight);
  const detectionCropBounds = getDetectionCropBounds(
    roiBounds,
    sourceWidth,
    sourceHeight,
  );
  const frameBitmap = await captureFrameBitmap(detectionCropBounds);
  const frameResult = await runModelInference(frameBitmap, thresholds);
  const frameDetections = offsetDetections(
    frameResult.detections,
    detectionCropBounds,
  );

  if (appState.detectionSessionId !== sessionId) {
    return false;
  }

  const { matchedDetections, unmatchedDetections } = matchDetectionsToRois(
    frameDetections,
    roiBounds,
  );
  const { displayedDetections, resetTriggered } =
    nextDisplayedDetections(matchedDetections);
  const nextLastRunAt = performance.now();
  const nextRawModelOutput = {
    ...frameResult.rawModelOutput,
    inferenceMode: "roi-union-crop",
    roiBounds,
    detectionCropBounds,
    rawDetectionCount: frameDetections.length,
    matchedDetectionCount: matchedDetections.length,
    unmatchedDetectionCount: unmatchedDetections.length,
    displayedDetectionCount: displayedDetections.length,
    rawDetectionsPreview: detectionPreview(frameDetections),
    displayedDetectionsPreview: detectionPreview(displayedDetections),
  };
  const broadcastMessage = buildBroadcastMessage({
    displayedDetections,
    rawModelOutput: nextRawModelOutput,
    lastInferenceMs: frameResult.inferenceMs,
    lastPostprocessMs: frameResult.workerPostprocessMs,
    lastTotalMs: nextLastRunAt - startedAt,
    debugText:
      `roi-crop ${detectionCropBounds.width}x${detectionCropBounds.height}` +
      ` raw ${frameDetections.length}` +
      ` matched ${matchedDetections.length}` +
      ` displayed ${displayedDetections.length}`,
  });

  if (hasPayloadCards(broadcastMessage.payload)) {
    queueBroadcastPayload(broadcastMessage);
  }

  appState.lastRunAt = nextLastRunAt;

  applyRuntimeView(
    buildRuntimeView({
      rawDetections: frameDetections,
      matchedDetections,
      displayedDetections,
      rawModelOutput: nextRawModelOutput,
      lastInferenceMs: frameResult.inferenceMs,
      lastPostprocessMs: frameResult.workerPostprocessMs,
      lastTotalMs: nextLastRunAt - startedAt,
      debugText: broadcastMessage.rawModelOutput.debugText,
    }),
  );

  if (resetTriggered) {
    emitStatusChanged("Display reset. Detection still running");
  }

  emitRuntimeViewChanged();
  return true;
}

export function stopDetection() {
  appState.detectionSessionId += 1;
  appState.detecting = false;
  appState.startingDetection = false;
  appState.inferenceBusy = false;
  appState.lastRunAt = 0;
  appState.hideCardsUntilClear = false;
  cachedRoiBounds = null;
  lastObservedVideoTime = -1;
  observedVideoFrameCount = 0;
  clearDisplayedState();

  if (appState.animationFrameId) {
    cancelAnimationFrame(appState.animationFrameId);
    appState.animationFrameId = 0;
  }

  resetRuntimeView();
  emitRuntimeViewChanged();
}

async function detectionLoop(sessionId) {
  if (!appState.detecting || appState.detectionSessionId !== sessionId) {
    return;
  }

  const { intervalMs, detectEveryNthFrame } = currentThresholds();

  if (
    appState.inferenceBusy ||
    els.video.paused ||
    els.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
    return;
  }

  if (performance.now() - appState.lastRunAt < intervalMs) {
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
    return;
  }

  const currentVideoTime = els.video.currentTime;

  if (!Number.isFinite(currentVideoTime) || currentVideoTime === lastObservedVideoTime) {
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
    return;
  }

  lastObservedVideoTime = currentVideoTime;
  observedVideoFrameCount += 1;

  if (((observedVideoFrameCount - 1) % detectEveryNthFrame) !== 0) {
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
    return;
  }

  appState.inferenceBusy = true;

  try {
    await runInferenceFrame(sessionId);
  } catch (error) {
    if (appState.detectionSessionId === sessionId && !isRecoverableFrameError(error)) {
      stopDetection();
      emitStatusChanged(`Detection stopped: ${error.message}`);
      return;
    }
  } finally {
    if (appState.detectionSessionId === sessionId) {
      appState.inferenceBusy = false;
    }
  }

  if (appState.detecting && appState.detectionSessionId === sessionId) {
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
  }
}

export async function startDetection() {
  if (appState.detecting || appState.startingDetection) {
    if (!appState.animationFrameId) {
      const sessionId = appState.detectionSessionId;
      appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
    }

    return;
  }

  if (appState.streamMode === "iframe") {
    emitStatusChanged(
      "Detection is unavailable for play.html sources because they load in a remote iframe.",
    );
    return;
  }

  if (!appState.streamReady) {
    emitStatusChanged("Load a stream before starting detection");
    return;
  }

  try {
    const sessionId = appState.detectionSessionId + 1;

    appState.detectionSessionId = sessionId;
    appState.startingDetection = true;
    lastObservedVideoTime = -1;
    observedVideoFrameCount = 0;
    emitStatusChanged("Starting detection...");

    if (els.video.paused) {
      await els.video.play();
    }

    await loadModel();

    if (appState.detectionSessionId !== sessionId) {
      return;
    }

    appState.startingDetection = false;
    appState.detecting = true;
    appState.inferenceBusy = false;
    emitStatusChanged("Starting detection loop");
    appState.animationFrameId = requestAnimationFrame(() => detectionLoop(sessionId));
  } catch (error) {
    if (appState.startingDetection) {
      stopDetection();
      emitStatusChanged(`Could not start detection: ${error.message}`);
    }
  }
}
