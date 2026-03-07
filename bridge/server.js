/* eslint-disable */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
/**
 * Bridge server: Express + WebSocket on port 4001.
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
const { parseInstructionDynamically } = require("./instructionParser");

const PORT = 4001;
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
      const first = locator.first();
      await first.scrollIntoViewIfNeeded();
      if (action === "click") await first.click({ timeout, force: true });
      else await first.hover({ timeout, force: true });
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
  const timeout = opts.timeout ?? 8000;
  const name = (targetText || "").trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(escaped, "i");
  const tryScrollAndVisible = async (locator) => {
    try {
      const n = await locator.count();
      if (n === 0) return false;
      const first = locator.first();
      await first.scrollIntoViewIfNeeded();
      return await first.isVisible({ timeout });
    } catch (_) {
      return false;
    }
  };
  if (await tryScrollAndVisible(page.getByRole("link", { name: nameRegex }))) return true;
  if (await tryScrollAndVisible(page.getByRole("button", { name: nameRegex }))) return true;
  if (await tryScrollAndVisible(page.getByRole("menuitem", { name: nameRegex }))) return true;
  if (await tryScrollAndVisible(page.getByText(name, { exact: true }))) return true;
  if (await tryScrollAndVisible(page.getByText(nameRegex))) return true;
  return false;
}

/** Duration (ms) the red highlight stays on the element after interaction. */
const HIGHLIGHT_DURATION_MS = 1800;
/** Pause after applying highlight so the next screenshot frame captures it. */
const HIGHLIGHT_PAUSE_MS = 280;
/** Wait for element to be visible (e.g. inside modal); modals can take time to render. */
const INTERACTION_VISIBLE_TIMEOUT_MS = 12000;
/** Default click/fill timeout; retry with force if visibility fails. */
const INTERACTION_CLICK_TIMEOUT_MS = 8000;

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
 * Waits for the element to be visible and scrolls it into view. Use before click/fill on elements
 * inside modals or late-rendered UI (e.g. "Search gym" in Gym Selector modal).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @param {number} [timeoutMs] - Max wait for visible (default INTERACTION_VISIBLE_TIMEOUT_MS).
 */
async function waitForVisibleAndScroll(page, selector, timeoutMs = INTERACTION_VISIBLE_TIMEOUT_MS) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: timeoutMs });
  await loc.scrollIntoViewIfNeeded();
}

/**
 * Clicks the element; waits for visible, scrolls into view, highlights, then clicks. On "not visible" timeout, retries with force.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @param {{ timeout?: number }} [opts] - Click timeout (default INTERACTION_CLICK_TIMEOUT_MS).
 */
async function clickWithVisibleOrForce(page, selector, opts = {}) {
  const timeout = opts.timeout ?? INTERACTION_CLICK_TIMEOUT_MS;
  await waitForVisibleAndScroll(page, selector);
  await highlightElement(page, selector);
  try {
    await page.click(selector, { timeout });
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/not visible|Timeout.*exceeded|outside of the viewport/i.test(msg)) {
      await page.click(selector, { timeout: 5000, force: true });
    } else {
      throw e;
    }
  }
}

/**
 * Delay (in ms) after filling a typeahead/search field.
 * Many UIs (e.g. Angular typeahead) filter the dropdown asynchronously after input;
 * without this wait, the next step (e.g. "Select X") can run before results appear.
 */
const TYPEAHEAD_SETTLE_MS = 1200;

/**
 * Fills a hidden or off-screen input via JavaScript when Playwright's normal fill would time out
 * (e.g. input inside a modal or typeahead that is in the DOM but not "visible" to Playwright).
 * We set the value and dispatch events so frameworks (e.g. Angular ng-model) and typeaheads
 * react; then we wait TYPEAHEAD_SETTLE_MS so the dropdown can update before the next step.
 *
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector for the input.
 * @param {string} value - Text to set in the input.
 */
async function fillHiddenInput(page, selector, value) {
  await page.locator(selector).first().evaluate((el, v) => {
    if (!el || typeof el.value === "undefined") return;
    el.focus();
    el.value = v;
    // Standard events so the app's listeners (e.g. Angular) see the change
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("keyup", { bubbles: true }));
    // InputEvent with inputType helps some frameworks treat this as real text input
    if (typeof InputEvent !== "undefined") {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
    }
  }, value);
  // Give typeahead time to filter and show results before next step runs
  await new Promise((r) => setTimeout(r, TYPEAHEAD_SETTLE_MS));
}

/**
 * Fills an input: wait until visible, scroll into view, highlight, then fill.
 * If the element is hidden (e.g. "Search gym" in a modal), falls back to fillHiddenInput.
 *
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector for the input.
 * @param {string} value - Text to type.
 * @param {object} [opts] - Options.
 * @param {number} [opts.timeout] - Max wait for element (default 8000).
 * @param {number} [opts.waitAfterMs] - Optional delay after fill (e.g. for typeahead to filter before next step).
 */
