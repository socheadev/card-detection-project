# Capture Video Web Preview

Browser app for live card detection with ONNX. Supports:

- local video or HLS inference in the browser
- remote `play.html?id=...` streams via Puppeteer frame capture
- RabbitMQ publish and consume flows

## Start

```bash
npm install
npm run serve
```

Open:

`http://localhost:5500/index.html`

## Main Flows

### Local video or HLS

1. Start `npm run serve`
2. Open `http://localhost:5500/index.html`
3. Load a direct video or `.m3u8` source
4. Start detection

When RabbitMQ is configured in `.env`, broadcast is automatic whenever detection produces a new payload.

### Remote `play.html?id=...`

`play.html` sources are shown in an iframe. Detection frames come from Puppeteer, not from the browser page itself.

Run in two terminals:

```bash
npm run serve
```

```bash
npm run detect:puppeteer
```

The detector captures video frames and posts results to:

`http://localhost:5500/detector/results`

## Broadcast Payload

The current outbound payload is a flat card list:

```json
[
  {
    "suit": "spades",
    "value": 4,
    "number": 1,
    "side": "player"
  },
  {
    "suit": "clubs",
    "value": 13,
    "number": 2,
    "side": "player"
  },
  {
    "suit": "hearts",
    "value": 12,
    "number": 1,
    "side": "banker"
  }
]
```

Value mapping:

- `A` -> `1`
- `2`..`10` -> numeric rank
- `J` -> `11`
- `Q` -> `12`
- `K` -> `13`

Slot mapping:

- `number` -> `1`, `2`, `3`

Side mapping:

- `side` -> `player` or `banker`

Suit mapping:

- `C` -> `clubs`
- `D` -> `diamonds`
- `H` -> `hearts`
- `S` -> `spades`

## RabbitMQ

There are two separate connection styles:

- `RABBITMQ_AMQP_URL` for AMQP or AMQPS consumers
- `RABBITMQ_URL` for RabbitMQ management HTTP API publish and polling

Do not put an `amqp://` or `amqps://` URL into `RABBITMQ_URL`.

### CloudAMQP Consumer

Example `.env`:

```env
HOST=localhost
PORT=5500

RABBITMQ_AMQP_URL=amqps://vyhxfcfd:your_password@mustang-01.rmq.cloudamqp.com/vyhxfcfd
RABBITMQ_HOST=mustang-01.rmq.cloudamqp.com
RABBITMQ_PORT=5671
RABBITMQ_PROTOCOL=amqps
RABBITMQ_USERNAME=vyhxfcfd
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=vyhxfcfd
RABBITMQ_QUEUE=card_detection_queue
```

With this AMQP-only setup, the browser app can also publish through the local server without
setting `RABBITMQ_URL`. RabbitMQ settings are now driven by server-side `.env`, not by UI fields.
When `RABBITMQ_AMQP_URL` is present, `/broadcast/rabbitmq` publishes directly to CloudAMQP over
AMQP instead of using the RabbitMQ management HTTP API.

Run:

```bash
npm run consume:rabbitmq
```

Queue binding:

- Queue: `card_detection_queue`
- Exchange: `amq.direct`
- Binding key: `card.detection`

### HTTP API Publish

Use this only if your RabbitMQ provider exposes a management HTTP API base URL.

Example `.env` values:

```env
RABBITMQ_URL=https://your-management-host
RABBITMQ_USERNAME=your_user
RABBITMQ_PASSWORD=your_password
RABBITMQ_VHOST=your_vhost
RABBITMQ_EXCHANGE=amq.direct
RABBITMQ_ROUTING_KEY=card.detection
```

The app publishes through:

`/broadcast/rabbitmq`

Latest retained local publish payload:

`http://localhost:5500/broadcast/rabbitmq/latest`

### HTTP Consumer Fallback

If AMQP is blocked but the management API works:

```bash
npm run consume:rabbitmq:http
```

Extra env vars:

```env
RABBITMQ_HTTP_POLL_MS=1000
RABBITMQ_HTTP_BATCH_SIZE=1
RABBITMQ_HTTP_ACKMODE=ack_requeue_false
RABBITMQ_HTTP_TRUNCATE=50000
```

`RABBITMQ_HTTP_ACKMODE`:

- `ack_requeue_false`: consume and remove messages
- `ack_requeue_true`: inspect and put messages back
