"use strict";

const ORT_WASM_BASE_URL = new URL(
  "../vendor/onnxruntime-web/",
  self.location.href,
).toString();
const PRE_NMS_PREVIEW_LIMIT = 32;

const workerState = {
  session: null,
  labels: [],
  inputSize: 0,
  inputName: "",
  outputName: "",
  preprocessCanvas: null,
  preprocessCtx: null,
  ortLoadPromise: null,
};

function wasmThreadCount() {
  const hardwareConcurrency = self.navigator?.hardwareConcurrency || 1;

  if (!self.crossOriginIsolated) {
    return 1;
  }

  return Math.max(1, Math.min(4, hardwareConcurrency));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureCanvas(size) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas is not available in this browser");
  }

  if (
    !workerState.preprocessCanvas ||
    workerState.preprocessCanvas.width !== size ||
    workerState.preprocessCanvas.height !== size
  ) {
    workerState.preprocessCanvas = new OffscreenCanvas(size, size);
    workerState.preprocessCtx = workerState.preprocessCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }

  if (!workerState.preprocessCtx) {
    throw new Error("Could not create a 2D context in the inference worker");
  }

  return workerState.preprocessCtx;
}

async function ensureOrtLoaded() {
  if (self.ort) {
    return self.ort;
  }

  if (workerState.ortLoadPromise) {
    return workerState.ortLoadPromise;
  }

  workerState.ortLoadPromise = new Promise((resolve, reject) => {
    try {
      self.importScripts(`${ORT_WASM_BASE_URL}ort.min.js`);

      if (!self.ort) {
        throw new Error("onnxruntime-web did not initialize in the inference worker");
      }

      resolve(self.ort);
    } catch (error) {
      reject(error);
    }
  });

  try {
    return await workerState.ortLoadPromise;
  } finally {
    workerState.ortLoadPromise = null;
  }
}

async function fetchBinaryAsset(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not read asset: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function concatUint8Arrays(chunks, expectedSize = 0) {
  const totalSize =
    expectedSize || chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  const combined = new Uint8Array(totalSize);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

async function fetchChunkedModelBytes(manifestUrl) {
  const response = await fetch(manifestUrl);

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }

    throw new Error(`Could not read model manifest: HTTP ${response.status}`);
  }

  const manifest = await response.json();

  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    return null;
  }

  const manifestBaseUrl = new URL("./", response.url);
  const chunks = await Promise.all(
    manifest.parts.map((part) => {
      if (!part?.path) {
        throw new Error("Invalid model manifest part");
      }

      return fetchBinaryAsset(new URL(part.path, manifestBaseUrl).toString());
    }),
  );

  return concatUint8Arrays(
    chunks,
    Number.isFinite(manifest.totalSize) ? manifest.totalSize : 0,
  );
}

async function fetchModelBytes(modelUrl, manifestUrl) {
  const chunkedBytes = await fetchChunkedModelBytes(manifestUrl);

  if (chunkedBytes) {
    return chunkedBytes;
  }

  return fetchBinaryAsset(modelUrl);
}

function extractLabelsFromOnnxBytes(bytes) {
  const rawText = new TextDecoder("latin1").decode(bytes);
  const namesIndex = rawText.indexOf("names");

  if (namesIndex < 0) {
    return [];
  }

  const namesSlice = rawText.slice(namesIndex, namesIndex + 8192);
  const namesMatch = namesSlice.match(/\{[^}]+\}/);

  if (!namesMatch) {
    return [];
  }

  const labels = [];

  for (const match of namesMatch[0].matchAll(/(\d+)\s*:\s*['"]([^'"]+)['"]/g)) {
    const classId = Number.parseInt(match[1], 10);
    const label = match[2]?.trim();

    if (!Number.isFinite(classId) || !label) {
      continue;
    }

    labels[classId] = label;
  }

  return labels.filter(Boolean);
}

function extractInputSizeFromOnnxBytes(bytes) {
  const rawText = new TextDecoder("latin1").decode(bytes);
  const imgszIndex = rawText.indexOf("imgsz");

  if (imgszIndex < 0) {
    return 0;
  }

  const imgszSlice = rawText.slice(imgszIndex, imgszIndex + 256);
  const imgszMatch =
    imgszSlice.match(/\[(\d+)\s*,\s*(\d+)\]/) ||
    imgszSlice.match(/(\d+)\s*,\s*(\d+)/);

  if (!imgszMatch) {
    return 0;
  }

  const width = Number.parseInt(imgszMatch[1], 10);
  const height = Number.parseInt(imgszMatch[2], 10);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width !== height) {
    return 0;
  }

  return width;
}

