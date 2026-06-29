import {
  appState,
  DEFAULT_STREAM_URL,
  els,
  emitOverlayInvalidated,
  emitRuntimeViewChanged,
  emitStatusChanged,
  resetRuntimeView,
} from "./shared.js";

const VIDEO_READY_TIMEOUT_MS = 15000;
const FIXED_STREAM_URL = DEFAULT_STREAM_URL;
const PLAY_HTML_PLAYER_ONLY_PARAMS = new Set([
  "autoplay",
  "id",
  "is360",
  "mute",
  "playOrder",
  "playType",
  "targetLatency",
]);

function toBrowserPlayableSource(source) {
  const targetUrl = new URL(source);
  const proxyUrl = new URL("/proxy", window.location.href);

  proxyUrl.searchParams.set("url", targetUrl.toString());
  return proxyUrl.toString();
}

function buildPlayHtmlStreamQuery(url) {
  const streamQuery = new URLSearchParams();

  for (const [key, value] of url.searchParams.entries()) {
    if (!PLAY_HTML_PLAYER_ONLY_PARAMS.has(key)) {
      streamQuery.append(key, value);
    }
  }

  const query = streamQuery.toString();
  return query ? `?${query}` : "";
}

function buildPlayHtmlStreamSource(url, streamId, suffix = "") {
  const basePath = url.pathname.split("/").slice(0, -1).join("/");
  const query = buildPlayHtmlStreamQuery(url);

  return `${url.protocol}//${url.host}${basePath}/streams/${streamId}${suffix}.m3u8${query}`;
}

