# Capture Video Web Preview

`apps/web_preview/` is a standalone browser project for running ONNX card detection directly
in the browser on top of a live stream or video.

## Local Setup

```bash
cd apps/web_preview
npm install
```

This installs `hls.js` and `onnxruntime-web` locally and copies the browser runtime files
into `vendor/`.

## Run

Serve this folder with any static server, for example VS Code Live Server, and open:

`http://127.0.0.1:5500/index.html`

## Notes

- Direct folder serving uses `model/best.onnx` from this project.
- The repo-root local build chunks the ONNX model into `.output/dist-preview/` for the shared
  local server flow.
- Remote video streams still need compatible CORS headers so the browser can read video
  pixels for inference.
