import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { runDetectorInference } from "./detector-model.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function readDotEnv(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const values = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values[key] = value;
    }

    return values;
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv(path.resolve(projectRoot, ".env"));

function envValue(name, fallback = "") {
  return process.env[name] ?? dotEnv[name] ?? fallback;
}

const DEV_SERVER_HOST = envValue("HOST", "127.0.0.1");
const DEV_SERVER_PORT = Number.parseInt(envValue("PORT", "5500"), 10);
const DEFAULT_POST_URL = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}/detector/results`;

const SOURCE_URL =
  envValue("DETECTOR_SOURCE_URL") ||
  "https://venti.gpc123.com/Aesexy/play.html?id=yangyang";
const POST_URL =
  envValue("DETECTOR_POST_URL") ||
  DEFAULT_POST_URL;
const INTERVAL_MS = Number.parseInt(envValue("DETECTOR_INTERVAL_MS", "500"), 10);
const TIMEOUT_MS = Number.parseInt(envValue("DETECTOR_TIMEOUT_MS", "30000"), 10);
const CONFIDENCE = Number.parseFloat(envValue("DETECTOR_CONFIDENCE", "0.25"));
const IOU = Number.parseFloat(envValue("DETECTOR_IOU", "0.70"));
const VIEWPORT_WIDTH = Number.parseInt(envValue("DETECTOR_VIEWPORT_WIDTH", "1280"), 10);
const VIEWPORT_HEIGHT = Number.parseInt(envValue("DETECTOR_VIEWPORT_HEIGHT", "720"), 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVideo(page) {
  await page.waitForSelector("video", { timeout: TIMEOUT_MS });

  await page.evaluate(async () => {
    const video = document.querySelector("video");

    if (!video) {
      return;
    }

    video.muted = true;

    try {
      await video.play();
    } catch {
      // Keep going and let the ready-state check decide whether frames are available.
    }
  });

  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    const rect = video?.getBoundingClientRect();

    return Boolean(
      video &&
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0,
    );
  }, { timeout: TIMEOUT_MS });
}

async function captureVideoElement(page) {
  const video = await page.$("video");

  if (!video) {
    throw new Error("The livestream page does not contain a video element");
  }

  const boundingBox = await video.boundingBox();

  if (!boundingBox || !boundingBox.width || !boundingBox.height) {
    throw new Error("The livestream video element is not visible");
  }

  const screenshot = await video.screenshot({ type: "png" });
  return {
    screenshot,
    frame: {
      width: Math.round(boundingBox.width),
      height: Math.round(boundingBox.height),
    },
  };
}

async function publishResult(payload) {
  const response = await fetch(POST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Detector publish failed: HTTP ${response.status}`);
  }
}

const browser = await puppeteer.launch({
  headless: "new",
  defaultViewport: {
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
  },
});

const page = await browser.newPage();

process.on("SIGINT", async () => {
  await browser.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await browser.close();
  process.exit(0);
});

console.log(`Opening ${SOURCE_URL}`);
await page.goto(SOURCE_URL, {
  waitUntil: "domcontentloaded",
  timeout: TIMEOUT_MS,
});
await waitForVideo(page);

console.log(
  `Detector ready. Posting results to ${POST_URL} every ${INTERVAL_MS}ms`,
);

for (;;) {
  try {
    const capturedAt = new Date().toISOString();
    const { screenshot, frame } = await captureVideoElement(page);
    const inference = await runDetectorInference(screenshot, {
      confidence: CONFIDENCE,
      iou: IOU,
    });

    await publishResult({
      source: SOURCE_URL,
      capturedAt,
      frame,
      detections: inference.detections,
      inferenceMs: inference.inferenceMs,
      preprocessMs: inference.preprocessMs,
      postprocessMs: inference.postprocessMs,
      totalMs: inference.totalMs,
      rawModelOutput: inference.rawModelOutput,
    });
  } catch (error) {
    const details =
      error?.cause?.message && error.cause.message !== error.message
        ? ` (${error.cause.message})`
        : "";
    console.error(`[detector] ${error.message}${details}`);
  }

  await sleep(INTERVAL_MS);
}