async function sourceExists(source) {
  try {
    const response = await fetch(toBrowserPlayableSource(source), { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveFixedHlsSource() {
  const url = new URL(FIXED_STREAM_URL);
  const streamId = url.searchParams.get("id");

  if (!streamId) {
    throw new Error("The fixed play.html URL is missing ?id=...");
  }

  const adaptiveSource = buildPlayHtmlStreamSource(url, streamId, "_adaptive");

  if (await sourceExists(adaptiveSource)) {
    return adaptiveSource;
  }

  return buildPlayHtmlStreamSource(url, streamId);
}

function destroyHls() {
  if (appState.hls) {
    appState.hls.destroy();
    appState.hls = null;
  }
}

function setViewerMode(mode) {
  appState.streamMode = mode;

  if (els.video) {
    els.video.hidden = mode === "iframe";
    els.video.style.opacity = mode === "hybrid" ? "0" : "1";
    els.video.style.pointerEvents = "none";
  }

  if (els.remoteFrame) {
    els.remoteFrame.hidden = mode === "video";
  }

  const overlaysHidden = mode === "iframe";

  if (els.overlay) {
    els.overlay.hidden = overlaysHidden;
  }

  if (els.roiEditorOverlay) {
    els.roiEditorOverlay.hidden = overlaysHidden;
  }

  if (els.cardsOverlay) {
    els.cardsOverlay.hidden = overlaysHidden;
  }
}

function resetRemoteFrame() {
  if (!els.remoteFrame) {
    return;
  }

  els.remoteFrame.removeAttribute("src");
  els.remoteFrame.src = "about:blank";
}

function resetVideoElement() {
  if (!els.video) {
    return;
  }

  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
}

export function clearStream() {
  destroyHls();

  appState.streamMode = "video";
  appState.streamReady = false;

  setViewerMode("video");
  resetRemoteFrame();
  resetVideoElement();
  resetRuntimeView();

  emitRuntimeViewChanged();
  emitOverlayInvalidated();
}

function waitForVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("loadeddata", handleReady);
      video.removeEventListener("canplay", handleReady);
      video.removeEventListener("playing", handleReady);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const handleReady = () => {
      finish(resolve);
    };

    const handleError = () => {
      finish(() => {
        reject(
          new Error(
            video.error?.message ||
              "The browser could not load this video source",
          ),
        );
      });
    };

    const timeoutId = window.setTimeout(() => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        finish(resolve);
        return;
      }

      finish(() => {
        reject(new Error("Timed out while waiting for the video to become ready"));
      });
    }, VIDEO_READY_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("loadeddata", handleReady, { once: true });
    video.addEventListener("canplay", handleReady, { once: true });
    video.addEventListener("playing", handleReady, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function handleFatalHlsError(hls, data) {
  const details = data?.details || "unknown HLS error";
  const type = data?.type || "";
  const blockedByCors =
    type === "networkError" && /manifest|level|frag/i.test(details);

  emitStatusChanged(
    blockedByCors
      ? "The stream still blocks browser playback. Run it through the local proxy or enable CORS on the video server."
      : `Could not load HLS stream: ${details}`,
  );

  hls.destroy();

  if (appState.hls === hls) {
    appState.hls = null;
  }

  appState.streamReady = false;
}

function attachHlsSource(source) {
  if (!window.Hls?.isSupported()) {
    return false;
  }

  const hls = new window.Hls({
    enableWorker: true,
    lowLatencyMode: true,
    backBufferLength: 30,
  });

  hls.on(window.Hls.Events.ERROR, (_event, data) => {
    if (data?.fatal) {
      handleFatalHlsError(hls, data);
    }
  });

  hls.loadSource(source);
  hls.attachMedia(els.video);
  appState.hls = hls;

  return true;
}

function attachNativeVideoSource(source) {
  els.video.src = source;
  els.video.load();
}

function canPlayNativeHls() {
  return els.video?.canPlayType("application/vnd.apple.mpegurl");
}

async function playVideoIfPossible() {
  try {
    await els.video.play();
    emitStatusChanged("Loaded stream. Detection will start automatically.");
  } catch (error) {
    emitStatusChanged(
      `Loaded stream. Detection will start after playback is ready: ${error.message}`,
    );
  }
}

function waitForFrameLoad(frame) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      frame.removeEventListener("load", handleLoad);
      frame.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const handleLoad = () => {
      finish(resolve);
    };

    const handleError = () => {
      finish(() => {
        reject(new Error("The browser could not load the remote player page"));
      });
    };

    const timeoutId = window.setTimeout(() => {
      finish(() => {
        reject(new Error("Timed out while waiting for the remote player page"));
      });
    }, VIDEO_READY_TIMEOUT_MS);

    frame.addEventListener("load", handleLoad, { once: true });
    frame.addEventListener("error", handleError, { once: true });
    frame.src = FIXED_STREAM_URL;
  });
}

export async function loadStreamFromInput() {
  if (!els.remoteFrame) {
    emitStatusChanged("Direct play.html display is not available in this build.");
    return false;
  }

  if (els.sourceInput) {
    els.sourceInput.value = FIXED_STREAM_URL;
  }

  const resolvedSource = await resolveFixedHlsSource();

  clearStream();
  setViewerMode("hybrid");

  els.video.crossOrigin = "anonymous";
  els.video.muted = true;
  els.video.playsInline = true;

  emitStatusChanged(`Loading stream: ${FIXED_STREAM_URL}`);

  const playableSource = toBrowserPlayableSource(resolvedSource);
  const frameLoadPromise = waitForFrameLoad(els.remoteFrame);

  if (!attachHlsSource(playableSource)) {
    if (canPlayNativeHls()) {
      attachNativeVideoSource(playableSource);
    } else {
      emitStatusChanged(
        "This browser cannot play HLS here. Use Safari or a Chromium browser with hls.js support.",
      );
      return false;
    }
  }

  try {
    await Promise.all([waitForVideoReady(els.video), frameLoadPromise]);
    appState.streamReady = true;
    emitOverlayInvalidated();
    emitRuntimeViewChanged();
    await playVideoIfPossible();
    emitStatusChanged(`Loaded fixed stream: ${FIXED_STREAM_URL}`);
    return true;
  } catch (error) {
    clearStream();
    emitStatusChanged(`Could not load stream: ${error.message}`);
    return false;
  }
}
