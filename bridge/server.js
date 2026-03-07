/* eslint-disable */
/**
 * Bridge server: Express + WebSocket on port 4000.
 * Browser is launched once at server startup. Each new client gets a new page in that browser.
 * Closing a client only closes that client's page, not the browser.
 * - On 'RUN_TEST': creates a new page (tab), starts screenshot loop (100ms), emits 'frame' (base64).
 * - On step messages (e.g. click, type): executes them on that client's Playwright page.
 */

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const { findBestSelector } = require("./elementFinder");
const { getAiAction } = require("./aiInterpreter");

/**
 * Dynamically parses a raw step instruction into action/target/value using generic patterns.
 * Used when AI is unavailable so any phrasing (e.g. "Enter X in Y field", "Type X in the email box") works.
 * @param {string} instruction - Raw instruction text.
 * @returns {{ action: string, target?: string, value?: string } | null}
 */
function parseInstructionDynamically(instruction) {
  if (!instruction || typeof instruction !== "string") return null;
  const s = instruction.trim();
  const lower = s.toLowerCase();
  if (!s) return null;

  const fillInMatch = s.match(/^(?:enter|type|put)\s+(.+?)\s+in\s+(?:the\s+)?(.+?)(?:\s+field)?\s*$/i);
  if (fillInMatch) {
    return { action: "fill", value: fillInMatch[1].trim(), target: fillInMatch[2].trim().replace(/\s+field$/i, "").trim() || fillInMatch[2].trim() };
  }
  const fillQuotedMatch = s.match(/^(?:enter|type)\s+(.+?)\s+"([^"]+)"\s*$/i);
  if (fillQuotedMatch) {
    return { action: "fill", target: fillQuotedMatch[1].trim(), value: fillQuotedMatch[2].trim() };
  }
  const fillDashMatch = s.match(/^(?:enter|type)\s+(.+?)\s+-\s+(.+)$/i);
  if (fillDashMatch) {
    return { action: "fill", target: fillDashMatch[1].trim(), value: fillDashMatch[2].trim() };
  }
  if (/^(?:enter|type)\s+\w+/i.test(s)) {
    const fallbackFill = s.match(/^(?:enter|type)\s+(\w+)\s+(.+)$/i);
    if (fallbackFill) {
      const value = fallbackFill[2].trim().replace(/^["']|["']$/g, "").replace(/\\/g, "");
      return { action: "fill", target: fallbackFill[1].trim(), value };
    }
  }
  const fillWithMatch = s.match(/^fill\s+(.+?)\s+with\s+(.+)$/i);
  if (fillWithMatch) {
    return { action: "fill", target: fillWithMatch[1].trim(), value: fillWithMatch[2].trim() };
  }
  if (lower.startsWith("click ")) {
    const afterClick = s.replace(/^click\s+/i, "").trim();
    const onQuoted = afterClick.match(/^on\s+["'](.+?)["']\s*$/);
    if (onQuoted) return { action: "click", target: onQuoted[1].trim() };
    const onWord = afterClick.match(/^on\s+(.+)$/);
    if (onWord) return { action: "click", target: onWord[1].trim() };
    return { action: "click", target: afterClick };
  }
  if (lower.startsWith("hover ")) {
    return { action: "hover", target: s.replace(/^hover\s+/i, "").trim() };
  }
  if (lower.startsWith("navigate ") || lower.startsWith("go to ")) {
    const url = s.replace(/^(?:navigate|go to)\s+/i, "").trim();
    return { action: "navigate", target: url, value: url };
  }
  const verifyQuoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?['"](.+?)['"]\s+is\s+(?:displayed|visible|shown)\s*$/i);
  if (verifyQuoted) return { action: "verify_displayed", target: verifyQuoted[1].trim() };
  const verifyUnquoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?(.+?)\s+is\s+(?:displayed|visible|shown)\s*$/i);
  if (verifyUnquoted) return { action: "verify_displayed", target: verifyUnquoted[1].trim() };
  const checkThat = s.match(/^\s*check\s+that\s+['"]?(.+?)['"]?\s+is\s+(?:displayed|visible|shown)\s*$/i);
  if (checkThat) return { action: "verify_displayed", target: checkThat[1].trim() };
  return null;
}

const PORT = 4000;
const SCREENSHOT_INTERVAL_MS = 100;
const DEFAULT_START_URL = "https://www.google.com";
const MAX_FIND_ATTEMPTS = 3;

/**
 * Try to click or hover by Playwright role/text locators when snapshot doesn't match (e.g. "Admin Control Panel" in a div).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} targetText - Visible text to match (e.g. "Admin Control Panel").
 * @param {'click'|'hover'} action - "click" or "hover".
 * @param {{ timeout?: number }} [opts] - Optional timeout.
 * @returns {Promise<boolean>} True if action succeeded.
 */
async function clickOrHoverByText(page, targetText, action, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  const name = (targetText || "").trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(escaped, "i");
  const tryLocator = async (locator) => {
    try {
      const n = await locator.count();
      if (n === 0) return false;
      if (action === "click") await locator.first().click({ timeout, force: true });
      else await locator.first().hover({ timeout, force: true });
      return true;
    } catch (_) {
      return false;
    }
  };
  if (await tryLocator(page.getByRole("link", { name: nameRegex }))) return true;
  if (await tryLocator(page.getByRole("button", { name: nameRegex }))) return true;
  if (await tryLocator(page.getByRole("menuitem", { name: nameRegex }))) return true;
  if (await tryLocator(page.getByText(name, { exact: true }))) return true;
  if (await tryLocator(page.getByText(nameRegex))) return true;
  return false;
}

/**
 * Check if an element with the given text is visible (for verify_displayed steps).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} targetText - Text to find (e.g. "Admin Control Panel").
 * @param {{ timeout?: number }} [opts] - Optional timeout.
 * @returns {Promise<boolean>} True if the element is visible.
 */
async function isElementWithTextVisible(page, targetText, opts = {}) {
  const timeout = opts.timeout ?? 3000;
  const name = (targetText || "").trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(escaped, "i");
  const tryVisible = async (locator) => {
    try {
      const n = await locator.count();
      if (n === 0) return false;
      return await locator.first().isVisible({ timeout });
    } catch (_) {
      return false;
    }
  };
  if (await tryVisible(page.getByRole("link", { name: nameRegex }))) return true;
  if (await tryVisible(page.getByRole("button", { name: nameRegex }))) return true;
  if (await tryVisible(page.getByRole("menuitem", { name: nameRegex }))) return true;
  if (await tryVisible(page.getByText(name, { exact: true }))) return true;
  if (await tryVisible(page.getByText(nameRegex))) return true;
  return false;
}

/** Duration (ms) the red highlight stays on the element after interaction. */
const HIGHLIGHT_DURATION_MS = 1800;
/** Pause after applying highlight so the next screenshot frame captures it. */
const HIGHLIGHT_PAUSE_MS = 280;

/**
 * Highlights the element matching selector in the page (red outline + box-shadow), then waits so the
 * next screenshot frame shows it (Selenium-style). Highlight auto-removes after durationMs.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector (e.g. [data-fs-id="fs-5"]).
 * @param {number} [durationMs] - How long the highlight stays (default HIGHLIGHT_DURATION_MS).
 */
async function highlightElement(page, selector, durationMs = HIGHLIGHT_DURATION_MS) {
  try {
    await page.evaluate(
      ({ sel, duration }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.style.setProperty("outline", "3px solid #e11");
        el.style.setProperty("outline-offset", "2px");
        el.style.setProperty("box-shadow", "0 0 0 3px rgba(225,17,17,0.4)");
        setTimeout(() => {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow");
        }, duration);
      },
      { sel: selector, duration: durationMs }
    );
    await new Promise((r) => setTimeout(r, HIGHLIGHT_PAUSE_MS));
  } catch (_) {
    // ignore: selector may be invalid or element gone
  }
}

/**
 * Script run inside the browser page to build a DOM snapshot for fuzzy element search and AI interpreter.
 * Queries interactive elements (a, button, input, select, textarea, role=button/link/textbox, [id], [aria-label]),
 * assigns each a data-fs-id, and returns an array of { selector, tagName, id, className, ariaLabel, text, placeholder, role }.
 * @returns {Array<object>} Snapshot entries for elementFinder and getAiAction.
 */
function getDomSnapshotInPage() {
  const results = [];
  let idx = 0;
  const selector =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [role="tab"], [id], [aria-label]';
  const nodes = document.querySelectorAll(selector);
  nodes.forEach((el) => {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "style" || tag === "script" || tag === "link" || tag === "noscript") return;
    const fsId = "fs-" + idx;
    el.setAttribute("data-fs-id", fsId);
    const text = (el.innerText || el.value || "").trim().slice(0, 200);
    const nameAttr = tag === "input" || tag === "select" || tag === "textarea" ? (el.getAttribute("name") || "") : "";
    const typeAttr = tag === "input" ? (el.getAttribute("type") || "text") : "";
    results.push({
      selector: `[data-fs-id="${fsId}"]`,
      tagName: tag,
      id: el.id || "",
      name: nameAttr,
      type: typeAttr,
      className: typeof el.className === "string" ? el.className : "",
      ariaLabel: el.getAttribute("aria-label") || "",
      text,
      placeholder: el.getAttribute("placeholder") || "",
      role: el.getAttribute("role") || "",
    });
    idx++;
  });
  return results;
}

/** Shared browser and context, launched once at startup. */
let sharedBrowser = null;
let sharedContext = null;

/**
 * Launches the Chromium browser and creates a shared context (viewport 1280x720) if not already done.
 * Called before processing RUN_TEST so the first test does not block on cold start.
 */
async function ensureBrowser() {
  if (sharedBrowser) return;
  sharedBrowser = await chromium.launch({ headless: true });
  sharedContext = await sharedBrowser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
}

/**
 * Navigates the page to url. On net::ERR_ABORTED (e.g. redirect replaced the request), waits and
 * polls until the page lands on a real URL, then treats as success.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} url - URL to open.
 * @param {{ waitUntil?: string, timeout?: number }} [opts] - goto options.
 * @returns {Promise<void>}
 */
async function gotoWithAbortHandling(page, url, opts = {}) {
  const { waitUntil = "domcontentloaded", timeout = 60000 } = opts;
  try {
    await page.goto(url, { waitUntil, timeout });
    return;
  } catch (e) {
    if (!e.message || !e.message.includes("ERR_ABORTED")) throw e;
    await new Promise((r) => setTimeout(r, 3000));
    const pollIntervalMs = 500;
    const pollMaxMs = 15000;
    const deadline = Date.now() + pollMaxMs;
    while (Date.now() < deadline) {
      const current = page.url();
      if (current && current !== "about:blank" && (current.startsWith("http://") || current.startsWith("https://")))
        return;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw e;
  }
}

const app = express();
app.use(express.json());

/** Health check for the bridge. */
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "bridge" });
});

/** Catch-all: avoid Express default 500 HTML for unknown routes. */
app.use((req, res, next) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

/** Error handler so unhandled errors return JSON, not HTML. */
app.use((err, req, res, next) => {
  console.error("[bridge] HTTP error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** Task queue: one test at a time. Items: { ws, msg, sessionId }. */
const runTestQueue = [];
/** Current running test: { ws, sessionId, page, screenshotInterval, cleanupFn }. Null when idle. */
let currentRun = null;

/**
 * Sends a JSON message to the WebSocket client. No-op if the socket is not OPEN.
 * @param {WebSocket} ws - The client WebSocket.
 * @param {string} type - Message type (e.g. "frame", "step_done", "log", "session_started").
 * @param {object} [payload={}] - Additional fields to merge into the message (e.g. sessionId, data, message).
 */
function send(ws, type, payload = {}) {
  if (ws.readyState !== 1) return; // OPEN
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch (err) {
    console.error("[bridge] send error:", err.message);
  }
}

/**
 * Sends a log event so the frontend console shows bridge-driven output only (no mock logs).
 * @param {WebSocket} ws - The client WebSocket.
 * @param {string} message - Log line (e.g. "Starting step: click \"Submit\"…", "Navigation complete.").
 * @param {string} [level="info"] - Log level: "info", "warn", or "error".
 * @param {string | null} [sessionId=null] - Optional session id to include in the payload.
 */
function sendLog(ws, message, level = "info", sessionId = null) {
  const payload = { message, level };
  if (sessionId != null) payload.sessionId = sessionId;
  send(ws, "log", payload);
}

/**
 * Clears the current run (calls its cleanup: stop screenshot interval, close page) and processes the next RUN_TEST in the queue.
 * Used when a test ends (test_finished / test_failed), on error, or when a client disconnects.
 */
function finishCurrentAndProcessQueue() {
  if (currentRun) {
    const { cleanupFn } = currentRun;
    if (typeof cleanupFn === "function") cleanupFn();
    currentRun = null;
  }
  processQueue();
}

/**
 * Processes one RUN_TEST from the queue if none is running. Creates a new page, navigates to msg.url (or default),
 * sends session_started then navigation_done after domcontentloaded, and starts the screenshot interval.
 * On navigation or run error, sends test_error and finishes the run so the next test can start.
 */
async function processQueue() {
  if (currentRun || runTestQueue.length === 0) return;

  const item = runTestQueue.shift();
  if (!item || item.ws.readyState !== 1) {
    if (runTestQueue.length > 0) setImmediate(processQueue);
    return;
  }

  const { ws, msg, sessionId } = item;
  let page = null;
  let screenshotInterval = null;

  /** Stops the screenshot interval and closes the page for this RUN_TEST; does not close the shared browser. */
  function cleanup() {
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
    if (page) {
      page.close().catch(() => {});
      page = null;
    }
  }

  currentRun = { ws, sessionId, page: null, screenshotInterval: null, cleanupFn: cleanup };

  try {
    await ensureBrowser();
    if (!sharedContext) {
      send(ws, "error", { message: "Browser context not ready", sessionId });
      finishCurrentAndProcessQueue();
      return;
    }
    page = await sharedContext.newPage();
    if (!page) {
      send(ws, "error", { message: "Failed to create page", sessionId });
      finishCurrentAndProcessQueue();
      return;
    }
    currentRun.page = page;

    send(ws, "session_started", { sessionId });

    const navUrl = msg.url || DEFAULT_START_URL;
    sendLog(ws, `Navigating to ${navUrl}…`, "info", sessionId);
    page = currentRun && currentRun.ws === ws ? currentRun.page : null;
    if (!page) {
      send(ws, "test_error", { sessionId, message: "Page lost before navigation." });
      finishCurrentAndProcessQueue();
      return;
    }
    try {
      await gotoWithAbortHandling(page, navUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (gotoErr) {
      page = currentRun && currentRun.ws === ws ? currentRun.page : null;
      let screenshotBase64 = null;
      if (page) try {
        const buf = await page.screenshot({ type: "png" });
        screenshotBase64 = buf.toString("base64");
      } catch (_) {}
      sendLog(ws, `Navigation failed: ${gotoErr.message}`, "error", sessionId);
      send(ws, "test_error", {
        sessionId,
        message: gotoErr.message,
        screenshot: screenshotBase64,
      });
      finishCurrentAndProcessQueue();
      return;
    }
    page = currentRun && currentRun.ws === ws ? currentRun.page : null;
    if (!page) {
      send(ws, "test_error", { sessionId, message: "Page lost after navigation." });
      finishCurrentAndProcessQueue();
      return;
    }
    sendLog(ws, "Navigation complete.", "info", sessionId);
    send(ws, "navigation_done", { sessionId });

    screenshotInterval = setInterval(async () => {
      const currentPage = currentRun && currentRun.ws === ws ? currentRun.page : null;
      if (!currentPage || ws.readyState !== 1) return;
      try {
        const buffer = await currentPage.screenshot({ type: "png" });
        const base64 = buffer.toString("base64");
        send(ws, "frame", { data: base64, width: 1280, height: 720, sessionId });
      } catch (e) {
        // ignore
      }
    }, SCREENSHOT_INTERVAL_MS);
    currentRun.screenshotInterval = screenshotInterval;
  } catch (err) {
    console.error("[bridge] RUN_TEST error:", err);
    let screenshotBase64 = null;
    if (page) {
      try {
        const buf = await page.screenshot({ type: "png" });
        screenshotBase64 = buf.toString("base64");
      } catch (_) {}
    }
    sendLog(ws, `Error: ${err.message}`, "error", sessionId);
    send(ws, "test_error", { sessionId, message: err.message, screenshot: screenshotBase64 });
    finishCurrentAndProcessQueue();
  }
}

/** Per-connection step queue: process one step at a time; do not start next until step_done or step_error. */
const stepQueues = new Map();

/**
 * Returns the step queue state for the given WebSocket (creates one if missing).
 * @param {WebSocket} ws - The client WebSocket.
 * @returns {{ queue: object[], processing: boolean }} Queue of pending step messages and a processing flag.
 */
function getStepQueue(ws) {
  if (!stepQueues.has(ws)) stepQueues.set(ws, { queue: [], processing: false });
  return stepQueues.get(ws);
}

/**
 * Processes the next step in this connection's queue if not already processing. Runs one step: optionally
 * calls getAiAction for selector resolution, then findBestSelector fallback, then runs the Playwright action
 * and sends step_done or step_error. Schedules the next step via setImmediate when done.
 * @param {WebSocket} ws - The client WebSocket.
 */
function processStepQueue(ws) {
  const state = getStepQueue(ws);
  if (state.processing || state.queue.length === 0) return;
  const msg = state.queue.shift();
  const sessionId = msg.sessionId ?? (currentRun && currentRun.ws === ws ? currentRun.sessionId : null);
  const activePage = currentRun && currentRun.ws === ws ? currentRun.page : null;
  if (!activePage) {
    if (state.queue.length > 0) setImmediate(() => processStepQueue(ws));
    return;
  }
  state.processing = true;
  const action = msg.action || "step";
  const stepLabel = msg.instruction
    ? msg.instruction.slice(0, 60) + (msg.instruction.length > 60 ? "…" : "")
    : msg.target
      ? `${action} "${msg.target}"`
      : msg.url
        ? `${action} ${msg.url}`
        : action;
  sendLog(ws, `Starting step: ${stepLabel}…`, "info", sessionId);

  (async () => {
    let done = false;
    try {
      let selector = msg.selector;
      const target = msg.target;
      const hasInstruction = Boolean(msg.instruction && msg.instruction.trim());
      const parsedInstruction = hasInstruction ? parseInstructionDynamically(msg.instruction) : null;
      const isVerifyDisplayed = parsedInstruction && parsedInstruction.action === "verify_displayed" && parsedInstruction.target;
      if (isVerifyDisplayed) {
        const verifyTarget = parsedInstruction.target;
        const visible = await isElementWithTextVisible(activePage, verifyTarget, { timeout: 5000 });
        sendLog(ws, visible ? "Step successful." : `"${verifyTarget}" is not displayed.`, visible ? "info" : "error", sessionId);
        send(ws, "step_done", { success: visible, sessionId });
        done = true;
      }

      const isDynamic =
        !done &&
        !selector &&
        (target || hasInstruction) &&
        ["click", "fill", "type", "press", "hover", "step"].includes(action);

      if (isDynamic) {
        let lastError = null;
        let resolvedAction = action;
        let resolvedValue = msg.value ?? msg.text ?? "";
        let resolvedTarget = target;
        for (let attempt = 1; attempt <= MAX_FIND_ATTEMPTS; attempt++) {
          try {
            const snapshot = await activePage.evaluate(getDomSnapshotInPage);
            const looksLikeFill = hasInstruction && /enter|type|fill/i.test(msg.instruction) && (/\busername\b|\bpassword\b|\bemail\b|\bsearch\b/i.test(msg.instruction) || /@.*\./.test(msg.instruction));
            if (looksLikeFill) selector = null;
            if (!selector) {
              const parsedFirst = hasInstruction ? parseInstructionDynamically(msg.instruction) : null;
              if (parsedFirst && (parsedFirst.action === "fill" || parsedFirst.action === "type") && (parsedFirst.target || parsedFirst.value)) {
                resolvedAction = parsedFirst.action;
                if (parsedFirst.value != null) resolvedValue = parsedFirst.value;
                if (parsedFirst.target != null) resolvedTarget = parsedFirst.target;
                selector = findBestSelector(snapshot, resolvedTarget || "username", resolvedAction);
              }
              if (!selector && looksLikeFill && hasInstruction) {
                const emailMatch = msg.instruction.match(/[\w.-]+@[\w.-]+\.\w+/);
                const field = /\bpassword\b/i.test(msg.instruction) ? "password" : "username";
                resolvedAction = "fill";
                if (emailMatch) resolvedValue = emailMatch[0];
                resolvedTarget = field;
                selector = findBestSelector(snapshot, field, "fill");
              }
              if (!selector) {
                const intent = hasInstruction ? msg.instruction.trim() : [action, target, msg.value].filter(Boolean).join(" ").trim();
                let aiResult = null;
                try {
                  aiResult = await getAiAction(intent, snapshot);
                } catch (_) {}
                if (aiResult && aiResult.action && aiResult.target) {
                  resolvedAction = aiResult.action;
                  if (aiResult.value != null) resolvedValue = aiResult.value;
                  resolvedTarget = aiResult.target.trim();
                  const aiTarget = resolvedTarget;
                  if (resolvedAction === "fill" || resolvedAction === "type") {
                    const fillTarget = hasInstruction
                      ? (parseInstructionDynamically(msg.instruction)?.target || aiTarget)
                      : aiTarget;
                    selector = findBestSelector(snapshot, fillTarget, resolvedAction);
                  } else if (aiTarget.startsWith("[") || aiTarget.startsWith("#") || aiTarget.startsWith(".") || /^input|^button|^a\s/i.test(aiTarget)) {
                    selector = aiTarget;
                  } else {
                    selector = findBestSelector(snapshot, aiTarget, resolvedAction);
                  }
                }
              }
              if (!selector && hasInstruction) {
                const parsed = parseInstructionDynamically(msg.instruction);
                if (parsed && parsed.action && (parsed.target || parsed.value)) {
                  resolvedAction = parsed.action;
                  if (parsed.value != null) resolvedValue = parsed.value;
                  if (parsed.target != null) resolvedTarget = parsed.target;
                  selector = findBestSelector(snapshot, resolvedTarget, resolvedAction);
                }
              }
              if ((resolvedAction === "fill" || resolvedAction === "type") && hasInstruction) {
                const parsedFill = parseInstructionDynamically(msg.instruction);
                const fillOnlyTarget = parsedFill?.target || resolvedTarget || target;
                const fillSelector = findBestSelector(snapshot, fillOnlyTarget, resolvedAction);
                if (fillSelector) selector = fillSelector;
              }
              if ((resolvedAction === "click" || resolvedAction === "hover") && (resolvedTarget || target)) {
                resolvedTarget = String(resolvedTarget || target).replace(/\s*dropdown\s*$/gi, "").trim() || resolvedTarget || target;
              }
              if (!selector) selector = findBestSelector(snapshot, resolvedTarget || target, resolvedAction);
              if (selector && (resolvedAction === "fill" || resolvedAction === "type")) {
                const idMatch = String(selector).match(/data-fs-id=["']?(fs-\d+)/);
                const entry = snapshot.find(
                  (e) => e.selector === selector || (idMatch && e.selector && e.selector.indexOf(idMatch[1]) !== -1)
                );
                const editableTypes = new Set(["text", "search", "email", "tel", "url", "password", ""]);
                const fillable =
                  entry &&
                  (entry.tagName === "textarea" ||
                    (entry.tagName === "input" && editableTypes.has((entry.type || "").toLowerCase())));
                if (!fillable) {
                  const fallbackTarget = hasInstruction ? (parseInstructionDynamically(msg.instruction)?.target || resolvedTarget) : resolvedTarget;
                  selector = findBestSelector(snapshot, fallbackTarget || target || "username", resolvedAction);
                }
              }
            }
            if (!selector) {
              const textTarget = resolvedTarget || target;
              if ((resolvedAction === "click" || resolvedAction === "hover") && textTarget) {
                const byTextOk = await clickOrHoverByText(activePage, String(textTarget), resolvedAction, { timeout: 5000 });
                if (byTextOk) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  send(ws, "step_done", { success: true, sessionId });
                  done = true;
                  break;
                }
              }
              lastError = new Error(`No element matched "${resolvedTarget || target}" (attempt ${attempt}/${MAX_FIND_ATTEMPTS})`);
              continue;
            }
            if (resolvedAction === "click") {
              try {
                await highlightElement(activePage, selector);
                await activePage.click(selector, { timeout: 5000 });
              } catch (clickErr) {
                const textTarget = resolvedTarget || target;
                if (textTarget && (await clickOrHoverByText(activePage, String(textTarget), "click", { timeout: 5000 }))) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  send(ws, "step_done", { success: true, sessionId });
                  done = true;
                  break;
                }
                throw clickErr;
              }
            } else if (resolvedAction === "hover") {
              try {
                await highlightElement(activePage, selector);
                await activePage.hover(selector, { timeout: 5000 });
              } catch (hoverErr) {
                const textTarget = resolvedTarget || target;
                if (textTarget && (await clickOrHoverByText(activePage, String(textTarget), "hover", { timeout: 5000 }))) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  send(ws, "step_done", { success: true, sessionId });
                  done = true;
                  break;
                }
                throw hoverErr;
              }
            } else if (resolvedAction === "type" || resolvedAction === "fill") {
              let finalSelector = findBestSelector(snapshot, resolvedTarget || "username", "fill");
              if (!finalSelector) finalSelector = findBestSelector(snapshot, "email", "fill");
              if (!finalSelector) finalSelector = selector;
              try {
                const tag = await activePage.locator(finalSelector).evaluate((el) => (el ? (el.tagName || "").toLowerCase() : ""));
                if (tag !== "input" && tag !== "textarea") {
                  finalSelector = findBestSelector(snapshot, "username", "fill") || findBestSelector(snapshot, "email", "fill");
                }
              } catch (_) {}
              if (!finalSelector) throw new Error("No fillable input found for username/email");
              await highlightElement(activePage, finalSelector);
              const isPassword =
                /password/.test(String(resolvedTarget || "").toLowerCase()) ||
                /password/.test(String(msg.instruction || "").toLowerCase());
              if (isPassword && resolvedValue) {
                await activePage.locator(finalSelector).focus();
                await activePage.locator(finalSelector).pressSequentially(resolvedValue, { delay: 60 });
              } else {
                await activePage.fill(finalSelector, resolvedValue);
              }
            } else if (resolvedAction === "press") {
              await highlightElement(activePage, selector);
              await activePage.press(selector, msg.key || "Enter");
            }
            lastError = null;
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
            done = true;
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (!done && lastError) {
          let screenshotBase64 = null;
          try {
            const buf = await activePage.screenshot({ type: "png" });
            screenshotBase64 = buf.toString("base64");
          } catch (_) {}
          sendLog(ws, `Step failed: ${lastError.message}`, "error", sessionId);
          send(ws, "step_done", { success: false, sessionId });
          const errTarget = resolvedTarget ?? target;
          send(ws, "ambiguity_error", {
            sessionId,
            message: lastError.message || `Could not find or interact with "${errTarget}" after ${MAX_FIND_ATTEMPTS} attempts.`,
            target: errTarget,
            screenshot: screenshotBase64,
          });
          send(ws, "test_error", { sessionId, message: lastError.message, screenshot: screenshotBase64 });
        }
      } else if (selector || action === "navigate" || action === "wait") {
        try {
          if (action === "click" && selector) {
            await highlightElement(activePage, selector);
            await activePage.click(selector, { timeout: 5000 });
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          } else if ((action === "type" || action === "fill") && selector) {
            await highlightElement(activePage, selector);
            await activePage.fill(selector, msg.text ?? msg.value ?? "");
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          } else if (action === "navigate" && msg.url) {
            await gotoWithAbortHandling(activePage, msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          } else if (action === "press" && selector) {
            await highlightElement(activePage, selector);
            await activePage.press(selector, msg.key || "Enter");
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          } else if (action === "wait") {
            const ms = typeof msg.value === "number" ? msg.value : 1000;
            await new Promise((r) => setTimeout(r, ms));
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          } else {
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId });
          }
          done = true;
        } catch (e) {
          let screenshotBase64 = null;
          try {
            const buf = await activePage.screenshot({ type: "png" });
            screenshotBase64 = buf.toString("base64");
          } catch (_) {}
          sendLog(ws, `Step failed: ${e.message}`, "error", sessionId);
          send(ws, "step_done", { success: false, sessionId });
          send(ws, "error", { sessionId, message: e.message });
          send(ws, "test_error", { sessionId, message: e.message, screenshot: screenshotBase64 });
        }
      } else if (!done) {
        sendLog(ws, "Step successful.", "info", sessionId);
        send(ws, "step_done", { success: true, sessionId });
      }
    } catch (err) {
      let screenshotBase64 = null;
      try {
        const buf = await activePage.screenshot({ type: "png" });
        screenshotBase64 = buf.toString("base64");
      } catch (_) {}
      sendLog(ws, `Step failed: ${err.message}`, "error", sessionId);
      send(ws, "step_done", { success: false, sessionId });
      send(ws, "test_error", { sessionId, message: err.message, screenshot: screenshotBase64 });
    } finally {
      state.processing = false;
      if (stepQueues.has(ws)) setImmediate(() => processStepQueue(ws));
    }
  })();
}

wss.on("connection", (ws) => {
  let page = null;
  let screenshotInterval = null;
  let mySessionId = null;

  /** Stops the screenshot loop and closes only this connection's page; does not close the shared browser. */
  function cleanup() {
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
    if (page) {
      page.close().catch(() => {});
      page = null;
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = msg.type;
    const sessionId = msg.sessionId ?? mySessionId;

    try {

    if (type === "RUN_TEST") {
      const sid = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      runTestQueue.push({ ws, msg, sessionId: sid });
      processQueue();
      return;
    }

    if (type === "test_finished" || type === "test_failed") {
      if (type === "test_finished") {
        sendLog(ws, "Test run finished.", "info", sessionId);
      }
      if (currentRun && currentRun.ws === ws) {
        finishCurrentAndProcessQueue();
      }
      return;
    }

    if (type === "step") {
      const activePage = currentRun && currentRun.ws === ws ? currentRun.page : null;
      if (activePage) {
        getStepQueue(ws).queue.push(msg);
        processStepQueue(ws);
      } else {
        send(ws, "step_done", { success: false });
      }
      return;
    }
    } catch (err) {
      console.error("[bridge] message error:", err);
      send(ws, "error", { message: err.message || "Internal server error" });
    }
  });

  ws.on("close", () => {
    stepQueues.delete(ws);
    cleanup();
    if (currentRun && currentRun.ws === ws) {
      finishCurrentAndProcessQueue();
    }
    while (runTestQueue.length > 0) {
      const idx = runTestQueue.findIndex((i) => i.ws === ws);
      if (idx === -1) break;
      runTestQueue.splice(idx, 1);
    }
    if (sharedContext) {
      const pages = sharedContext.pages();
      const pageList = Array.isArray(pages) ? pages : [];
      pageList.forEach((p) => p.close().catch(() => {}));
    }
  });

  ws.on("error", () => {
    cleanup();
  });
});

server.listen(PORT, () => {
  console.log(`[bridge] WebSocket server listening on ws://localhost:${PORT}`);
  console.log("[bridge] Browser will start on first test run from app (e.g. localhost:3000).");
});
