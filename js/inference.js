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
  resetRuntimeView,
} from "./shared.js";
import { loadModel, runModelInference } from "./model.js";

let displayedCardsState = [];

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

function roiBoundsByName(sourceWidth, sourceHeight) {
  return Object.fromEntries(
    ROI_ORDER.map((roi) => [roi, roiPixelBounds(roi, sourceWidth, sourceHeight)]),
  );
}

function clearDisplayedCardsState() {
  displayedCardsState = [];
}

function nextDisplayedCards(frameDetections) {
  if (!frameDetections.length) {
    clearDisplayedCardsState();
    appState.hideCardsUntilClear = false;
    return {
      displayedDetections: [],
      resetTriggered: true,
    };
  }

  if (appState.hideCardsUntilClear) {
    return {
      displayedDetections: [],
      resetTriggered: false,
    };
  }

  if (!displayedCardsState.length) {
    displayedCardsState = frameDetections;
    return {
      displayedDetections: displayedCardsState,
      resetTriggered: false,
    };
  }

  if (frameDetections.length < displayedCardsState.length) {
    clearDisplayedCardsState();
    appState.hideCardsUntilClear = true;
    return {
      displayedDetections: [],
      resetTriggered: true,
    };
  }

  displayedCardsState = frameDetections;
  return {
    displayedDetections: displayedCardsState,
    resetTriggered: false,
  };
}

async function captureFrameBitmap() {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is not available in this browser");
  }

  try {
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

async function runInferenceFrame() {
  if (!appState.streamReady) {
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

  const { matchedDetections, unmatchedDetections } = assignDetectionsToRois(
    frameResult.detections,
    roiBounds,
  );

  const displayedDetections = matchedDetections;
  const { displayedDetections: stableDisplayedDetections, resetTriggered } =
    nextDisplayedCards(displayedDetections);

  const rawModelOutput = {
    ...frameResult.rawModelOutput,
    workerPreprocessMs: frameResult.preprocessMs,
    workerPostprocessMs: frameResult.workerPostprocessMs,
    workerTotalMs: frameResult.totalWorkerMs,
    roiBounds,
    rawDetectionCount: frameResult.detections.length,
    matchedDetectionCount: matchedDetections.length,
    unmatchedDetectionCount: unmatchedDetections.length,
    displayedDetectionCount: stableDisplayedDetections.length,
    rawDetections: frameResult.detections.map(formatDetectionForDebug),
    matchedDetections: matchedDetections.map(formatDetectionForDebug),
    unmatchedDetections: unmatchedDetections.map(formatDetectionForDebug),
    displayedDetections: stableDisplayedDetections.map(formatDetectionForDebug),
  };

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
        `raw ${frameResult.detections.length}` +
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
  appState.detecting = false;
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

async function detectionLoop() {
  if (!appState.detecting) {
    return;
  }

  const { intervalMs } = currentThresholds();

  if (
    appState.inferenceBusy ||
    els.video.paused ||
    els.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    appState.animationFrameId = requestAnimationFrame(detectionLoop);
    return;
  }

  if (performance.now() - appState.lastRunAt < intervalMs) {
    appState.animationFrameId = requestAnimationFrame(detectionLoop);
    return;
  }

  appState.inferenceBusy = true;

  try {
    const updated = await runInferenceFrame();

    if (updated !== false && appState.detecting) {
      emitStatusChanged("Detection loop running");
    }
  } catch (error) {
    stopDetection();
    emitStatusChanged(`Detection stopped: ${error.message}`);
  } finally {
    appState.inferenceBusy = false;
  }

  if (appState.detecting) {
    appState.animationFrameId = requestAnimationFrame(detectionLoop);
  }
}

export async function startDetection() {
  if (appState.detecting) {
    if (!appState.animationFrameId) {
      appState.animationFrameId = requestAnimationFrame(detectionLoop);
    }

    return;
  }

  if (!appState.streamReady) {
    emitStatusChanged("Load a stream before starting detection");
    return;
  }

  try {
    if (els.video.paused) {
      await els.video.play();
    }

    await loadModel();

    appState.detecting = true;
    emitStatusChanged("Starting detection loop");
    appState.animationFrameId = requestAnimationFrame(detectionLoop);
  } catch (error) {
    stopDetection();
    emitStatusChanged(`Could not start detection: ${error.message}`);
  }
}
