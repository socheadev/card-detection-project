# Capture Video Web Preview

`apps/web_preview/` is a standalone browser project for running ONNX card detection directly
in the browser on top of a live stream or video.

## Local Setup

```bash
npm install
npm run serve
```

This installs `hls.js` and `onnxruntime-web` locally, copies the browser runtime files
into `vendor/`, and starts the local server the app expects.

## Run

Open:

`http://127.0.0.1:5500/index.html`

## Notes

- Use `npm run serve` for local development. Plain static servers such as Python
  `http.server` or misconfigured Live Server setups can serve ONNX `.mjs` runtime files
  with the wrong MIME type and cause `initWasm()` backend startup failures.
- The local Node server also exposes `/proxy?url=...` and the app automatically routes
  cross-origin stream URLs through it so browser inference can read HLS segments and video
  frames.
- For Ant Media `play.html?id=...` links, `Load Stream` displays the original remote `play.html`
  page directly.
- `Start Detect` keeps that original display visible and loads the matching HLS stream underneath
  it for inference, probing `streams/<id>_adaptive.m3u8` first and preserving non-player query
  params such as stream security tokens before falling back to `streams/<id>.m3u8`.
- HLS playlists are rewritten by the proxy so nested playlists, segment URLs, and key URLs
  continue loading through the same origin.
- Direct folder serving with a plain static server still works for local files and for remote
  streams that already send compatible CORS headers, but it cannot fix a CORS-blocked video
  host on its own.
