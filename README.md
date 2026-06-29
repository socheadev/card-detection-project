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

This project uses two different RabbitMQ connection styles:

- `RABBITMQ_AMQP_URL`: for direct AMQP or AMQPS consumption with `npm run consume:rabbitmq`
- `RABBITMQ_URL`: for RabbitMQ management HTTP API publish or polling flows

Do not put an `amqp://` or `amqps://` URL into `RABBITMQ_URL`.

### CloudAMQP AMQP Consumer

If you have CloudAMQP connection details like:

- host: `mustang.rmq.cloudamqp.com`
- vhost: `vyhxfcfd`
- port: `5671`
- URL: `amqps://vyhxfcfd:...@mustang.rmq.cloudamqp.com/vyhxfcfd`

then put these values in `.env`:

```env
RABBITMQ_AMQP_URL=amqps://vyhxfcfd:your_password@mustang.rmq.cloudamqp.com/vyhxfcfd
RABBITMQ_HOST=mustang.rmq.cloudamqp.com
RABBITMQ_PORT=5671
RABBITMQ_PROTOCOL=amqps
RABBITMQ_USERNAME=vyhxfcfd
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=vyhxfcfd
RABBITMQ_QUEUE=card_detection_queue
```

Then run:

```bash
npm run consume:rabbitmq
```

If the queue is not declared yet in that CloudAMQP vhost, create or bind:

1. Queue: `card_detection_queue`
2. Exchange: `amq.direct`
3. Binding key: `card.detection`

### RabbitMQ Broadcast via HTTP API

Use this only when your RabbitMQ provider exposes a management HTTP API base URL.

1. Put your RabbitMQ HTTP API credentials in `.env`:

```env
RABBITMQ_URL=https://your-management-host
RABBITMQ_USERNAME=your_user
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=your_vhost
RABBITMQ_EXCHANGE=amq.direct
RABBITMQ_ROUTING_KEY=card.detection
```

2. Start the dev server normally:

```bash
npm run serve
```

3. In the page, use:
   `RabbitMQ URL`: your HTTP management base URL, for example `https://your-management-host`
4. `Vhost`: your RabbitMQ vhost, for example `vyhxfcfd`
5. `Exchange`: `amq.direct`
6. `Routing Key`: `card.detection`

Keep the queue bound like this:

1. Queue: `card_detection_queue`
2. Exchange: `amq.direct`
3. Binding key: `card.detection`

When detection runs, the local Node server wraps the payload into RabbitMQ's HTTP API publish
format and sends it to:

`https://your-management-host/api/exchanges/{vhost}/amq.direct/publish`

## RabbitMQ Realtime Consumer

RabbitMQ UI is not a live message stream. To watch messages in realtime, run a queue consumer:

```bash
npm run consume:rabbitmq
```

The consumer reads these env vars:

```env
RABBITMQ_AMQP_URL=amqps://vyhxfcfd:your_password@mustang.rmq.cloudamqp.com/vyhxfcfd
RABBITMQ_HOST=mustang.rmq.cloudamqp.com
RABBITMQ_PORT=5671
RABBITMQ_PROTOCOL=amqps
RABBITMQ_USERNAME=vyhxfcfd
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=vyhxfcfd
RABBITMQ_QUEUE=card_detection_queue
```

`RABBITMQ_AMQP_URL` is preferred when your provider gives you a dedicated AMQP or AMQPS
endpoint. Use the `HOST`/`PORT`/`USERNAME`/`PASSWORD` fields only when the broker really
accepts raw AMQP on that host and port.

Each incoming message is printed to the terminal as soon as it arrives.

## RabbitMQ HTTP Consumer Fallback

If the broker's AMQP port is not reachable from your machine but the HTTPS management API works,
use the HTTP polling consumer instead:

```bash
npm run consume:rabbitmq:http
```

The HTTP consumer reads these env vars:

```env
RABBITMQ_URL=https://your-management-host
RABBITMQ_USERNAME=your_user
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=your_vhost
RABBITMQ_QUEUE=card_detection_queue
RABBITMQ_HTTP_POLL_MS=1000
RABBITMQ_HTTP_BATCH_SIZE=1
RABBITMQ_HTTP_ACKMODE=ack_requeue_false
RABBITMQ_HTTP_TRUNCATE=50000
```

`RABBITMQ_HTTP_ACKMODE` controls whether fetched messages stay in the queue:

- `ack_requeue_false`: consume and remove messages
- `ack_requeue_true`: inspect messages and put them back in the queue

This fallback uses RabbitMQ's management HTTP API `POST /api/queues/{vhost}/{name}/get`, so it
is suitable for debugging and low-volume polling rather than high-throughput consumers.
