import {
  appState,
  els,
  emitOverlayInvalidated,
  emitRuntimeViewChanged,
  emitStatusChanged,
  resetRuntimeView,
} from "./shared.js";

const VIDEO_READY_TIMEOUT_MS = 15000;

function isHttpSource(source) {
  try {
    const url = new URL(source, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isCrossOriginSource(source) {
  try {
    const url = new URL(source, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isProxySource(source) {
  try {
    const url = new URL(source, window.location.href);
    return url.origin === window.location.origin && url.pathname === "/proxy";
  } catch {
    return false;
  }
}

function toBrowserPlayableSource(source) {
  if (!isHttpSource(source) || !isCrossOriginSource(source) || isProxySource(source)) {
    return source;
  }

  const proxyUrl = new URL("/proxy", window.location.href);

  proxyUrl.searchParams.set("url", source);
  return proxyUrl.toString();
}

export function resolvePlayableSource(source) {
  const cleanSource = source?.trim();

  if (!cleanSource) {
    return "";
  }

  try {
    const url = new URL(cleanSource);

    if (url.pathname.toLowerCase().endsWith(".m3u8")) {
      return cleanSource;
    }

    if (url.pathname.toLowerCase().endsWith("/play.html")) {
      const streamId = url.searchParams.get("id");

      if (!streamId) {
        throw new Error("The play.html URL is missing ?id=...");
      }

      const basePath = url.pathname.split("/").slice(0, -1).join("/");

      return `${url.protocol}//${url.host}${basePath}/streams/${streamId}.m3u8`;
    }

    return cleanSource;
  } catch {
    return cleanSource;
  }
}

function sourcePathname(source) {
  try {
    return new URL(source).pathname.toLowerCase();
  } catch {
    return String(source || "").toLowerCase();
  }
}

function isHlsSource(source) {
  return sourcePathname(source).endsWith(".m3u8");
}

function destroyHls() {
  if (appState.hls) {
    appState.hls.destroy();
    appState.hls = null;
  }
}

function revokeFileObjectUrl() {
  if (appState.fileObjectUrl) {
    URL.revokeObjectURL(appState.fileObjectUrl);
    appState.fileObjectUrl = "";
  }
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
  revokeFileObjectUrl();

  appState.streamReady = false;

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

async function playVideoIfPossible(sourceLabel) {
  try {
    await els.video.play();
    emitStatusChanged(`Loaded stream: ${sourceLabel}`);
  } catch (error) {
    emitStatusChanged(
      `Loaded stream. Detection will start when playback resumes: ${error.message}`,
    );
  }
}

export async function loadVideoSource(source, sourceLabel = source) {
  const cleanSource = source?.trim?.() || source;

  if (!cleanSource) {
    emitStatusChanged("Enter a stream URL first");
    return false;
  }

  clearStream();

  els.video.crossOrigin = "anonymous";
  els.video.muted = true;
  els.video.playsInline = true;

  emitStatusChanged(`Loading stream: ${sourceLabel}`);

  const playableSource = toBrowserPlayableSource(cleanSource);

  if (isHlsSource(cleanSource)) {
    const attachedByHlsJs = attachHlsSource(playableSource);

    if (!attachedByHlsJs) {
      if (canPlayNativeHls()) {
        attachNativeVideoSource(playableSource);
      } else {
        emitStatusChanged(
          "This browser cannot play HLS here. Use Safari or a Chromium browser with hls.js support.",
        );
        return false;
      }
    }
  } else {
    attachNativeVideoSource(playableSource);
  }

  try {
    await waitForVideoReady(els.video);
    appState.streamReady = true;
    emitOverlayInvalidated();
    emitRuntimeViewChanged();
    await playVideoIfPossible(sourceLabel);
    return true;
  } catch (error) {
    clearStream();
    emitStatusChanged(`Could not load stream: ${error.message}`);
    return false;
  }
}

export async function loadStreamFromInput() {
  const rawSource = els.sourceInput?.value?.trim() || "";

  if (!rawSource) {
    emitStatusChanged("Enter a stream URL first");
    return false;
  }

  const resolvedSource = resolvePlayableSource(rawSource);

  return loadVideoSource(resolvedSource, rawSource);
}

export function openVideoFilePicker() {
  els.videoFileInput?.click();
}

export async function loadVideoFile(file) {
  if (!file) {
    return false;
  }

  clearStream();

  appState.fileObjectUrl = URL.createObjectURL(file);

  return loadVideoSource(appState.fileObjectUrl, file.name);
}