async function fillWithVisibleWait(page, selector, value, opts = {}) {
  const timeout = opts.timeout ?? INTERACTION_CLICK_TIMEOUT_MS;
  const waitAfterMs = opts.waitAfterMs ?? 0;
  try {
    await waitForVisibleAndScroll(page, selector);
    await highlightElement(page, selector);
    await page.fill(selector, value, { timeout });
    // For search/typeahead steps, wait so dropdown results load before the next step
    if (waitAfterMs > 0) await new Promise((r) => setTimeout(r, waitAfterMs));
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/hidden|not visible|Timeout.*exceeded/i.test(msg)) {
      await fillHiddenInput(page, selector, value);
    } else {
      throw e;
    }
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
 * Takes a PNG screenshot of the page for report attachment. Returns base64 string or null.
 * @param {import('playwright').Page | null} page - Playwright page.
 * @returns {Promise<string | null>}
 */
async function takeStepScreenshot(page) {
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: "png" });
    return buf.toString("base64");
  } catch (_) {
    return null;
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
      // Handle "Verify X is displayed" steps: check visibility and send step_done with actual success
      // so the frontend can mark the run as failed when verify fails (no false "all steps passed").
      const isVerifyDisplayed = parsedInstruction && parsedInstruction.action === "verify_displayed" && parsedInstruction.target;
      if (isVerifyDisplayed) {
        const verifyTarget = parsedInstruction.target;
        const visible = await isElementWithTextVisible(activePage, verifyTarget, { timeout: 8000 });
        const verifyMsg = visible ? "Step successful." : `"${verifyTarget}" is not displayed.`;
        sendLog(ws, verifyMsg, visible ? "info" : "error", sessionId);
        const stepScreenshot = await takeStepScreenshot(activePage);
        send(ws, "step_done", { success: visible, sessionId, message: visible ? undefined : verifyMsg, screenshot: stepScreenshot });
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
                await clickWithVisibleOrForce(activePage, selector);
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
                await waitForVisibleAndScroll(activePage, selector);
                await highlightElement(activePage, selector);
                await activePage.hover(selector, { timeout: INTERACTION_CLICK_TIMEOUT_MS });
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
              const isPassword =
                /password/.test(String(resolvedTarget || "").toLowerCase()) ||
                /password/.test(String(msg.instruction || "").toLowerCase());
              if (isPassword && resolvedValue) {
                await waitForVisibleAndScroll(activePage, finalSelector);
                await highlightElement(activePage, finalSelector);
                await activePage.locator(finalSelector).focus();
                await activePage.locator(finalSelector).pressSequentially(resolvedValue, { delay: 60 });
              } else {
                // For search-type steps, wait after fill so typeahead dropdown can filter before "Select X"
                const isSearchStep =
                  String(resolvedTarget || "").toLowerCase() === "search" ||
                  /search\s+gym|search\s+for|search\s+club/i.test(String(msg.instruction || ""));
                await fillWithVisibleWait(activePage, finalSelector, resolvedValue, {
                  waitAfterMs: isSearchStep ? TYPEAHEAD_SETTLE_MS : 0,
                });
              }
            } else if (resolvedAction === "press") {
              await waitForVisibleAndScroll(activePage, selector);
              await highlightElement(activePage, selector);
              await activePage.press(selector, msg.key || "Enter");
            }
            lastError = null;
            const stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
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
          send(ws, "step_done", { success: false, sessionId, screenshot: screenshotBase64 });
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
          let stepScreenshot = null;
          if (action === "click" && selector) {
            await clickWithVisibleOrForce(activePage, selector);
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          } else if ((action === "type" || action === "fill") && selector) {
            await fillWithVisibleWait(activePage, selector, msg.text ?? msg.value ?? "");
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          } else if (action === "navigate" && msg.url) {
            await gotoWithAbortHandling(activePage, msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          } else if (action === "press" && selector) {
            await highlightElement(activePage, selector);
            await activePage.press(selector, msg.key || "Enter");
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          } else if (action === "wait") {
            const ms = typeof msg.value === "number" ? msg.value : 1000;
            await new Promise((r) => setTimeout(r, ms));
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          } else {
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
          }
          done = true;
        } catch (e) {
          let screenshotBase64 = null;
          try {
            const buf = await activePage.screenshot({ type: "png" });
            screenshotBase64 = buf.toString("base64");
          } catch (_) {}
          sendLog(ws, `Step failed: ${e.message}`, "error", sessionId);
          send(ws, "step_done", { success: false, sessionId, screenshot: screenshotBase64 });
          send(ws, "error", { sessionId, message: e.message });
          send(ws, "test_error", { sessionId, message: e.message, screenshot: screenshotBase64 });
        }
      } else if (!done) {
        const stepScreenshot = await takeStepScreenshot(activePage);
        sendLog(ws, "Step successful.", "info", sessionId);
        send(ws, "step_done", { success: true, sessionId, screenshot: stepScreenshot });
      }
    } catch (err) {
      let screenshotBase64 = null;
      try {
        const buf = await activePage.screenshot({ type: "png" });
        screenshotBase64 = buf.toString("base64");
      } catch (_) {}
      sendLog(ws, `Step failed: ${err.message}`, "error", sessionId);
      send(ws, "step_done", { success: false, sessionId, screenshot: screenshotBase64 });
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
