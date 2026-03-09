# Bridge server (port 4000)

WebSocket + Express server that runs a headless Playwright instance and streams screenshots to the frontend.

## Step interpretation (dynamic, global)

Steps are interpreted so **any phrasing** works for millions of users—no site-specific or locale-specific config.

1. **LLM first (every step)**  
   For each step we call the LLM with the user instruction + DOM snapshot and get `{ action, target, value }`. Any wording works (e.g. "Click the Companies menu", "Hit the login button", "Put my email in the box"). Set `HUGGINGFACE_API_KEY` or `ANTHROPIC_API_KEY` in `.env`.

2. **Static parser fallback only when LLM returns nothing**  
   When the LLM is unavailable (no key, or API failed), `instructionParser.js` parses using **structure only** (verb + arguments):
   - Fill: "Enter X in Y", "Fill Y with X", "Search [for] &lt;field&gt; &lt;value&gt;", "Type X - Y", etc.
   - Click / hover: "Click [on] target", "Hover over X".
   - Navigate: "Go to URL", "Navigate to URL".
   - Verify: "Verify 'text' is displayed".
   - No hardcoded app or site names—only verb patterns.

3. **Fuzzy element matching**  
   `elementFinder.js` scores elements by **query + words**: e.g. "search gym" produces variants `["search gym", "search", "gym"]`, so a placeholder "Search gym" matches without adding app-specific aliases. A small set of global aliases (e.g. login/sign in, submit) is used for common terms only.

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
