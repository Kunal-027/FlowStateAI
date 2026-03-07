# Bridge server (port 4000)

WebSocket + Express server that runs a headless Playwright instance and streams screenshots to the frontend.

## Run alongside Next.js

**Option 1 – two terminals**

```bash
# Terminal 1: Next.js
npm run dev

# Terminal 2: Bridge
npm run bridge
```

**Option 2 – one command**

```bash
npm run dev:all
```

This runs both `next dev` and `node bridge/server.js` via `concurrently`.

## Messages

- **Client → Server**
  - `{ "type": "RUN_TEST", "url": "https://..." }` – Launch browser, open URL, start screenshot loop (100ms). Default URL: Google.
  - `{ "type": "step", "action": "click"|"type"|"navigate"|"fill", "selector": "...", "text"|"value"|"url": "..." }` – Run a step on the page.

- **Server → Client**
  - `{ "type": "frame", "data": "<base64 png>", "width": 1280, "height": 720 }` – Screenshot frame.
  - `{ "type": "session_started", "sessionId": "..." }`
  - `{ "type": "error", "message": "..." }`

## Dependencies

Installed in the project root: `express`, `ws`, `playwright`. Run `npm install` once; first run of the bridge will download browser binaries for Playwright.
