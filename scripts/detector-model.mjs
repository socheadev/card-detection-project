import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ort from "onnxruntime-node";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const DEFAULT_MODEL_PATH = path.resolve(projectRoot, "model", "best.onnx");

const state = {
  session: null,
  labels: [],
  inputSize: 0,
  inputName: "",
  outputName: "",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberFromDim(value) {
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
    return numberFromDim(
      value.dimValue ?? value.value ?? value.dimension ?? value.size ?? 0,
    );
  }

  return 0;
}

function extractLabels(modelBytes) {
  const text = new TextDecoder("latin1").decode(modelBytes);
  const index = text.indexOf("names");

  if (index < 0) {
    return [];
  }

  const match = text.slice(index, index + 8192).match(/\{[^}]+\}/);

  if (!match) {
    return [];
  }

  const labels = [];

  for (const entry of match[0].matchAll(/(\d+)\s*:\s*['"]([^'"]+)['"]/g)) {
    const classId = Number.parseInt(entry[1], 10);
    const label = entry[2]?.trim();

    if (Number.isFinite(classId) && label) {
      labels[classId] = label;
    }
  }

  return labels.filter(Boolean);
}

function extractSquareInputSizeFromBytes(modelBytes) {
  const text = new TextDecoder("latin1").decode(modelBytes);
  const index = text.indexOf("imgsz");

  if (index < 0) {
    return 0;
  }

  const match =
    text.slice(index, index + 256).match(/\[(\d+)\s*,\s*(\d+)\]/) ||
    text.slice(index, index + 256).match(/(\d+)\s*,\s*(\d+)/);

  if (!match) {
    return 0;
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);

  return width && width === height ? width : 0;
}

function extractSquareInputSizeFromSession(session) {
  const inputName = session.inputNames?.[0];
  const metadata = inputName ? session.inputMetadata?.[inputName] : null;
  const dims = metadata?.dimensions || metadata?.dims || metadata?.shape || [];

  if (!Array.isArray(dims) || dims.length < 4) {
    return 0;
  }

  const width = numberFromDim(dims[dims.length - 1]);
  const height = numberFromDim(dims[dims.length - 2]);

  return width && width === height ? width : 0;
}

function describeOutput(outputTensor) {
  const dims = outputTensor.dims || [];
  const classCount = state.labels.length;
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
  } else if (dims.length === 2) {
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
    dims: [...dims],
    data: outputTensor.data,
    classCount,
    channelCount,
    boxCount,
    channelsFirst,
    hasObjectness: channelCount === classCount + 5,
  };
}

function outputValue(layout, channel, boxIndex) {
  if (layout.channelsFirst) {
    return layout.data[(channel * layout.boxCount) + boxIndex];
  }

  return layout.data[(boxIndex * layout.channelCount) + channel];
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

function iou(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);

  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersection = intersectionWidth * intersectionHeight;
  const union =
    (left.width * left.height) +
    (right.width * right.height) -
    intersection;

  return union > 0 ? intersection / union : 0;
}

function nonMaxSuppression(detections, iouThreshold) {
  const ranked = [...detections].sort(
    (left, right) => (right.score || 0) - (left.score || 0),
  );
  const kept = [];
  const removed = new Uint8Array(ranked.length);

  for (let index = 0; index < ranked.length; index += 1) {
    if (removed[index]) {
      continue;
    }

    const candidate = ranked[index];
    kept.push(candidate);

    for (let otherIndex = index + 1; otherIndex < ranked.length; otherIndex += 1) {
      const other = ranked[otherIndex];

      if (
        removed[otherIndex] ||
        candidate.classId !== other.classId ||
        iou(candidate, other) <= iouThreshold
      ) {
        continue;
      }

      removed[otherIndex] = 1;
    }
  }

  return kept;
}

