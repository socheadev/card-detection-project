export const DEFAULT_STREAM_URL = "https://venti.gpc123.com/Aesexy/play.html?id=yangyang";

export const DEFAULT_CONFIDENCE = 0.25;
export const DEFAULT_IOU = 0.70;
export const DEFAULT_INTERVAL_MS = 180;
export const AUTO_LOAD_STREAM = false;
export const CARD_REVEAL_SCORE = 0.75;
export const DEFAULT_RABBITMQ_URL = "https://rabbitmq.sclabproxserver.qzz.io";
export const DEFAULT_RABBITMQ_VHOST = "/";
export const DEFAULT_RABBITMQ_EXCHANGE = "amq.direct";
export const DEFAULT_RABBITMQ_ROUTING_KEY = "card.detection";

export const MODEL_BADGE_IDLE_TEXT = "Not loaded";
export const MODEL_BADGE_LOADING_TEXT = "Loading...";
export const MODEL_BADGE_LOADED_TEXT = "Loaded";
export const MODEL_BADGE_ERROR_TEXT = "Error";

export const STATUS_WAITING_FOR_STREAM_TEXT = "Waiting for a stream";
export const TIMING_IDLE_TEXT = "No inference yet";
export const RAW_MODEL_OUTPUT_IDLE_TEXT = "";
export const COPY_BUTTON_IDLE_TEXT = "Copy Data";
export const BROADCAST_STATUS_IDLE_TEXT = "Disabled";

export const MODEL_URL = new URL("../model/best.onnx", import.meta.url).toString();
export const MODEL_MANIFEST_URL = new URL("../model/best.onnx.manifest.json", import.meta.url).toString();
export const CARD_ASSET_DIR = new URL("../card/", import.meta.url).toString();

export const SIDE_ORDER = ["PLAYER", "BANKER"];
export const ROI_SLOT_OPTIONS = [1, 2, 3];

const ROI_STORAGE_KEY = "capture-video-preview-rois-v1";

const LEGACY_ROI_LAYOUT_FRAME = {
  width: 1280,
  height: 720,
};

const ROI_LAYOUT_FRAME = {
  width: 1280,
  height: 1280,
};

export const ROI_REFERENCE_FRAME = { ...ROI_LAYOUT_FRAME };

function normalizeRoiBox({ x1, y1, x2, y2 }, frame = ROI_LAYOUT_FRAME) {
  return normalizeBounds({
    minX: x1 / frame.width,
    maxX: x2 / frame.width,
    minY: y1 / frame.height,
    maxY: y2 / frame.height,
  });
}

function remapReferenceBox(box, fromFrame, toFrame) {
  return {
    x1: Math.round((box.x1 / fromFrame.width) * toFrame.width),
    y1: Math.round((box.y1 / fromFrame.height) * toFrame.height),
    x2: Math.round((box.x2 / fromFrame.width) * toFrame.width),
    y2: Math.round((box.y2 / fromFrame.height) * toFrame.height),
  };
}

function normalizeLegacyRoiBox(box) {
  return normalizeRoiBox(
    remapReferenceBox(box, LEGACY_ROI_LAYOUT_FRAME, ROI_LAYOUT_FRAME),
  );
}

const ROI_SLOTS = [
  {
    name: "PLAYER_1",
    side: "PLAYER",
    index: 0,
    slot: 1,
    config: normalizeLegacyRoiBox({ x1: 392, y1: 426, x2: 497, y2: 476 }),
  },
  {
    name: "PLAYER_2",
    side: "PLAYER",
    index: 1,
    slot: 2,
    config: normalizeLegacyRoiBox({ x1: 488, y1: 428, x2: 563, y2: 503 }),
  },
  {
    name: "PLAYER_3",
    side: "PLAYER",
    index: 2,
    slot: 3,
    config: normalizeLegacyRoiBox({ x1: 564, y1: 428, x2: 639, y2: 503 }),
  },
  {
    name: "BANKER_1",
    side: "BANKER",
    index: 0,
    slot: 1,
    config: normalizeLegacyRoiBox({ x1: 650, y1: 429, x2: 725, y2: 504 }),
  },
  {
    name: "BANKER_2",
    side: "BANKER",
    index: 1,
    slot: 2,
    config: normalizeLegacyRoiBox({ x1: 731, y1: 431, x2: 806, y2: 506 }),
  },
  {
    name: "BANKER_3",
    side: "BANKER",
    index: 2,
    slot: 3,
    config: normalizeLegacyRoiBox({ x1: 805, y1: 432, x2: 910, y2: 482 }),
  },
];

