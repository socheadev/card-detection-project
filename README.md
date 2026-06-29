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
- The app can also broadcast each detection frame to another system. Enter a receiver URL in
  `Broadcast URL`, then start detection and the browser will automatically `POST` a simplified
  card payload after each inference pass when at least one card is detected.
- For RabbitMQ HTTP API publishing, fill in `RabbitMQ URL`, `Vhost`, `Exchange`, and
  `Routing Key` in the page, and provide `RABBITMQ_USERNAME` and `RABBITMQ_PASSWORD` through
  server env vars. When those values are complete, the app publishes through the local relay at
  `/broadcast/rabbitmq` instead of the generic webhook URL.
- For local verification before RabbitMQ, use
  `http://127.0.0.1:5500/broadcast/local-test` as the `Broadcast URL`.
  The latest received payload is then available at
  `http://127.0.0.1:5500/broadcast/local-test/latest`.
- Cross-origin broadcast targets are relayed through the local server at
  `/broadcast?url=...`, so the receiver does not need browser CORS enabled when you run the app
  through `npm run serve`.
- For Ant Media `play.html?id=...` links, the app auto-loads the source on startup and keeps the
  original remote `play.html` display visible while loading the matching HLS stream underneath it
  for inference, probing `streams/<id>_adaptive.m3u8` first and preserving non-player query
  params such as stream security tokens before falling back to `streams/<id>.m3u8`.
- HLS playlists are rewritten by the proxy so nested playlists, segment URLs, and key URLs
  continue loading through the same origin.
- Direct folder serving with a plain static server still works for local files and for remote
  streams that already send compatible CORS headers, but it cannot fix a CORS-blocked video
  host on its own.

## Broadcast Payload

The outbound request body contains only the simplified detection objects, for example:

```json
{
  "player": [
    {
      "name": "8S",
      "confidence": 0.90323,
      "slot": 1
    },
    {
      "name": "8S",
      "confidence": 0.84896,
      "slot": 2
    }
  ],
  "banker": [
    {
      "name": "4D",
      "confidence": 0.83244,
      "slot": 1
    },
    {
      "name": "JD",
      "confidence": 0.60589,
      "slot": 2
    }
  ]
}
```

## Local Broadcast Test

Use this flow to verify broadcast works locally before pointing at RabbitMQ:

1. Start the app with `npm run serve`.
2. Open `http://127.0.0.1:5500/index.html`.
3. Set `Broadcast URL` to `http://127.0.0.1:5500/broadcast/local-test`.
4. Start detection. Broadcast will start automatically if `Broadcast URL` is filled in.
5. Open `http://127.0.0.1:5500/broadcast/local-test/latest` to inspect the last payload the server received.

The local server also logs each received payload to the terminal running `npm run serve`.

## RabbitMQ Broadcast

Use these values with the RabbitMQ setup you already tested:

1. Put your RabbitMQ credentials in `.env`:

```env
RABBITMQ_URL=https://rabbitmq.sclabproxserver.qzz.io
RABBITMQ_USERNAME=your_user
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=/
RABBITMQ_EXCHANGE=amq.direct
RABBITMQ_ROUTING_KEY=card.detection
```

2. Start the dev server normally:

```bash
npm run serve
```

3. In the page, use:
   `RabbitMQ URL`: `https://rabbitmq.sclabproxserver.qzz.io`
4. `Vhost`: `/`
5. `Exchange`: `amq.direct`
6. `Routing Key`: `card.detection`

Keep the queue bound like this:

1. Queue: `card_detection_queue`
2. Exchange: `amq.direct`
3. Binding key: `card.detection`

When detection runs, the local Node server wraps the payload into RabbitMQ's HTTP API publish
format and sends it to:

`https://rabbitmq.sclabproxserver.qzz.io/api/exchanges/%2F/amq.direct/publish`

## RabbitMQ Realtime Consumer

RabbitMQ UI is not a live message stream. To watch messages in realtime, run a queue consumer:

```bash
npm run consume:rabbitmq
```

The consumer reads these env vars:

```env
RABBITMQ_HOST=rabbitmq.sclabproxserver.qzz.io
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=your_user
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=/
RABBITMQ_QUEUE=card_detection_queue
```

Each incoming message is printed to the terminal as soon as it arrives.
