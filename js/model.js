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

let worker = null;
let nextRequestId = 0;

function modelSnapshot() {
  return {
    labels: appState.modelLabels,
    inputSize: appState.modelInputSize,
  };
}

function resetModelState() {
  appState.modelLabels = [];
  appState.modelInputSize = 0;
}

function setModelPresentation(text, state) {
  emitModelPresentationChanged({
    badgeText: text,
    badgeState: state,
  });
}

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

function rejectPendingRequests(error) {
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }

  pendingRequests.clear();
}

function disposeWorker(error = null) {
  if (worker) {
    worker.terminate();
    worker = null;
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
  setModelPresentation(MODEL_BADGE_ERROR_TEXT, "error");
  emitStatusChanged(`Inference worker failed: ${error.message}`);
}

function ensureWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./inference-worker.js", import.meta.url));
  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", handleWorkerError);
  return worker;
}

function requestWorker(type, payload = {}, transfer = []) {
  const activeWorker = ensureWorker();

  return new Promise((resolve, reject) => {
    const id = `worker-${nextRequestId += 1}`;

    pendingRequests.set(id, { resolve, reject });

    try {
      activeWorker.postMessage({ id, type, payload }, transfer);
    } catch (error) {
      pendingRequests.delete(id);
      reject(error);
    }
  });
}

export async function loadModel() {
  if (appState.modelLabels.length && appState.modelInputSize) {
    return modelSnapshot();
  }

  if (appState.modelLoadPromise) {
    return appState.modelLoadPromise;
  }

  appState.modelLoadPromise = (async () => {
    emitStatusChanged("Loading ONNX model...");
    setModelPresentation(MODEL_BADGE_LOADING_TEXT, "loading");
    resetModelState();

    try {
      const result = await requestWorker("load-model", {
        modelUrl: MODEL_URL,
        modelManifestUrl: MODEL_MANIFEST_URL,
      });

      appState.modelLabels = result.labels || [];
      appState.modelInputSize = result.inputSize || 0;

      preloadCardAssets(appState.modelLabels);
      setModelPresentation(MODEL_BADGE_LOADED_TEXT, "loaded");
      emitStatusChanged(
        `Model ready: ${appState.modelLabels.length} classes, ${appState.modelInputSize}x${appState.modelInputSize}`,
      );

      return modelSnapshot();
    } catch (error) {
      disposeWorker();
      resetModelState();
      setModelPresentation(MODEL_BADGE_ERROR_TEXT, "error");
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

export function runModelInference(imageBitmap, thresholds) {
  return requestWorker(
    "run-inference",
    {
      imageBitmap,
      thresholds,
    },
    [imageBitmap],
  );
}
