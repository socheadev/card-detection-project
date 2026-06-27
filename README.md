# Capture Video Web Preview

`apps/web_preview/` is a standalone browser project for running ONNX card detection directly
in the browser on top of a live stream or video.

## Local Setup

```bash
npm install
npm run serve
```

This installs `hls.js` and `onnxruntime-web` locally and copies the browser runtime files
into `vendor/`, then starts a local server with a built-in stream proxy.

## Run

Open:

`http://127.0.0.1:5500/index.html`

## Notes

- The local Node server also exposes `/proxy?url=...` and the app automatically routes
  cross-origin stream URLs through it so browser inference can read HLS segments and video
  frames.
- HLS playlists are rewritten by the proxy so nested playlists, segment URLs, and key URLs
  continue loading through the same origin.
- Direct folder serving with a plain static server still works for local files and for remote
  streams that already send compatible CORS headers, but it cannot fix a CORS-blocked video
  host on its own.