function normalizeDimension(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
  }

  if (typeof value === "string") {
    const normalized = Number.parseInt(value, 10);
    return Number.isFinite(normalized) ? normalized : 0;
  }

  if (value && typeof value === "object") {
    return normalizeDimension(
      value.dimValue ?? value.value ?? value.dimension ?? value.size ?? 0,
    );
  }

  return 0;
}

function extractInputSizeFromSession(session) {
  const inputName = session.inputNames?.[0];
  const metadata = inputName ? session.inputMetadata?.[inputName] : null;
  const dimensions = metadata?.dimensions || metadata?.dims || metadata?.shape || [];

  if (!Array.isArray(dimensions) || dimensions.length < 4) {
    return 0;
  }

  const width = normalizeDimension(dimensions[dimensions.length - 1]);
  const height = normalizeDimension(dimensions[dimensions.length - 2]);

  if (!width || !height || width !== height) {
    return 0;
  }

  return width;
}

async function createOrtSession(modelBytes) {
  try {
    return await self.ort.InferenceSession.create(modelBytes, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });
  } catch {
    return self.ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
}

async function loadModel(payload = {}) {
  if (workerState.session) {
    return {
      labels: workerState.labels,
      inputSize: workerState.inputSize,
    };
  }

  const ort = await ensureOrtLoaded();
  ort.env.wasm.numThreads = wasmThreadCount();
  ort.env.wasm.wasmPaths = ORT_WASM_BASE_URL;

  const modelBytes = await fetchModelBytes(
    payload.modelUrl,
    payload.modelManifestUrl,
  );
  const labels = extractLabelsFromOnnxBytes(modelBytes);

  if (!labels.length) {
    throw new Error("Could not extract class labels from model data");
  }

  const session = await createOrtSession(modelBytes);
  const inputSize =
    extractInputSizeFromSession(session) ||
    extractInputSizeFromOnnxBytes(modelBytes);

  if (!inputSize) {
    throw new Error("Could not extract a square input size from model data");
  }

  workerState.session = session;
  workerState.labels = labels;
  workerState.inputSize = inputSize;
  workerState.inputName = session.inputNames[0] || "";
  workerState.outputName = session.outputNames[0] || "";

  return {
    labels,
    inputSize,
  };
}

function describeOutputTensor(outputTensor) {
  const dims = outputTensor.dims;
  const data = outputTensor.data;
  const classCount = workerState.labels.length;

  let channelCount = 0;
  let boxCount = 0;
  let channelsFirst = true;

  const validChannelCount = (value) =>
    value === classCount + 4 || value === classCount + 5;

  if (dims.length === 3) {
    if (validChannelCount(dims[1])) {
      channelCount = dims[1];
      boxCount = dims[2];
    } else if (validChannelCount(dims[2])) {
      channelCount = dims[2];
      boxCount = dims[1];
      channelsFirst = false;
    }
  }

  if (dims.length === 2) {
    if (validChannelCount(dims[0])) {
      channelCount = dims[0];
      boxCount = dims[1];
    } else if (validChannelCount(dims[1])) {
      channelCount = dims[1];
      boxCount = dims[0];
      channelsFirst = false;
    }
  }

  if (!channelCount || !boxCount) {
    throw new Error(`Unsupported output shape: ${dims.join(" x ")}`);
  }

  return {
    dims,
    data,
    classCount,
    channelCount,
    boxCount,
    channelsFirst,
    hasObjectness: channelCount === classCount + 5,
  };
}

function valueAtOutput(layout, channel, boxIndex) {
  if (layout.channelsFirst) {
    return layout.data[channel * layout.boxCount + boxIndex];
  }

  return layout.data[boxIndex * layout.channelCount + channel];
}

function normalizeProbability(score) {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return clamp(score, 0, 1);
}

function summarizeScores(layout, boxIndex, classOffset) {
  let bestClass = -1;
  let bestClassScore = Number.NEGATIVE_INFINITY;

  for (let classIndex = 0; classIndex < layout.classCount; classIndex += 1) {
    const score = normalizeProbability(
      valueAtOutput(layout, classOffset + classIndex, boxIndex),
    );

    if (score > bestClassScore) {
      bestClassScore = score;
      bestClass = classIndex;
    }
  }

  const objectness = layout.hasObjectness
    ? normalizeProbability(valueAtOutput(layout, 4, boxIndex))
    : 1;

  return {
    bestClass,
    bestClassScore,
    objectness,
    confidence: objectness * bestClassScore,
  };
}

