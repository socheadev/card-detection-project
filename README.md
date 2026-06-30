# Capture Video Web Preview

## Install

```bash
npm install
```

## Run the browser app

Start the local server:

```bash
npm run serve
```

Open:

`http://localhost:5500/index.html`

Default host and port come from `.env` if set, otherwise:

- `HOST=localhost`
- `PORT=5500`

## Run remote `play.html?id=...` detection

Use this when the stream is loaded from a remote `play.html?id=...` page and frames need to be captured with Puppeteer.

Terminal 1:

```bash
npm run serve
```

Terminal 2:

```bash
npm run detect:puppeteer
```

Optional `.env` values for the detector:

```env
DETECTOR_SOURCE_URL=https://venti.gpc123.com/Aesexy/play.html?id=yangyang
DETECTOR_POST_URL=http://127.0.0.1:5500/detector/results
DETECTOR_INTERVAL_MS=500
DETECTOR_TIMEOUT_MS=30000
DETECTOR_CONFIDENCE=0.25
DETECTOR_IOU=0.70
DETECTOR_VIEWPORT_WIDTH=1280
DETECTOR_VIEWPORT_HEIGHT=720
```

## Run RabbitMQ consumers

AMQP consumer:

```bash
npm run consume:rabbitmq
```

HTTP polling consumer:

```bash
npm run consume:rabbitmq:http
```

These consumers require RabbitMQ-related values in `.env`.