export const ROI_ORDER = ROI_SLOTS.map((slot) => slot.name);
export const ROI_INDEX = Object.fromEntries(
  ROI_SLOTS.map((slot) => [slot.name, slot.index]),
);
export const ROI_SIDE = Object.fromEntries(
  ROI_SLOTS.map((slot) => [slot.name, slot.side]),
);

const INITIAL_ROI_CONFIG = Object.fromEntries(
  ROI_SLOTS.map((slot) => [slot.name, slot.config]),
);
const INITIAL_ROI_SLOT_CONFIG = Object.fromEntries(
  ROI_SLOTS.map((slot) => [slot.name, slot.slot]),
);

function cloneRoiConfig(config) {
  return Object.fromEntries(
    Object.entries(config).map(([roi, bounds]) => [roi, { ...bounds }]),
  );
}

function cloneRoiSlotConfig(config) {
  return Object.fromEntries(
    Object.entries(config).map(([roi, slot]) => [roi, slot]),
  );
}

function normalizeRoiSlot(value, fallback = 1) {
  const slot = Number.parseInt(value, 10);
  return ROI_SLOT_OPTIONS.includes(slot) ? slot : fallback;
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function persistRoiState() {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(
      ROI_STORAGE_KEY,
      JSON.stringify({
        rois: Object.fromEntries(
          ROI_ORDER.map((roi) => [
            roi,
            {
              bounds: ROI_CONFIG[roi],
              slot: ROI_SLOT_CONFIG[roi],
            },
          ]),
        ),
      }),
    );
  } catch {
    // Ignore storage failures and keep the in-memory config.
  }
}

function readStoredRoiState() {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(ROI_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const roiEntries = parsed?.rois && typeof parsed.rois === "object"
      ? parsed.rois
      : parsed;

    if (!roiEntries || typeof roiEntries !== "object") {
      return null;
    }

    const roiConfig = {};
    const roiSlotConfig = {};

    for (const roi of ROI_ORDER) {
      const entry = roiEntries[roi];
      const bounds = entry?.bounds || entry;

      if (!bounds) {
        throw new Error(`Missing stored ROI ${roi}`);
      }

      roiConfig[roi] = normalizeBounds(bounds);
      roiSlotConfig[roi] = normalizeRoiSlot(
        entry?.slot,
        INITIAL_ROI_SLOT_CONFIG[roi],
      );
    }

    return {
      roiConfig,
      roiSlotConfig,
    };
  } catch {
    return null;
  }
}

const storedRoiState = readStoredRoiState();

export let ROI_CONFIG = storedRoiState?.roiConfig || cloneRoiConfig(INITIAL_ROI_CONFIG);
export let ROI_SLOT_CONFIG =
  storedRoiState?.roiSlotConfig || cloneRoiSlotConfig(INITIAL_ROI_SLOT_CONFIG);

export const els = {
  sourceInput: document.querySelector("#sourceInput"),
  loadStreamBtn: document.querySelector("#loadStreamBtn"),
  startDetectBtn: document.querySelector("#startDetectBtn"),
  stopDetectBtn: document.querySelector("#stopDetectBtn"),
  broadcastUrlInput: document.querySelector("#broadcastUrlInput"),
  rabbitmqUrlInput: document.querySelector("#rabbitmqUrlInput"),
  rabbitmqVhostInput: document.querySelector("#rabbitmqVhostInput"),
  rabbitmqExchangeInput: document.querySelector("#rabbitmqExchangeInput"),
  rabbitmqRoutingKeyInput: document.querySelector("#rabbitmqRoutingKeyInput"),
  rabbitmqViewerStatus: document.querySelector("#rabbitmqViewerStatus"),
  rabbitmqViewerCount: document.querySelector("#rabbitmqViewerCount"),
  rabbitmqViewerOutput: document.querySelector("#rabbitmqViewerOutput"),
  toggleBroadcastBtn: document.querySelector("#toggleBroadcastBtn"),
  toggleRoiEditorBtn: document.querySelector("#toggleRoiEditorBtn"),
  loadRoiEditorBtn: document.querySelector("#loadRoiEditorBtn"),
  saveRoiEditorBtn: document.querySelector("#saveRoiEditorBtn"),
  resetRoiEditorBtn: document.querySelector("#resetRoiEditorBtn"),
  roiInputsPanel: document.querySelector("#roiInputsPanel"),
  confidenceInput: document.querySelector("#confidenceInput"),
  iouInput: document.querySelector("#iouInput"),
  intervalInput: document.querySelector("#intervalInput"),
  video: document.querySelector("#video"),
  remoteFrame: document.querySelector("#remoteFrame"),
  overlay: document.querySelector("#overlay"),
  roiEditorOverlay: document.querySelector("#roiEditorOverlay"),
  cardsOverlay: document.querySelector("#cardsOverlay"),
  modelBadge: document.querySelector("#modelBadge"),
  statusText: document.querySelector("#statusText"),
  timingText: document.querySelector("#timingText"),
  countValue: document.querySelector("#countValue"),
  bestScoreValue: document.querySelector("#bestScoreValue"),
  broadcastStatusValue: document.querySelector("#broadcastStatusValue"),
  copyRawModelBtn: document.querySelector("#copyRawModelBtn"),
  rawModelOutput: document.querySelector("#rawModelOutput"),
  roiFileInput: document.querySelector("#roiFileInput"),
};

