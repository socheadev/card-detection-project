import {
  appState,
  cardAssetUrl,
  emitModelPresentationChanged,
  emitStatusChanged,
  MODEL_BADGE_ERROR_TEXT,
  MODEL_BADGE_LOADED_TEXT,
  MODEL_BADGE_LOADING_TEXT,
  MODEL_MANIFEST_URL,
  MODEL_URL,
} from "./shared.js";

const pendingRequests = new Map();
const preloadedCardLabels = new Set();

let inferenceWorker = null;
let nextRequestId = 0;

function preloadCardAssets(labels) {
  for (const label of labels) {
    if (!label || preloadedCardLabels.has(label)) {
      continue;
    }

    preloadedCardLabels.add(label);

    const image = new Image();
    image.decoding = "async";
    image.src = cardAssetUrl(label);
  }
}

function resetModelState() {
  appState.modelLabels = [];
  appState.modelInputSize = 0;
}

function rejectPendingRequests(error) {
  for (const { reject } of pendingRequests.values()) {
    reject(error);
  }

  pendingRequests.clear();
}

function disposeWorker(error = null) {
  if (inferenceWorker) {
    inferenceWorker.terminate();
    inferenceWorker = null;
  }

  if (error) {
    rejectPendingRequests(error);
  }
}

function handleWorkerMessage(event) {
  const { id, ok, result, error } = event.data || {};
  const pending = pendingRequests.get(id);

  if (!pending) {
    return;
  }

  pendingRequests.delete(id);

  if (ok) {
    pending.resolve(result);
    return;
  }

  pending.reject(new Error(error || "Inference worker request failed"));
}

function handleWorkerError(event) {
  const error = new Error(event.message || "Inference worker crashed");

  disposeWorker(error);
  resetModelState();

  emitModelPresentationChanged({
    badgeText: MODEL_BADGE_ERROR_TEXT,
    badgeState: "error",
  });
  emitStatusChanged(`Inference worker failed: ${error.message}`);
}

function ensureWorker() {
  if (inferenceWorker) {
    return inferenceWorker;
  }

  inferenceWorker = new Worker(
    new URL("./inference-worker.js", import.meta.url),
  );
  inferenceWorker.addEventListener("message", handleWorkerMessage);
  inferenceWorker.addEventListener("error", handleWorkerError);

  return inferenceWorker;
}

function requestWorker(type, payload = {}, transfer = []) {
  const worker = ensureWorker();

  return new Promise((resolve, reject) => {
    const id = `worker-${nextRequestId += 1}`;

    pendingRequests.set(id, { resolve, reject });

    try {
      worker.postMessage({ id, type, payload }, transfer);
    } catch (error) {
      pendingRequests.delete(id);
      reject(error);
    }
  });
}

export async function loadModel() {
  if (appState.modelLabels.length && appState.modelInputSize) {
    return {
      labels: appState.modelLabels,
      inputSize: appState.modelInputSize,
    };
  }

  if (appState.modelLoadPromise) {
    return appState.modelLoadPromise;
  }

  appState.modelLoadPromise = (async () => {
    try {
      emitStatusChanged("Loading ONNX model...");
      emitModelPresentationChanged({
        badgeText: MODEL_BADGE_LOADING_TEXT,
        badgeState: "loading",
      });

      resetModelState();

      const result = await requestWorker("load-model", {
        modelUrl: MODEL_URL,
        modelManifestUrl: MODEL_MANIFEST_URL,
      });

      appState.modelLabels = result.labels || [];
      appState.modelInputSize = result.inputSize || 0;

      preloadCardAssets(appState.modelLabels);

      emitModelPresentationChanged({
        badgeText: MODEL_BADGE_LOADED_TEXT,
        badgeState: "loaded",
      });
      emitStatusChanged(
        `Model ready: ${appState.modelLabels.length} classes, ${appState.modelInputSize}x${appState.modelInputSize}`,
      );

      return result;
    } catch (error) {
      resetModelState();

      emitModelPresentationChanged({
        badgeText: MODEL_BADGE_ERROR_TEXT,
        badgeState: "error",
      });
      emitStatusChanged(`Model load failed: ${error.message}`);

      throw error;
    }
  })();

  try {
    return await appState.modelLoadPromise;
  } finally {
    appState.modelLoadPromise = null;
  }
}

export async function runModelInference(imageBitmap, thresholds) {
  return requestWorker(
    "run-inference",
    {
      imageBitmap,
      thresholds,
    },
    [imageBitmap],
  );
}