function decodeBox(layout, boxIndex, transform) {
  const cx = outputValue(layout, 0, boxIndex);
  const cy = outputValue(layout, 1, boxIndex);
  const width = outputValue(layout, 2, boxIndex);
  const height = outputValue(layout, 3, boxIndex);

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

function summarizeScores(layout, boxIndex, classOffset) {
  let bestClass = -1;
  let bestClassScore = Number.NEGATIVE_INFINITY;

  for (let classIndex = 0; classIndex < layout.classCount; classIndex += 1) {
    const classScore = clamp(
      outputValue(layout, classOffset + classIndex, boxIndex),
      0,
      1,
    );

    if (classScore > bestClassScore) {
      bestClassScore = classScore;
      bestClass = classIndex;
    }
  }

  const objectness = layout.hasObjectness
    ? clamp(outputValue(layout, 4, boxIndex), 0, 1)
    : 1;

  return {
    bestClass,
    bestClassScore,
    objectness,
    confidence: objectness * bestClassScore,
  };
}

function decodeOutput(outputTensor, transform, thresholds) {
  const layout = describeOutput(outputTensor);
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
      label: state.labels[bestClass] || `class_${bestClass}`,
      classId: bestClass,
      score: confidence,
      objectness,
      classScore: bestClassScore,
      ...box,
    });
  }

  const detections = nonMaxSuppression(preNms, thresholds.iou);

  return {
    detections,
    outputDims: layout.dims,
    preNmsCount: preNms.length,
  };
}

async function prepareInput(imageBuffer) {
  const size = state.inputSize;

  if (!size) {
    throw new Error("Model input size is not available");
  }

  const image = sharp(imageBuffer, { failOn: "none" }).removeAlpha();
  const metadata = await image.metadata();
  const frameWidth = metadata.width || 0;
  const frameHeight = metadata.height || 0;

  if (!frameWidth || !frameHeight) {
    throw new Error("Screenshot frame is empty");
  }

  const scale = Math.min(size / frameWidth, size / frameHeight);
  const drawWidth = Math.round(frameWidth * scale);
  const drawHeight = Math.round(frameHeight * scale);
  const padX = Math.floor((size - drawWidth) / 2);
  const padY = Math.floor((size - drawHeight) / 2);

  const pixels = await image
    .resize(size, size, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114, alpha: 1 },
    })
    .raw()
    .toBuffer();

  const planeSize = size * size;
  const inputBuffer = new Float32Array(planeSize * 3);

  for (let index = 0; index < planeSize; index += 1) {
    const pixelOffset = index * 3;
    inputBuffer[index] = pixels[pixelOffset] / 255;
    inputBuffer[planeSize + index] = pixels[pixelOffset + 1] / 255;
    inputBuffer[(planeSize * 2) + index] = pixels[pixelOffset + 2] / 255;
  }

  return {
    tensor: new ort.Tensor("float32", inputBuffer, [1, 3, size, size]),
    scale,
    padX,
    padY,
    frameWidth,
    frameHeight,
  };
}

export async function loadDetectorModel(modelPath = DEFAULT_MODEL_PATH) {
  if (state.session) {
    return {
      labels: state.labels,
      inputSize: state.inputSize,
    };
  }

  const modelBytes = await readFile(modelPath);
  const labels = extractLabels(modelBytes);

  if (!labels.length) {
    throw new Error("Could not extract class labels from model data");
  }

  const session = await ort.InferenceSession.create(modelBytes);
  const inputSize =
    extractSquareInputSizeFromSession(session) ||
    extractSquareInputSizeFromBytes(modelBytes);

  if (!inputSize) {
    throw new Error("Could not extract a square input size from model data");
  }

  state.session = session;
  state.labels = labels;
  state.inputSize = inputSize;
  state.inputName = session.inputNames?.[0] || "";
  state.outputName = session.outputNames?.[0] || "";

  return {
    labels,
    inputSize,
  };
}

export async function runDetectorInference(imageBuffer, thresholds = {}) {
  await loadDetectorModel();

  if (!state.session) {
    throw new Error("Model is not loaded");
  }

  const normalizedThresholds = normalizeThresholds(thresholds);

  const preprocessStarted = performance.now();
  const prepared = await prepareInput(imageBuffer);
  const preprocessMs = performance.now() - preprocessStarted;

  const inferenceStarted = performance.now();
  const outputs = await state.session.run({
    [state.inputName]: prepared.tensor,
  });
  const inferenceMs = performance.now() - inferenceStarted;

  const outputTensor = outputs[state.outputName] || outputs[Object.keys(outputs)[0]];

  if (!outputTensor) {
    throw new Error("Model did not return an output tensor");
  }

  const postprocessStarted = performance.now();
  const decoded = decodeOutput(outputTensor, prepared, normalizedThresholds);
  const postprocessMs = performance.now() - postprocessStarted;

  return {
    detections: decoded.detections,
    inferenceMs,
    preprocessMs,
    postprocessMs,
    totalMs: preprocessMs + inferenceMs + postprocessMs,
    rawModelOutput: {
      inputSize: state.inputSize,
      preNmsCount: decoded.preNmsCount,
      detectionCount: decoded.detections.length,
      outputDims: decoded.outputDims,
    },
  };
}
