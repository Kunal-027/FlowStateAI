# FlowState AI

High-reliability, cloud-native autonomous testing engine. Professional SaaS platform with a minimal, dark-mode, command-centric (Autosana-inspired) UI.

## Stack

- **Framework:** Next.js 15 (App Router), TypeScript, Tailwind CSS
- **UI:** shadcn-style components (Radix), dark theme
- **State:** Zustand (test queue → parsing → cloud execution → self-healing → report)
- **Execution:** Remote Playwright containers only (no local browser)
- **Streaming:** HTML5 Canvas consuming WebSocket frame buffers

## Project structure

```
src/
├── app/
│   ├── api/run-step/     # Placeholder for cloud step execution
│   ├── runner/           # Test Runner layout + page
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── runner/           # Sidebar, Monitor, Console, StreamProvider
│   ├── streaming/        # BrowserStreamCanvas
│   └── ui/               # Button, Badge, ScrollArea
├── hooks/
│   └── useStreamConnection.ts
├── lib/
│   ├── parser/           # JSON → Playwright commands, retry/healing orchestration
│   ├── self-healing/     # Swappable heuristic (default + future AI)
│   └── utils.ts
├── services/
│   ├── cloud/            # Cloud execution service (remote Playwright)
│   └── websocket/        # Stream client for browser frames
├── store/
│   └── useExecutionStore.ts
└── types/
    └── execution.ts
```

## Core behaviour

- **Self-healing:** On step failure, the backend does not immediately return "Failed". A secondary heuristic (fuzzy selector, visual fallback) attempts recovery; only after that is exhausted is the step marked failed.
- **Retry:** Exponential backoff for network-bound steps (configurable in `instructionParser.ts`).
- **Modular heuristic:** Implement `ISelfHealingHeuristic` in `src/lib/self-healing/` and pass it into `executeStepWithHealingAndRetry` to swap for an AI-based strategy later.

## Setup

```bash
npm install
npx playwright install chromium   # for the bridge
```

## Running the app

**Option A – Next.js + Bridge together (one terminal)**

```bash
npm run dev:all
```

**Option B – Two terminals**

```bash
# Terminal 1: Next.js
npm run dev

# Terminal 2: Bridge (WebSocket + Playwright on port 4000)
npm run bridge
```

- App: [http://localhost:3000](http://localhost:3000) (or 3001 if 3000 is in use)
- Test Runner: [http://localhost:3000/runner](http://localhost:3000/runner)
- Bridge: `ws://localhost:4000`

## Troubleshooting

**"Internal server error" / Next.js crashes with `EPERM: operation not permitted, open '.next\trace'`**

- This usually happens when the `.next` folder is locked (e.g. another Next.js process or the IDE).
- **Fix:** Stop all running dev servers (Ctrl+C in every terminal running `npm run dev` or `npm run dev:all`). Close any other app that might be using the project folder. Then delete the `.next` folder (in File Explorer or `rmdir /s /q .next` in cmd, or `Remove-Item -Recurse -Force .next` in PowerShell). Restart with `npm run dev` or `npm run dev:all`.

**"Address already in use :::4000"**

- The bridge is already running (e.g. from a previous `npm run dev:all`). Either use that running bridge, or stop it (Ctrl+C in the terminal that started it) before starting the bridge again.

## Env (optional)

- `NEXT_PUBLIC_WS_STREAM_URL` – WebSocket URL for browser stream (default: `ws://localhost:3001/stream`)
- `NEXT_PUBLIC_EXECUTION_API` – Base URL for cloud execution API (default: `/api`)

## Next steps

1. Implement backend Playwright workers and wire `POST /api/run-step` to them.
2. Run a WebSocket server that emits `frame` messages (e.g. from Playwright screenshots) and point `NEXT_PUBLIC_WS_STREAM_URL` at it.
3. Add test case CRUD and "Run" flow that uses the parser + cloud service + store updates.
4. Optionally replace `DefaultSelfHealingHeuristic` with an AI-driven implementation using `SelfHealingContext` (e.g. LLM + vision).