export const overlayCtx = els.overlay?.getContext("2d") || null;

const previewEventBus = new EventTarget();

export const PREVIEW_EVENTS = {
  runtimeViewChanged: "preview:runtime-view-changed",
  overlayInvalidated: "preview:overlay-invalidated",
  statusChanged: "preview:status-changed",
  modelPresentationChanged: "preview:model-presentation-changed",
  broadcastStateChanged: "preview:broadcast-state-changed",
};

function emitPreviewEvent(type, detail = {}) {
  previewEventBus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function onPreviewEvent(type, listener) {
  previewEventBus.addEventListener(type, listener);

  return () => {
    previewEventBus.removeEventListener(type, listener);
  };
}

export function emitRuntimeViewChanged() {
  emitPreviewEvent(PREVIEW_EVENTS.runtimeViewChanged);
}

export function emitOverlayInvalidated() {
  emitPreviewEvent(PREVIEW_EVENTS.overlayInvalidated);
}

export function emitStatusChanged(text) {
  emitPreviewEvent(PREVIEW_EVENTS.statusChanged, { text });
}

export function emitModelPresentationChanged(detail) {
  emitPreviewEvent(PREVIEW_EVENTS.modelPresentationChanged, detail);
}

export function emitBroadcastStateChanged(detail) {
  emitPreviewEvent(PREVIEW_EVENTS.broadcastStateChanged, detail);
}

export const appState = {
  hls: null,
  fileObjectUrl: "",
  modelLoadPromise: null,
  modelLabels: [],
  modelInputSize: 0,
  streamMode: "video",
  streamReady: false,
  loadingStream: false,
  preparingDetection: false,
  detecting: false,
  startingDetection: false,
  detectionSessionId: 0,
  inferenceBusy: false,
  animationFrameId: 0,
  lastRunAt: 0,
  hideCardsUntilClear: false,
  roiEditorEnabled: false,
  roiInputsCollapsed: true,
  broadcastEnabled: false,
  broadcastTargetUrl: "",
  rabbitmqUrl: "",
  rabbitmqVhost: DEFAULT_RABBITMQ_VHOST,
  rabbitmqExchange: DEFAULT_RABBITMQ_EXCHANGE,
  rabbitmqRoutingKey: DEFAULT_RABBITMQ_ROUTING_KEY,
};

export function createEmptyRuntimeView() {
  return {
    rawDetections: [],
    matchedDetections: [],
    displayedDetections: [],
    rawModelOutput: null,
    rawModelOutputs: [],
    lastInferenceMs: 0,
    lastPostprocessMs: 0,
    lastTotalMs: 0,
    lastUiRenderMs: 0,
    debugText: "",
  };
}

export const runtimeView = createEmptyRuntimeView();

export function applyRuntimeView(nextView) {
  Object.assign(runtimeView, createEmptyRuntimeView(), nextView);
}

export function resetRuntimeView() {
  applyRuntimeView(createEmptyRuntimeView());
}

export function buildRuntimeView({
  rawDetections = [],
  matchedDetections = [],
  displayedDetections = [],
  rawModelOutput = null,
  lastInferenceMs = 0,
  lastPostprocessMs = 0,
  lastTotalMs = 0,
  debugText = "",
} = {}) {
  const outputs = rawModelOutput ? [rawModelOutput] : [];

  return {
    rawDetections,
    matchedDetections,
    displayedDetections,
    rawModelOutput,
    rawModelOutputs: outputs,
    lastInferenceMs,
    lastPostprocessMs,
    lastTotalMs,
    debugText,
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBoundValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeBounds(bounds) {
  const minX = clamp(normalizeBoundValue(bounds?.minX), 0, 1);
  const maxX = clamp(normalizeBoundValue(bounds?.maxX), minX, 1);
  const minY = clamp(normalizeBoundValue(bounds?.minY), 0, 1);
  const maxY = clamp(normalizeBoundValue(bounds?.maxY), minY, 1);

  return {
    minX,
    maxX,
    minY,
    maxY,
  };
}

export function parseNumberInput(input, fallback) {
  const value = Number.parseFloat(input?.value || "");
  return Number.isFinite(value) ? value : fallback;
}

export function parseIntegerInput(input, fallback) {
  const value = Number.parseInt(input?.value || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export function currentThresholds() {
  return {
    confidence: clamp(
      parseNumberInput(els.confidenceInput, DEFAULT_CONFIDENCE),
      0.01,
      1,
    ),
    iou: clamp(parseNumberInput(els.iouInput, DEFAULT_IOU), 0.01, 1),
    intervalMs: clamp(
      parseIntegerInput(els.intervalInput, DEFAULT_INTERVAL_MS),
      16,
      2000,
    ),
  };
}

export function cardAssetUrl(label) {
  return new URL(`${label}.webp`, CARD_ASSET_DIR).toString();
}

export function currentRoiConfig() {
  return cloneRoiConfig(ROI_CONFIG);
}

export function currentRoiSlotConfig() {
  return cloneRoiSlotConfig(ROI_SLOT_CONFIG);
}

export function roiSlotValue(roi) {
  return ROI_SLOT_CONFIG[roi] || INITIAL_ROI_SLOT_CONFIG[roi] || 1;
}

export function roiBoundsToReferencePixels(bounds) {
  return {
    x1: Math.round(bounds.minX * ROI_LAYOUT_FRAME.width),
    y1: Math.round(bounds.minY * ROI_LAYOUT_FRAME.height),
    x2: Math.round(bounds.maxX * ROI_LAYOUT_FRAME.width),
    y2: Math.round(bounds.maxY * ROI_LAYOUT_FRAME.height),
    width: Math.round((bounds.maxX - bounds.minX) * ROI_LAYOUT_FRAME.width),
    height: Math.round((bounds.maxY - bounds.minY) * ROI_LAYOUT_FRAME.height),
  };
}

export function referencePixelsToRoiBounds(
  { x1, y1, width, height },
  frame = ROI_LAYOUT_FRAME,
) {
  return normalizeBounds({
    minX: x1 / frame.width,
    maxX: (x1 + width) / frame.width,
    minY: y1 / frame.height,
    maxY: (y1 + height) / frame.height,
  });
}

export function exportRoiLayout() {
  return {
    referenceFrame: { ...ROI_REFERENCE_FRAME },
    rois: ROI_ORDER.map((roi) => ({
      name: roi,
      side: ROI_SIDE[roi],
      index: ROI_INDEX[roi],
      slot: roiSlotValue(roi),
      roi: roiBoundsToReferencePixels(ROI_CONFIG[roi]),
    })),
  };
}

export function importRoiLayout(layout) {
  if (!layout || typeof layout !== "object") {
    throw new Error("ROI file is not valid JSON");
  }

  const layoutFrame = {
    width: Number.parseInt(layout.referenceFrame?.width, 10) || ROI_LAYOUT_FRAME.width,
    height: Number.parseInt(layout.referenceFrame?.height, 10) || ROI_LAYOUT_FRAME.height,
  };

  const nextConfig = {};
  const nextSlotConfig = {};
  const entries = Array.isArray(layout.rois) ? layout.rois : null;

  if (entries) {
    for (const entry of entries) {
      const roi = entry?.name;
      const bounds = entry?.roi;

      if (!roi || !bounds || !INITIAL_ROI_CONFIG[roi]) {
        continue;
      }

      nextConfig[roi] = referencePixelsToRoiBounds(
        {
          x1: Number.parseInt(bounds.x1, 10),
          y1: Number.parseInt(bounds.y1, 10),
          width: Number.parseInt(bounds.width, 10),
          height: Number.parseInt(bounds.height, 10),
        },
        layoutFrame,
      );
      nextSlotConfig[roi] = normalizeRoiSlot(
        entry?.slot,
        INITIAL_ROI_SLOT_CONFIG[roi],
      );
    }
  } else {
    for (const roi of ROI_ORDER) {
      const bounds = layout[roi]?.roi || layout[roi];

      if (!bounds) {
        continue;
      }

      nextConfig[roi] = referencePixelsToRoiBounds(
        {
          x1: Number.parseInt(bounds.x1, 10),
          y1: Number.parseInt(bounds.y1, 10),
          width: Number.parseInt(bounds.width, 10),
          height: Number.parseInt(bounds.height, 10),
        },
        layoutFrame,
      );
      nextSlotConfig[roi] = normalizeRoiSlot(
        layout[roi]?.slot,
        INITIAL_ROI_SLOT_CONFIG[roi],
      );
    }
  }

  for (const roi of ROI_ORDER) {
    if (!nextConfig[roi]) {
      throw new Error(`ROI file is missing ${roi}`);
    }

    if (!nextSlotConfig[roi]) {
      nextSlotConfig[roi] = INITIAL_ROI_SLOT_CONFIG[roi];
    }
  }

  ROI_CONFIG = cloneRoiConfig(nextConfig);
  ROI_SLOT_CONFIG = cloneRoiSlotConfig(nextSlotConfig);
  persistRoiState();
  emitOverlayInvalidated();
}

export function updateRoiConfig(roi, bounds) {
  if (!(roi in ROI_CONFIG)) {
    return;
  }

  ROI_CONFIG = {
    ...ROI_CONFIG,
    [roi]: normalizeBounds(bounds),
  };
  persistRoiState();
  emitOverlayInvalidated();
}

export function updateRoiSlotConfig(roi, slot) {
  if (!(roi in ROI_SLOT_CONFIG)) {
    return;
  }

  ROI_SLOT_CONFIG = {
    ...ROI_SLOT_CONFIG,
    [roi]: normalizeRoiSlot(slot, INITIAL_ROI_SLOT_CONFIG[roi]),
  };
  persistRoiState();
  emitOverlayInvalidated();
}

export function resetRoiConfig() {
  ROI_CONFIG = cloneRoiConfig(INITIAL_ROI_CONFIG);
  ROI_SLOT_CONFIG = cloneRoiSlotConfig(INITIAL_ROI_SLOT_CONFIG);
  persistRoiState();
  emitOverlayInvalidated();
}

function normalizedBoundsToPixels(config, sourceWidth, sourceHeight) {
  if (!config || !sourceWidth || !sourceHeight) {
    return null;
  }

  const x = clamp(Math.floor(sourceWidth * config.minX), 0, sourceWidth);
  const y = clamp(Math.floor(sourceHeight * config.minY), 0, sourceHeight);
  const right = clamp(Math.ceil(sourceWidth * config.maxX), x + 1, sourceWidth);
  const bottom = clamp(Math.ceil(sourceHeight * config.maxY), y + 1, sourceHeight);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function roiPixelBounds(roi, sourceWidth, sourceHeight) {
  return normalizedBoundsToPixels(ROI_CONFIG[roi], sourceWidth, sourceHeight);
}

export function fullFrameRoiBounds(sourceWidth, sourceHeight) {
  return Object.fromEntries(
    ROI_ORDER.map((roi) => [roi, roiPixelBounds(roi, sourceWidth, sourceHeight)]),
  );
}

function compareRoisForDisplay(leftRoi, rightRoi) {
  if (!leftRoi || !rightRoi) {
    return 0;
  }

  const slotDiff = roiSlotValue(leftRoi) - roiSlotValue(rightRoi);

  if (slotDiff !== 0) {
    return slotDiff;
  }

  return ROI_INDEX[leftRoi] - ROI_INDEX[rightRoi];
}

export function groupDetectionsBySide(detections) {
  const grouped = Object.fromEntries(SIDE_ORDER.map((side) => [side, []]));

  for (const detection of detections) {
    const side = detection?.side || ROI_SIDE[detection?.roi] || "";

    if (side && grouped[side]) {
      grouped[side].push(detection);
    }
  }

  for (const side of SIDE_ORDER) {
    grouped[side].sort((left, right) => compareRoisForDisplay(left.roi, right.roi));
  }

  return grouped;
}

export function limitDetectionsPerRoi(detections, maxPerRoi = 1) {
  const grouped = Object.fromEntries(ROI_ORDER.map((roi) => [roi, []]));

  for (const detection of detections) {
    if (detection?.roi && grouped[detection.roi]) {
      grouped[detection.roi].push(detection);
    }
  }

  const limited = [];

  for (const roi of ROI_ORDER) {
    let count = 0;

    for (const detection of grouped[roi]) {
      if (count >= maxPerRoi) {
        break;
      }

      limited.push(detection);
      count += 1;
    }
  }

  return limited;
}

export function cardsOverlayKey(groupedDetections) {
  return SIDE_ORDER.map((side) => {
    const detections = groupedDetections[side] || [];

    return `${side}:${detections
      .map((detection) =>
        `${detection.roi}:${detection.label}:${(detection.score || 0) >= CARD_REVEAL_SCORE ? "revealed" : "default"}`,
      )
      .join(",")}`;
  }).join("|");
}