function prepareInputTensor(imageBitmap) {
  const size = workerState.inputSize;
  const sourceWidth = imageBitmap.width || 0;
  const sourceHeight = imageBitmap.height || 0;

  if (!size) {
    throw new Error("Model input size is not available");
  }

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Video frame is not ready yet");
  }

  const ctx = ensureCanvas(size);

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgb(114, 114, 114)";
  ctx.fillRect(0, 0, size, size);

  const scale = Math.min(size / sourceWidth, size / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const padX = Math.floor((size - drawWidth) / 2);
  const padY = Math.floor((size - drawHeight) / 2);

  ctx.drawImage(
    imageBitmap,
    0,
    0,
    sourceWidth,
    sourceHeight,
    padX,
    padY,
    drawWidth,
    drawHeight,
  );

  let imageData;

  try {
    imageData = ctx.getImageData(0, 0, size, size);
  } catch (error) {
    if (error?.name === "SecurityError") {
      throw new Error(
        "The stream is tainting the canvas. The video host must allow CORS for browser inference.",
      );
    }

    throw error;
  }

  const planeSize = size * size;
  const floatData = new Float32Array(planeSize * 3);
  const pixels = imageData.data;

  for (let index = 0; index < planeSize; index += 1) {
    const pixelOffset = index * 4;

    floatData[index] = pixels[pixelOffset] / 255;
    floatData[planeSize + index] = pixels[pixelOffset + 1] / 255;
    floatData[(planeSize * 2) + index] = pixels[pixelOffset + 2] / 255;
  }

  return {
    tensor: new self.ort.Tensor("float32", floatData, [1, 3, size, size]),
    scale,
    padX,
    padY,
    frameWidth: sourceWidth,
    frameHeight: sourceHeight,
  };
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);

  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersectionArea = intersectionWidth * intersectionHeight;

  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  const unionArea = leftArea + rightArea - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

function nonMaxSuppression(detections, iouThreshold) {
  const rankedDetections = [...detections].sort(
    (left, right) => (right.score || 0) - (left.score || 0),
  );
  const kept = [];
  const removed = new Uint8Array(rankedDetections.length);

  for (let index = 0; index < rankedDetections.length; index += 1) {
    if (removed[index]) {
      continue;
    }

    const candidate = rankedDetections[index];
    kept.push(candidate);

    for (let compareIndex = index + 1; compareIndex < rankedDetections.length; compareIndex += 1) {
      if (removed[compareIndex]) {
        continue;
      }

      const other = rankedDetections[compareIndex];

      if (candidate.classId !== other.classId) {
        continue;
      }

      if (intersectionOverUnion(candidate, other) > iouThreshold) {
        removed[compareIndex] = 1;
      }
    }
  }

  return kept;
}

