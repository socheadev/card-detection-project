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

const DISPLAY_REPLACEMENT_CONFIRM_FRAMES = 2;
const DISPLAY_MISS_TOLERANCE_FRAMES = 3;
const HIGH_CONFIDENCE_REPLACEMENT_SCORE = 0.9;
const HIGH_CONFIDENCE_REPLACEMENT_DELTA = 0.12;
const DEBUG_DETECTION_PREVIEW_LIMIT = 8;

let displayedCardsState = [];
let displayedCardsByRoi = new Map();

function centerInsideBounds(detection, bounds) {
  const centerX = detection.x + (detection.width / 2);
  const centerY = detection.y + (detection.height / 2);

  return (
    centerX >= bounds.x &&
    centerX <= bounds.x + bounds.width &&
    centerY >= bounds.y &&
    centerY <= bounds.y + bounds.height
  );
}

function overlapArea(detection, bounds) {
  const x1 = Math.max(detection.x, bounds.x);
  const y1 = Math.max(detection.y, bounds.y);
  const x2 = Math.min(detection.x + detection.width, bounds.x + bounds.width);
  const y2 = Math.min(detection.y + detection.height, bounds.y + bounds.height);

  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function buildRoiCandidate(detection, bounds, roi, detectionIndex) {
  const centerInside = centerInsideBounds(detection, bounds);
  const intersection = overlapArea(detection, bounds);

  if (!centerInside && !intersection) {
    return null;
  }

  return {
    ...detection,
    roi,
    side: ROI_SIDE[roi],
    centerInside,
    overlapArea: intersection,
    detectionIndex,
  };
}

function compareRoiCandidates(left, right) {
  if (left.centerInside !== right.centerInside) {
    return left.centerInside ? -1 : 1;
  }

  if (right.overlapArea !== left.overlapArea) {
    return right.overlapArea - left.overlapArea;
  }

  return (right.score || 0) - (left.score || 0);
}

function assignDetectionsToRois(detections, roiBoundsByName) {
  const candidates = [];

  detections.forEach((detection, detectionIndex) => {
    for (const roi of ROI_ORDER) {
      const bounds = roiBoundsByName[roi];

      if (!bounds) {
        continue;
      }

      const candidate = buildRoiCandidate(
        detection,
        bounds,
        roi,
        detectionIndex,
      );

      if (candidate) {
        candidates.push(candidate);
      }
    }
  });

  candidates.sort(compareRoiCandidates);

  const matchedDetections = [];
  const usedDetectionIndexes = new Set();
  const usedRois = new Set();

  for (const candidate of candidates) {
    if (
      usedDetectionIndexes.has(candidate.detectionIndex) ||
      usedRois.has(candidate.roi)
    ) {
      continue;
    }

    usedDetectionIndexes.add(candidate.detectionIndex);
    usedRois.add(candidate.roi);
    matchedDetections.push(candidate);
  }

  const unmatchedDetections = detections.filter(
    (_, detectionIndex) => !usedDetectionIndexes.has(detectionIndex),
  );

  return {
    matchedDetections,
    unmatchedDetections,
  };
}

function formatDetectionForDebug(detection) {
  return {
    label: detection.label,
    classId: detection.classId,
    score: detection.score,
    roi: detection.roi || null,
    side: detection.side || null,
    centerInside: Boolean(detection.centerInside),
    overlapArea: detection.overlapArea || 0,
    box: {
      x1: detection.x,
      y1: detection.y,
      x2: detection.x + detection.width,
      y2: detection.y + detection.height,
    },
  };
}

function detectionPreview(detections, limit = DEBUG_DETECTION_PREVIEW_LIMIT) {
  return detections
    .slice(0, limit)
    .map(formatDetectionForDebug);
}

function formatBroadcastResult(detection) {
  return {
    name: detection.label,
    confidence: detection.score,
    slot: detection.roi ? roiSlotValue(detection.roi) : null,
  };
}

function compareBroadcastResults(left, right) {
  const leftSlot = Number.isFinite(left?.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
  const rightSlot = Number.isFinite(right?.slot) ? right.slot : Number.MAX_SAFE_INTEGER;

  if (leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }

  return (right?.confidence || 0) - (left?.confidence || 0);
}

function groupedBroadcastResults(detections) {
  const grouped = {
    player: [],
    banker: [],
  };

  for (const detection of detections) {
    const result = formatBroadcastResult(detection);

    if (detection.side === "PLAYER") {
      grouped.player.push(result);
      continue;
    }

    if (detection.side === "BANKER") {
      grouped.banker.push(result);
    }
  }

  grouped.player.sort(compareBroadcastResults);
  grouped.banker.sort(compareBroadcastResults);

  return grouped;
}

function buildBroadcastPayload(detections) {
  const grouped = groupedBroadcastResults(detections);

  return {
    player: grouped.player,
    banker: grouped.banker,
  };
}

function hasBroadcastResults(payload) {
  return (
    (Array.isArray(payload?.player) && payload.player.length > 0) ||
    (Array.isArray(payload?.banker) && payload.banker.length > 0)
  );
}

function roiBoundsByName(sourceWidth, sourceHeight) {
  return Object.fromEntries(
    ROI_ORDER.map((roi) => [roi, roiPixelBounds(roi, sourceWidth, sourceHeight)]),
  );
}

function clearDisplayedCardsState() {
  displayedCardsState = [];
  displayedCardsByRoi = new Map();
}

function sameDisplayedCard(left, right) {
  return Boolean(
    left &&
      right &&
      left.roi === right.roi &&
      left.label === right.label &&
      left.classId === right.classId,
  );
}

function buildDisplayState(previousState, detection) {
  return {
    displayed: detection || null,
    candidate: null,
    candidateHits: 0,
    missCount: 0,
  };
}

function nextDisplayedCards(frameDetections) {
  const detectionsByRoi = new Map(
    frameDetections
      .filter((detection) => detection?.roi)
      .map((detection) => [detection.roi, detection]),
  );
  const nextStateByRoi = new Map();
  const nextDisplayed = [];
  let resetTriggered = false;

  for (const roi of ROI_ORDER) {
    const incoming = detectionsByRoi.get(roi) || null;
    const previousState = displayedCardsByRoi.get(roi) || buildDisplayState(null, null);
    const nextState = { ...previousState };

    if (!incoming) {
      nextState.candidate = null;
      nextState.candidateHits = 0;

      if (nextState.displayed) {
        nextState.missCount += 1;

        if (nextState.missCount <= DISPLAY_MISS_TOLERANCE_FRAMES) {
          nextDisplayed.push(nextState.displayed);
          nextStateByRoi.set(roi, nextState);
          continue;
        }

        nextState.displayed = null;
        nextState.missCount = 0;
        resetTriggered = true;
      }

      nextStateByRoi.set(roi, nextState);
      continue;
    }

    nextState.missCount = 0;

    if (!nextState.displayed || sameDisplayedCard(nextState.displayed, incoming)) {
      nextState.displayed = incoming;
      nextState.candidate = null;
      nextState.candidateHits = 0;
      nextDisplayed.push(nextState.displayed);
      nextStateByRoi.set(roi, nextState);
      continue;
    }

    const previousCandidate = nextState.candidate;
    const scoreDelta = (incoming.score || 0) - (nextState.displayed.score || 0);

    nextState.candidate = incoming;
    nextState.candidateHits = sameDisplayedCard(previousCandidate, incoming)
      ? previousState.candidateHits + 1
      : 1;

    if (
      nextState.candidateHits >= DISPLAY_REPLACEMENT_CONFIRM_FRAMES ||
      (
        (incoming.score || 0) >= HIGH_CONFIDENCE_REPLACEMENT_SCORE &&
        scoreDelta >= HIGH_CONFIDENCE_REPLACEMENT_DELTA
      )
    ) {
      nextState.displayed = incoming;
      nextState.candidate = null;
      nextState.candidateHits = 0;
    }

    nextDisplayed.push(nextState.displayed);
    nextStateByRoi.set(roi, nextState);
  }

  displayedCardsByRoi = nextStateByRoi;
  displayedCardsState = nextDisplayed.filter(Boolean);
  return {
    displayedDetections: displayedCardsState,
    resetTriggered,
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

async function runInferenceFrame(sessionId = appState.detectionSessionId) {
  if (!appState.streamReady || appState.detectionSessionId !== sessionId) {
    throw new Error("Load a stream before starting detection");
  }

  await loadModel();

  const thresholds = currentThresholds();
  const startedAt = performance.now();
  const sourceWidth = els.video.videoWidth || 0;
  const sourceHeight = els.video.videoHeight || 0;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Video frame is not ready yet");
  }

  const roiBounds = roiBoundsByName(sourceWidth, sourceHeight);
  const frameBitmap = await captureFrameBitmap();
  const frameResult = await runModelInference(frameBitmap, thresholds);

  if (appState.detectionSessionId !== sessionId) {
    return false;
  }

  const { matchedDetections, unmatchedDetections } = assignDetectionsToRois(
    frameResult.detections,
    roiBounds,
  );

  const displayedDetections = matchedDetections;
  const { displayedDetections: stableDisplayedDetections, resetTriggered } =
    nextDisplayedCards(displayedDetections);
  const broadcastPayload = buildBroadcastPayload(stableDisplayedDetections);

  const rawModelOutput = {
    ...frameResult.rawModelOutput,
    workerPreprocessMs: frameResult.preprocessMs,
    workerPostprocessMs: frameResult.workerPostprocessMs,
    workerTotalMs: frameResult.totalWorkerMs,
    inferenceMode: "full-frame-then-roi",
    roiBounds,
    rawDetectionCount: frameResult.detections.length,
    matchedDetectionCount: matchedDetections.length,
    unmatchedDetectionCount: unmatchedDetections.length,
    displayedDetectionCount: stableDisplayedDetections.length,
    rawDetectionsPreview: detectionPreview(frameResult.detections),
    matchedDetectionsPreview: detectionPreview(matchedDetections),
    unmatchedDetectionsPreview: detectionPreview(unmatchedDetections),
    displayedDetectionsPreview: detectionPreview(stableDisplayedDetections),
  };

  if (hasBroadcastResults(broadcastPayload)) {
    queueBroadcastPayload(broadcastPayload);
  }

  appState.lastRunAt = performance.now();

  applyRuntimeView(
    buildRuntimeView({
      rawDetections: frameResult.detections,
      matchedDetections,
      displayedDetections: stableDisplayedDetections,
      rawModelOutput,
      lastInferenceMs: frameResult.inferenceMs,
      lastPostprocessMs: frameResult.workerPostprocessMs,
      lastTotalMs: appState.lastRunAt - startedAt,
      debugText:
        `full-frame ${sourceWidth}x${sourceHeight}` +
        ` raw ${frameResult.detections.length}` +
        ` matched ${matchedDetections.length}` +
        ` displayed ${stableDisplayedDetections.length}`,
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
  clearDisplayedCardsState();

  if (appState.animationFrameId) {
    cancelAnimationFrame(appState.animationFrameId);
    appState.animationFrameId = 0;
  }

  resetRuntimeView();
  emitRuntimeViewChanged();
}

async function detectionLoop(sessionId = appState.detectionSessionId) {
  if (!appState.detecting || appState.detectionSessionId !== sessionId) {
    return;
  }

  const { intervalMs } = currentThresholds();

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

  appState.inferenceBusy = true;

  try {
    await runInferenceFrame(sessionId);
  } catch (error) {
    if (appState.detectionSessionId === sessionId) {
      stopDetection();
      emitStatusChanged(`Detection stopped: ${error.message}`);
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

  if (!appState.streamReady) {
    emitStatusChanged("Load a stream before starting detection");
    return;
  }

  try {
    const sessionId = appState.detectionSessionId + 1;
    appState.detectionSessionId = sessionId;
    appState.startingDetection = true;
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