function decodeBox(layout, boxIndex, transform) {
  const cx = valueAtOutput(layout, 0, boxIndex);
  const cy = valueAtOutput(layout, 1, boxIndex);
  const width = valueAtOutput(layout, 2, boxIndex);
  const height = valueAtOutput(layout, 3, boxIndex);

  const left = clamp(
    (cx - (width / 2) - transform.padX) / transform.scale,
    0,
    transform.frameWidth,
  );
  const top = clamp(
    (cy - (height / 2) - transform.padY) / transform.scale,
    0,
    transform.frameHeight,
  );
  const right = clamp(
    (cx + (width / 2) - transform.padX) / transform.scale,
    0,
    transform.frameWidth,
  );
  const bottom = clamp(
    (cy + (height / 2) - transform.padY) / transform.scale,
    0,
    transform.frameHeight,
  );

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function normalizeThresholds(thresholds = {}) {
  return {
    confidence: clamp(
      Number.isFinite(thresholds.confidence) ? thresholds.confidence : 0.25,
      0.01,
      1,
    ),
    iou: clamp(Number.isFinite(thresholds.iou) ? thresholds.iou : 0.70, 0.01, 1),
  };
}

function summarizeCandidate(candidate) {
  return {
    id: candidate.id,
    label: candidate.label,
    classId: candidate.classId,
    score: candidate.score,
    objectness: candidate.objectness,
    classScore: candidate.classScore,
    box: {
      x1: candidate.x,
      y1: candidate.y,
      x2: candidate.x + candidate.width,
      y2: candidate.y + candidate.height,
    },
  };
}

function decodeOutput(outputTensor, transform, thresholds) {
  const layout = describeOutputTensor(outputTensor);
  const classOffset = layout.hasObjectness ? 5 : 4;
  const preNms = [];

  for (let boxIndex = 0; boxIndex < layout.boxCount; boxIndex += 1) {
    const { bestClass, bestClassScore, objectness, confidence } =
      summarizeScores(layout, boxIndex, classOffset);

    if (bestClass < 0 || confidence < thresholds.confidence) {
      continue;
    }

    const box = decodeBox(layout, boxIndex, transform);

    if (box.width <= 0 || box.height <= 0) {
      continue;
    }

    preNms.push({
      id: `candidate-${boxIndex}`,
      label: workerState.labels[bestClass] || `class_${bestClass}`,
      classId: bestClass,
      score: confidence,
      objectness,
      classScore: bestClassScore,
      ...box,
    });
  }

  const preNmsPreview = [...preNms]
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, PRE_NMS_PREVIEW_LIMIT);
  const detections = nonMaxSuppression(preNms, thresholds.iou);
  const keptIds = new Set(detections.map((detection) => detection.id));

  return {
    detections,
    preNmsCount: preNms.length,
    preNmsPreview: preNmsPreview.map((candidate) => ({
      ...summarizeCandidate(candidate),
      keptAfterNms: keptIds.has(candidate.id),
    })),
    outputDims: [...layout.dims],
  };
}

function buildInferenceResult(decoded, outputTensor, timing) {
  const previewDetections = decoded.detections.slice(0, 12).map((detection) => ({
    label: detection.label,
    classId: detection.classId,
    score: detection.score,
    box: {
      x1: detection.x,
      y1: detection.y,
      x2: detection.x + detection.width,
      y2: detection.y + detection.height,
    },
  }));

  return {
    detections: decoded.detections,
    inferenceMs: timing.inferenceMs,
    preprocessMs: timing.preprocessMs,
    workerPostprocessMs: timing.postprocessMs,
    totalWorkerMs: timing.preprocessMs + timing.inferenceMs + timing.postprocessMs,
    rawModelOutput: {
      outputName: workerState.outputName,
      outputType: outputTensor.type,
      outputDims: decoded.outputDims,
      totalValues: outputTensor.data.length,
      inputSize: workerState.inputSize,
      preNmsCount: decoded.preNmsCount,
      detectionCount: decoded.detections.length,
      preNmsPreview: decoded.preNmsPreview,
      previewDetections,
    },
  };
}

async function runInference(payload = {}) {
  await loadModel(payload);

  if (!workerState.session) {
    throw new Error("Model is not loaded");
  }

  if (!payload.imageBitmap) {
    throw new Error("No frame was provided to the inference worker");
  }

  const thresholds = normalizeThresholds(payload.thresholds);

  const preprocessStarted = performance.now();
  const prepared = prepareInputTensor(payload.imageBitmap);
  const preprocessMs = performance.now() - preprocessStarted;

  const inferenceStarted = performance.now();
  const outputs = await workerState.session.run({
    [workerState.inputName]: prepared.tensor,
  });
  const inferenceMs = performance.now() - inferenceStarted;

  const postprocessStarted = performance.now();
  const outputTensor = outputs[workerState.outputName];
  const decoded = decodeOutput(outputTensor, prepared, thresholds);
  const postprocessMs = performance.now() - postprocessStarted;

  return buildInferenceResult(decoded, outputTensor, {
    preprocessMs,
    inferenceMs,
    postprocessMs,
  });
}

function postSuccess(id, result) {
  self.postMessage({ id, ok: true, result });
}

function postFailure(id, error) {
  self.postMessage({
    id,
    ok: false,
    error: error?.message || String(error),
  });
}

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data || {};

  if (!id || !type) {
    return;
  }

  try {
    if (type === "load-model") {
      postSuccess(id, await loadModel(payload));
      return;
    }

    if (type === "run-inference") {
      postSuccess(id, await runInference(payload));
      return;
    }

    throw new Error(`Unsupported worker request: ${type}`);
  } catch (error) {
    postFailure(id, error);
  } finally {
    if (payload?.imageBitmap?.close) {
      payload.imageBitmap.close();
    }
  }
});
