/* eslint-disable */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
/**
 * Bridge server: Express + WebSocket (default port 4000; set PORT in env to override).
 * Browser is launched once at server startup. Each new client gets a new page in that browser.
 * Closing a client only closes that client's page, not the browser.
 * - On 'RUN_TEST': creates a new page (tab), starts screenshot loop (100ms), emits 'frame' (base64).
 * - On step messages (e.g. click, type): executes them on that client's Playwright page.
 */

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const { findBestSelector, findBestSelectorWithScore, getTypoCorrectedTarget } = require("./elementFinder");
const { getAiAction } = require("./aiInterpreter");
const { parseInstructionDynamically, getCompiledActionSchema } = require("./instructionParser");
const { getSelectorFromDom, getSelectorFromA11yAndImage, getCachedSelector, setCachedSelector, snapshotToA11yLines } = require("./selectorHealing");
const { domSanitizer, getInteractiveSubtreeInPage } = require("./domSanitizer");
const { getVisualClickCoordinates, getVisualDiscoveryResult } = require("./visualFallback");
const { runSemanticLocatorFlow, validateAfterClick } = require("./semanticLocatorEngine");

const PORT = parseInt(process.env.PORT || "4000", 10);
const SCREENSHOT_INTERVAL_MS = 100;
const DEFAULT_START_URL = "https://www.google.com";
const MAX_FIND_ATTEMPTS = 3;

/**
 * LLM fallback: use getAiAction to resolve intent to { action, target }, then try findBestSelector + click or clickOrHoverByText.
 * Uses HUGGINGFACE_API_KEY / ANTHROPIC_API_KEY from env. Returns true if the suggested action succeeded.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {unknown[]} snapshot - DOM snapshot from getDomSnapshotInPage.
 * @param {string} intent - User step instruction (e.g. "Click on Companies Menu").
 * @param {'click'|'hover'} action - "click" or "hover".
 * @returns {Promise<boolean>} True if LLM suggested a target and we successfully performed the action.
 */
async function tryLlmFallbackClickOrHover(page, snapshot, intent, action) {
  let aiResult = null;
  try {
    aiResult = await getAiAction(intent, snapshot);
  } catch (_) {
    return false;
  }
  if (!aiResult || !aiResult.target || (aiResult.action !== "click" && aiResult.action !== "hover")) return false;
  const aiTarget = String(aiResult.target).trim();
  if (!aiTarget) return false;
  const act = aiResult.action === "hover" ? "hover" : "click";
  let selector = findBestSelector(snapshot, aiTarget, act);
  if (selector) {
    try {
      if (act === "click") {
        await clickWithVisibleOrForce(page, selector);
        return true;
      }
      await waitForVisibleAndScroll(page, selector);
      await highlightElement(page, selector);
      await page.hover(selector, { timeout: INTERACTION_CLICK_TIMEOUT_MS });
      return true;
    } catch (_) {
      // selector failed; try by text
    }
  }
  return await clickOrHoverByText(page, aiTarget, act, { timeout: 5000 });
}

/** Locate-First: standard Playwright locators only, no AI. Must complete in <200ms so basic steps take <1s. */
const LOCATE_FIRST_TIMEOUT_MS = 200;
/** SuccessMap try: use saved selector immediately; same 200ms budget so we never burn tokens on known steps. */
const SUCCESS_MAP_TRY_TIMEOUT_MS = 200;
/** Use Claude / Claude Visual as soon as fast paths fail (0 = no delay; LLM key = solve at earliest). */
const AI_FALLBACK_DELAY_MS = 0;
/** Timeout for by-text and other fallbacks after locate-first (still no AI). */
const FAST_PATH_LOCATOR_TIMEOUT_MS = 3000;
/** Verify steps: retry interval and total wait for element to appear (up to 10s for redirects/slow logins). */
const VERIFY_RETRY_TOTAL_MS = 10000;
const VERIFY_RETRY_INTERVAL_MS = 1000;
/** Max wait for element visibility / DOM stability before treating as not found (never fail immediately). */
const ELEMENT_WAIT_MAX_MS = 10000;
/** After search/dropdown type: wait for DOM to update (suggestions) before next action. */
const SEARCH_TYPE_WAIT_MS = 450;
/** After "Click Login" (or similar), wait for navigation up to this long. */
const LOGIN_NAV_WAIT_MS = 10000;
/** Introspection map cache TTL (avoid re-scanning DOM every sub-step). Use Claude only when match < this. */
const INTROSPECTION_CACHE_TTL_MS = 60000;
const INTROSPECTION_90_MATCH_THRESHOLD = 0.9;
/** Max length of actualPageContent to send to report (chars). */
const MAX_ACTUAL_PAGE_CONTENT_CHARS = 4000;
/** Max length of visible-text snippet for verify_displayed failure "actual" message. */
const VERIFY_ACTUAL_SNIPPET_CHARS = 600;

/**
 * Get a short snippet of visible text from the page (for verify_displayed failure messages).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {number} maxChars - Max characters to return.
 * @returns {Promise<string>} Snippet of visible text or empty string.
 */
async function getVisibleTextSnippet(page, maxChars = VERIFY_ACTUAL_SNIPPET_CHARS) {
  try {
    const text = await page.evaluate((limit) => {
      const t = document.body ? (document.body.innerText || "").trim() : "";
      return t.slice(0, limit).replace(/\s+/g, " ");
    }, maxChars);
    return (text || "").slice(0, maxChars);
  } catch (_) {
    return "";
  }
}

/** Introspection map cache: key = page.url(), value = { map, timestamp }. TTL 60s. */
const introspectionCache = new Map();

/**
 * Page introspection layer: interactive elements and their semantic labels. Cached 60s per URL.
 * @param {import('playwright').Page} page - Playwright page.
 * @returns {Promise<object[]>} Snapshot entries (selector, tagName, text, ariaLabel, placeholder, etc.).
 */
async function getIntrospectionMap(page) {
  if (!page) return [];
  let url;
  try {
    url = page.url();
  } catch (_) {
    return [];
  }
  const now = Date.now();
  const cached = introspectionCache.get(url);
  if (cached && now - cached.timestamp < INTROSPECTION_CACHE_TTL_MS) {
    return cached.map;
  }
  try {
    const map = await page.evaluate(getDomSnapshotInPage);
    introspectionCache.set(url, { map: map || [], timestamp: now });
    return map || [];
  } catch (_) {
    return [];
  }
}

/**
 * Fuzzy intent matching against the introspection map. Returns best match and reasoning.
 * Use Claude only when normalizedScore < INTROSPECTION_90_MATCH_THRESHOLD.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} intent - User intent (e.g. "Log in", "username").
 * @param {string} action - "click" | "hover" | "fill" | "type".
 * @returns {Promise<{ selector: string | null, normalizedScore: number, reasoning: string }>}
 */
async function matchIntentWithIntrospection(page, intent, action) {
  const map = await getIntrospectionMap(page);
  if (!map.length) return { selector: null, normalizedScore: 0, reasoning: "Introspection map empty." };
  return findBestSelectorWithScore(map, intent.trim(), action);
}

/**
 * Wait-for-success / stability loop: wait until DOM stabilizes (network idle or URL change) before next step.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {{ timeout?: number, urlBefore?: string }} [opts] - timeout and optional URL before action (to detect change).
 */
async function waitForStability(page, opts = {}) {
  const { timeout = LOGIN_NAV_WAIT_MS, urlBefore = null } = opts;
  try {
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  } catch (_) {}
  if (urlBefore) {
    try {
      await page.waitForURL((u) => u !== urlBefore, { timeout: Math.min(5000, timeout) }).catch(() => {});
    } catch (_) {}
  }
}

/** Pre-flight timeout: wait for network idle and optional element stability (up to 10s for redirects/slow logins). */
const PREFLIGHT_NETWORK_MS = 10000;
const PREFLIGHT_ELEMENT_STABLE_MS = 2500;
/** When waiting for a known selector (post speed-layer), wait up to ELEMENT_WAIT_MAX_MS before failing. */
const PREFLIGHT_ELEMENT_WAIT_MS = ELEMENT_WAIT_MAX_MS;

/**
 * Pre-flight check: ensure page has finished loading (network idle) and optionally that the target element is stable (visible, not moving/hidden by loader).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {{ selector?: string }} [opts] - optional selector to wait for visibility/stable.
 */
async function runPreFlightCheck(page, opts = {}) {
  try {
    await page.waitForLoadState("networkidle", { timeout: PREFLIGHT_NETWORK_MS }).catch(() => {});
  } catch (_) {}
  const { selector, timeoutMs } = opts;
  const elementTimeout = timeoutMs ?? (selector ? PREFLIGHT_ELEMENT_WAIT_MS : PREFLIGHT_ELEMENT_STABLE_MS);
  if (selector) {
    try {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "visible", timeout: elementTimeout });
      await new Promise((r) => setTimeout(r, 300));
    } catch (_) {
      throw new Error("Pre-flight: target element not stable or not visible.");
    }
  }
}

/**
 * Locate-First: find element using ONLY standard Playwright locators (getByLabel, getByPlaceholder, getByRole, common CSS).
 * No snapshot, no AI. Must complete within timeoutMs so basic steps take <1s. Returns true if action succeeded.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {{ action: string, target?: string, value?: string }} opts - action and optional target/value.
 * @param {number} timeoutMs - Max time for the whole phase (e.g. 200ms).
 * @param {{ ws: import('ws').WebSocket, sessionId: string | null }} [frameCtx] - If provided, send a frame after highlight so UI shows it.
 */
async function tryLocateFirstOnly(page, opts, timeoutMs, frameCtx = null) {
  const { action, target = "", value = "" } = opts;
  const t = timeoutMs;
  const sendHighlightFrame = frameCtx && frameCtx.ws && frameCtx.ws.readyState === 1
    ? () => sendFrameNow(frameCtx.ws, page, frameCtx.sessionId)
    : () => {};
  const tryClick = async (loc) => {
    try {
      await loc.first().waitFor({ state: "visible", timeout: Math.min(80, t) });
      await highlightLocator(page, loc);
      await sendHighlightFrame();
      await loc.first().click({ timeout: Math.min(80, t) });
      return true;
    } catch (e) {
      if (isPageScriptError(e)) {
        try {
          await loc.first().click({ timeout: 2000, force: true });
          return true;
        } catch (_) {}
      }
      return false;
    }
  };
  const tryFill = async (loc, val) => {
    try {
      await loc.first().waitFor({ state: "visible", timeout: Math.min(80, t) });
      await highlightLocator(page, loc);
      await sendHighlightFrame();
      await loc.first().fill(val, { timeout: Math.min(80, t) });
      return true;
    } catch (_) {
      return false;
    }
  };
  if (action === "fill" || action === "type") {
    const field = (target || "").toLowerCase().replace(/\s+field$/i, "");
    const val = String(value || "").trim();
    if (!val && field !== "search") return false;
    const isSearch = /^search$/i.test(field) || /search/i.test(target || "");
    if (isSearch) {
      if (await tryFill(page.getByPlaceholder(/search/i), val)) return true;
      if (await tryFill(page.getByRole("searchbox"), val)) return true;
      try {
        const inp = page.locator('input[type="search"]').first();
        if ((await inp.count()) > 0 && (await tryFill(inp, val))) return true;
      } catch (_) {}
      return false;
    }
    if (/^(username|user|email|password|pass)$/i.test(field)) {
      try {
        if (await tryFill(page.getByLabel(new RegExp(field.replace(/e-?mail/, "email"), "i")), val)) return true;
      } catch (_) {}
      try {
        if (await tryFill(page.getByPlaceholder(new RegExp(field.replace(/e-?mail/, "e?mail"), "i")), val)) return true;
      } catch (_) {}
      if (/password/i.test(field)) {
        try {
          const p = page.locator('input[type="password"]').first();
          if ((await p.count()) > 0 && (await tryFill(p, val))) return true;
        } catch (_) {}
      } else {
        try {
          const u = page.locator('input[type="email"]').or(page.locator('input[name*="user"]')).or(page.locator('input[name*="email"]')).or(page.locator('input[autocomplete*="username"]')).first();
          if ((await u.count()) > 0 && (await tryFill(u, val))) return true;
        } catch (_) {}
      }
      return false;
    }
    return false;
  }
  if (action === "click" || action === "step") {
    const nameRe = new RegExp((target || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    try {
      if (await tryClick(page.getByRole("button", { name: nameRe }))) return true;
    } catch (_) {}
    try {
      const sub = page.locator('input[type="submit"]').first();
      if ((await sub.count()) > 0 && (await tryClick(sub))) return true;
    } catch (_) {}
    try {
      if (await tryClick(page.getByRole("link", { name: nameRe }))) return true;
    } catch (_) {}
    try {
      if (await tryClick(page.getByText(nameRe))) return true;
    } catch (_) {}
    return false;
  }
  return false;
}

/** Heuristic: use Sonnet for complex instructions (long, multiple targets); Haiku for simple selector repair (token economy). */
function isComplexHealingInstruction(instruction) {
  if (!instruction || instruction.length > 60) return true;
  if (/\b(and|or)\b/i.test(instruction)) return true;
  if (/\d+\./.test(instruction)) return true;
  return false;
}

/**
 * AI-driven healing: try cached selector, then send sanitized Accessibility Tree + screenshot to Claude.
 * Uses Haiku for simple repairs, Sonnet for complex reasoning. Updates SuccessMap on success.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} instruction - Step instruction (e.g. "Click on Companies Menu").
 * @param {string} action - "click" | "hover" | "fill".
 * @param {string} target - Resolved target text.
 * @returns {Promise<{ success: boolean; selector?: string; healed?: boolean; expectedElement?: string; actualPageContent?: string }>}
 */
async function findAndRetry(page, instruction, action, target) {
  const pageUrl = page.url();
  const cached = getCachedSelector(instruction, action, pageUrl);
  if (cached) {
    try {
      const count = await page.locator(cached).count();
      if (count > 0) {
        return { success: true, selector: cached, healed: true };
      }
    } catch (_) {
      // cache miss or stale
    }
  }
  let snapshot = [];
  try {
    snapshot = await page.evaluate(getDomSnapshotInPage);
  } catch (_) {}
  const a11ySnippet = snapshotToA11yLines(snapshot);
  let screenshotBase64 = "";
  try {
    screenshotBase64 = await page.screenshot({ encoding: "base64", type: "png" });
  } catch (_) {}
  const useComplexModel = isComplexHealingInstruction(instruction);
  const aiResult = await getSelectorFromA11yAndImage(instruction, a11ySnippet, screenshotBase64, { useComplexModel });
  if (aiResult && aiResult.selector) {
    try {
      const count = await page.locator(aiResult.selector).count();
      if (count > 0) {
        setCachedSelector(instruction, action, pageUrl, aiResult.selector);
        return { success: true, selector: aiResult.selector, healed: true };
      }
    } catch (_) {
      // selector invalid
    }
  }
  const fallbackHtml = (await page.evaluate(getInteractiveSubtreeInPage).catch(() => ({ html: "" }))).html || "";
  return {
    success: false,
    expectedElement: instruction || target || action,
    actualPageContent: domSanitizer(fallbackHtml).slice(0, MAX_ACTUAL_PAGE_CONTENT_CHARS),
  };
}

/**
 * Try to click or hover by Playwright role/text locators when snapshot doesn't match (e.g. "Admin Control Panel" in a div).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} targetText - Visible text to match (e.g. "Admin Control Panel").
 * @param {'click'|'hover'} action - "click" or "hover".
 * @param {{ timeout?: number }} [opts] - Optional timeout.
 * @returns {Promise<boolean>} True if action succeeded.
 */
/**
 * Heuristic: is this click likely for a gym from a filtered list (Gym Selector)?
 * If true, we should wait for the list item to appear before clicking.
 */
function isGymListSelectionTarget(targetText, instruction) {
  if (!targetText || typeof targetText !== "string") return false;
  const t = targetText.trim();
  const instr = (instruction || "").trim().toLowerCase();
  if (/gym\s+selector|select\s+gym/i.test(instr)) return true;
  if (instr.includes("gym") && (t.includes(".membr.com") || t.includes("dev.au."))) return true;
  if (t.includes(".membr.com") && /click\s+gym|select\s+gym/i.test(instr)) return true;
  return false;
}

/**
 * Wait for a selector dialog (role=dialog) to be visible. Use before list-item click so we don't click the same text on the main page.
 * @returns {Promise<boolean>} True if a dialog is visible within timeout.
 */
async function waitForSelectorDialog(page, timeoutMs = 4000) {
  try {
    await page.getByRole("dialog").first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Wait for a dynamically filtered list item to appear (e.g. Gym Selector: fill search → list updates → click result).
 * Call before clicking when the target is a gym name from a searchable list.
 */
async function waitForGymListResult(page, targetText, timeoutMs = 6000) {
  const name = (targetText || "").trim();
  if (!name) return;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(escaped, "i");
  try {
    await page.getByText(nameRegex).first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (_) {
    // optional: list may not have filtered yet or target not in list
  }
}

/**
 * Normalize gym list target: "Gym ddmsaustralia.dev.au.membr.com left side panel" → "ddmsaustralia.dev.au.membr.com"
 * so we match the list row text.
 */
function normalizeGymListTarget(targetText) {
  let t = (targetText || "").trim();
  t = t.replace(/^gym\s+/i, "").replace(/\s+(?:left|right)\s+side\s+panel$/i, "").trim();
  return t || targetText;
}

/**
 * Click the list row for a gym in the Gym Selector modal (not the radio button).
 * Scopes to the dialog and prefers link/listitem/clickable row so we don't hit the radio and get a page script error.
 */
async function clickGymListItem(page, targetText, timeoutMs = 5000) {
  const name = normalizeGymListTarget(targetText);
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(escaped, "i");
  const tryClick = async (locator) => {
    try {
      const n = await locator.count();
      if (n === 0) return false;
      const el = locator.first();
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: timeoutMs, force: true });
      return true;
    } catch (_) {
      return false;
    }
  };
  const dialog = page.getByRole("dialog");
  const hasDialog = (await dialog.count()) > 0;
  const scope = hasDialog ? dialog : page;
  // Prefer link or interactive row (list result with ">"), not the radio button
  if (await tryClick(scope.getByRole("link", { name: nameRegex }))) return true;
  if (await tryClick(scope.getByRole("menuitem", { name: nameRegex }))) return true;
  if (await tryClick(scope.getByRole("button", { name: nameRegex }))) return true;
  // Clickable row: a, [role=link], etc. that contains the gym name (avoids input/radio)
  try {
    const row = scope.locator("a, [role=link], [role=button], [role=menuitem]").filter({ hasText: nameRegex }).first();
    if ((await row.count()) > 0) {
      await row.scrollIntoViewIfNeeded();
      await row.click({ timeout: timeoutMs, force: true });
      return true;
    }
  } catch (_) {}

  // List row may be a div with ng-click etc.: skip radio label (first match), click second match or clickable ancestor
  try {
    const allWithText = scope.getByText(nameRegex);
    const count = await allWithText.count();
    for (let i = 0; i < count; i++) {
      const el = allWithText.nth(i);
      const isInsideRadioOrLabel = await el.evaluate((node) => {
        let p = node.parentElement;
        while (p && p !== document.body) {
          if (p.tagName === "LABEL" || p.getAttribute("role") === "radio" || p.tagName === "INPUT") return true;
          p = p.parentElement;
        }
        return false;
      }).catch(() => true);
      if (isInsideRadioOrLabel) continue;
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: timeoutMs, force: true });
      return true;
    }
  } catch (_) {}
  return false;
}

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
      await highlightLocator(page, first);
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
  // "Click on any Nike shoes": product titles are "Nike Men's Air Max Excee Shoes" — match Word1.*Word2
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const escapedWords = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const flexibleRegex = new RegExp(escapedWords.join(".*"), "i");
    if (await tryLocator(page.getByRole("link", { name: flexibleRegex }))) return true;
    if (await tryLocator(page.getByText(flexibleRegex))) return true;
  }
  return false;
}

/**
 * Check if an element with the given text is visible (for verify_displayed steps).
 * For "X product card" / "X card", also accepts visibility of X (e.g. "Nike") so product cards pass.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} targetText - Text to find (e.g. "Nike product card", "Admin Control Panel").
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
  // "X product card" / "X card": accept visibility of X so product-detail pages pass
  const productCardMatch = name.match(/^(.+?)\s+product\s+card$/i) || name.match(/^(.+?)\s+card$/i);
  if (productCardMatch) {
    const mainPart = productCardMatch[1].trim();
    if (mainPart.length >= 2) {
      const mainEscaped = mainPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mainRegex = new RegExp(mainEscaped, "i");
      if (await tryScrollAndVisible(page.getByText(mainRegex))) return true;
    }
  }
  return false;
}

/** Duration (ms) the red highlight stays on the element after interaction. */
const HIGHLIGHT_DURATION_MS = 1800;
/** Pause after applying highlight so the next screenshot frame captures it. */
const HIGHLIGHT_PAUSE_MS = 280;

/**
 * Takes a screenshot and sends it as a "frame" so the stream UI shows the current page (e.g. with highlight).
 * Call immediately after highlightElement/highlightLocator so the user sees the highlighted element.
 * @param {import('ws').WebSocket} ws - WebSocket to send to.
 * @param {import('playwright').Page | null} page - Page to screenshot.
 * @param {string | null} sessionId - Session id for the frame payload.
 */
async function sendFrameNow(ws, page, sessionId) {
  if (!page || !ws || ws.readyState !== 1) return;
  try {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise((r) => setTimeout(r, 120));
    const buffer = await page.screenshot({ type: "png" });
    const base64 = buffer.toString("base64");
    send(ws, "frame", { data: base64, width: 1280, height: 720, sessionId });
    await new Promise((r) => setTimeout(r, 80));
    send(ws, "frame", { data: base64, width: 1280, height: 720, sessionId });
  } catch (_) {}
}
/** Wait for element to be visible (e.g. inside modal); modals can take time to render. */
const INTERACTION_VISIBLE_TIMEOUT_MS = 12000;
/** Default click/fill timeout; retry with force if visibility fails. */
const INTERACTION_CLICK_TIMEOUT_MS = 6000;

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
        el.style.setProperty("outline", "4px solid #f44");
        el.style.setProperty("outline-offset", "2px");
        el.style.setProperty("box-shadow", "0 0 0 4px rgba(255,68,68,0.6)");
        el.style.setProperty("z-index", "2147483647");
        const parent = el.closest("[style]") || el.parentElement;
        if (parent && parent !== document.body) parent.style.setProperty("z-index", "2147483647");
        setTimeout(() => {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow");
          el.style.removeProperty("z-index");
          if (parent && parent !== document.body) parent.style.removeProperty("z-index");
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
 * Same red highlight as highlightElement but for a Playwright Locator (used by fast path and locate-first).
 * @param {import('playwright').Page} page - Playwright page (unused; for API consistency).
 * @param {import('playwright').Locator} loc - Locator to the first element to highlight.
 * @param {number} [durationMs] - How long the highlight stays (default HIGHLIGHT_DURATION_MS).
 */
async function highlightLocator(page, loc, durationMs = HIGHLIGHT_DURATION_MS) {
  try {
    await loc.first().evaluate(
      (el, { duration }) => {
        if (!el) return;
        el.style.setProperty("outline", "4px solid #f44");
        el.style.setProperty("outline-offset", "2px");
        el.style.setProperty("box-shadow", "0 0 0 4px rgba(255,68,68,0.6)");
        el.style.setProperty("z-index", "2147483647");
        const parent = el.closest("[style]") || el.parentElement;
        if (parent && parent !== document.body) parent.style.setProperty("z-index", "2147483647");
        setTimeout(() => {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow");
          el.style.removeProperty("z-index");
          if (parent && parent !== document.body) parent.style.removeProperty("z-index");
        }, duration);
      },
      { duration: durationMs }
    );
    await new Promise((r) => setTimeout(r, HIGHLIGHT_PAUSE_MS));
  } catch (_) {
    // element may be detached or not found
  }
}

/**
 * Highlights the element at (x, y) using document.elementFromPoint (e.g. before mouse.click from Visual Discovery).
 * @param {import('playwright').Page} page - Playwright page.
 * @param {number} x - Viewport x.
 * @param {number} y - Viewport y.
 * @param {number} [durationMs] - How long the highlight stays (default HIGHLIGHT_DURATION_MS).
 */
async function highlightAtPoint(page, x, y, durationMs = HIGHLIGHT_DURATION_MS) {
  try {
    await page.evaluate(
      ({ px, py, duration }) => {
        const el = document.elementFromPoint(px, py);
        if (!el) return;
        el.style.setProperty("outline", "4px solid #f44");
        el.style.setProperty("outline-offset", "2px");
        el.style.setProperty("box-shadow", "0 0 0 4px rgba(255,68,68,0.6)");
        el.style.setProperty("z-index", "2147483647");
        const parent = el.closest("[style]") || el.parentElement;
        if (parent && parent !== document.body) parent.style.setProperty("z-index", "2147483647");
        setTimeout(() => {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow");
          el.style.removeProperty("z-index");
          if (parent && parent !== document.body) parent.style.removeProperty("z-index");
        }, duration);
      },
      { px: x, py: y, duration: durationMs }
    );
    await new Promise((r) => setTimeout(r, HIGHLIGHT_PAUSE_MS));
  } catch (_) {}
}

/**
 * Highlights the element at (x, y) and sends a frame so the stream UI shows it. Call before mouse.click(x, y).
 */
async function highlightAtPointAndSendFrame(page, x, y, ws, sessionId) {
  await highlightAtPoint(page, x, y);
  if (ws && ws.readyState === 1) await sendFrameNow(ws, page, sessionId);
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
 * Tries to dismiss Amazon's "We're showing you items that ship to..." popup so the search input is not blocked.
 */
async function dismissAmazonDeliveryPopup(page) {
  const selectors = [
    'button:has-text("Dismiss")',
    'a:has-text("Dismiss")',
    '[data-action="dismiss"]',
    'input[type="button"][value="Dismiss"]',
    'input[value="Dismiss"]',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.click({ timeout: 1500 });
      await new Promise((r) => setTimeout(r, 600));
      return true;
    } catch (_) {
      continue;
    }
  }
  try {
    const byRole = page.getByRole("button", { name: /dismiss/i }).first();
    await byRole.click({ timeout: 1500 });
    await new Promise((r) => setTimeout(r, 600));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Submits the search form by focusing the search input and pressing Enter. Avoids clicking the search
 * button, which on some sites (e.g. Amazon) can throw "Assignment to constant variable" from their script.
 * @param {import('playwright').Page} page - Playwright page.
 * @returns {Promise<boolean>} True if a search input was found and Enter was pressed.
 */
async function submitSearchViaEnter(page) {
  // Try Enter first — after "fill search with X", focus is often already in the search input
  try {
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 1000));
    const url = page.url();
    if (url && (url.includes("/s?") || url.includes("/s/") || url.includes("search") || url.includes("q="))) return true;
  } catch (_) {}

  // Dismiss Amazon's "Deliver to India" popup then focus search input and Enter
  await dismissAmazonDeliveryPopup(page);
  await new Promise((r) => setTimeout(r, 400));

  const tryFocusAndEnter = async () => {
    const locators = [
      page.getByRole("searchbox").first(),
      page.getByLabel(/search/i).first(),
      page.getByPlaceholder(/search/i).first(),
    ];
    for (const loc of locators) {
      try {
        if ((await loc.count()) > 0) {
          await loc.waitFor({ state: "visible", timeout: 2000 });
          await loc.scrollIntoViewIfNeeded();
          await loc.focus({ timeout: 2000 });
          await page.keyboard.press("Enter");
          return true;
        }
      } catch (_) {
        continue;
      }
    }
    for (const sel of SEARCH_INPUT_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: "attached", timeout: 2000 });
        await loc.scrollIntoViewIfNeeded();
        await loc.focus({ timeout: 2000 });
        await page.keyboard.press("Enter");
        return true;
      } catch (_) {
        continue;
      }
    }
    return false;
  };
  if (await tryFocusAndEnter()) return true;
  await dismissAmazonDeliveryPopup(page);
  await new Promise((r) => setTimeout(r, 500));
  if (await tryFocusAndEnter()) return true;
  return false;
}

/**
 * Submits the login form without using Playwright's click (avoids "page script error" on sites that throw on synthetic click).
 * Tries: (1) Enter key, (2) form.requestSubmit(), (3) form.submit(), (4) native button.click() in page context.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {number} navWaitMs - Max wait for URL to change after submit (e.g. LOGIN_NAV_WAIT_MS).
 * @returns {Promise<boolean>} True if submit was attempted and URL changed (or navigation occurred).
 */
async function submitLoginFormWithoutClickingButton(page, navWaitMs = LOGIN_NAV_WAIT_MS) {
  const urlBefore = page.url();
  const urlChanged = () => {
    const now = page.url();
    return now && now !== urlBefore;
  };

  // 1) Enter key — focus is often in password field after "Enter Password"
  try {
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 1500));
    if (urlChanged()) return true;
    await page.waitForURL((u) => u !== urlBefore, { timeout: navWaitMs }).catch(() => {});
    if (urlChanged()) return true;
  } catch (_) {}

  // 2) Form submit via requestSubmit (fires submit event; SPAs often handle it)
  try {
    const submitted = await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) return false;
      const hasPassword = form.querySelector('input[type="password"]');
      if (!hasPassword) return false;
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return true;
      }
      form.submit();
      return true;
    });
    if (submitted) {
      await new Promise((r) => setTimeout(r, 1500));
      if (urlChanged()) return true;
      await page.waitForURL((u) => u !== urlBefore, { timeout: navWaitMs }).catch(() => {});
      if (urlChanged()) return true;
    }
  } catch (_) {}

  // 3) Native DOM click on submit button / Login button (bypasses Playwright's click; often avoids page script error)
  try {
    const clicked = await page.evaluate(() => {
      const sel = 'input[type="submit"], button[type="submit"], button:not([type]), [type="submit"]';
      const buttons = document.querySelectorAll(sel);
      for (const el of buttons) {
        const text = (el.value || el.textContent || "").toLowerCase();
        if (/login|sign\s*in|submit/.test(text) || el.type === "submit") {
          el.click();
          return true;
        }
      }
      const byText = document.evaluate(
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'login')] | //input[@type='submit']",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      if (byText) {
        byText.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await new Promise((r) => setTimeout(r, 1500));
      if (urlChanged()) return true;
      await page.waitForURL((u) => u !== urlBefore, { timeout: navWaitMs }).catch(() => {});
      if (urlChanged()) return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Clicks the element; waits for visible, scrolls into view, highlights, then clicks. On "not visible" timeout, retries with force.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @param {{ timeout?: number; preferEnterOnScriptError?: boolean; ws?: import('ws').WebSocket; sessionId?: string | null }} [opts] - Click timeout and optional frame push (ws + sessionId) so stream shows highlight.
 */
async function clickWithVisibleOrForce(page, selector, opts = {}) {
  const timeout = opts.timeout ?? INTERACTION_CLICK_TIMEOUT_MS;
  const preferEnterOnScriptError = opts.preferEnterOnScriptError === true;
  await waitForVisibleAndScroll(page, selector);
  await highlightElement(page, selector);
  if (opts.ws && opts.ws.readyState === 1) await sendFrameNow(opts.ws, page, opts.sessionId ?? null);
  let lastError = null;
  try {
    await page.click(selector, { timeout });
    return;
  } catch (e) {
    lastError = e;
    const msg = (e && e.message) || "";
    const isVisibility = /not visible|Timeout.*exceeded|outside of the viewport/i.test(msg);
    const isPageScriptError = /assignment to constant|typeerror|reference error/i.test(msg);
    if (isVisibility || isPageScriptError) {
      try {
        await page.click(selector, { timeout: 5000, force: true });
        return;
      } catch (forceErr) {
        lastError = forceErr;
        if (isPageScriptError || preferEnterOnScriptError) {
          try {
            const focused = await page.evaluate(() => {
              const input = document.querySelector('input[type="search"]') ||
                document.querySelector('form input[type="text"]') ||
                document.querySelector('input[name*="search"]') ||
                document.querySelector('input[name*="keyword"]') ||
                document.querySelector('.nav-search-field input') ||
                document.querySelector('input[type="text"]');
              if (input) {
                input.focus();
                return true;
              }
              return false;
            });
            if (focused) await page.keyboard.press("Enter");
            if (focused) return;
          } catch (_) {
            // fallback: try Enter anyway (focus may still be in search from fill step)
            try {
              await page.keyboard.press("Enter");
              return;
            } catch (_) {}
          }
          throw lastError;
        }
        throw lastError;
      }
    }
    throw e;
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
    if (opts.ws && opts.ws.readyState === 1) await sendFrameNow(opts.ws, page, opts.sessionId ?? null);
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

/** Same selectors we use for submit; used to fill the search box for "Search X" steps. */
const SEARCH_INPUT_SELECTORS = [
  'input[name="q"]',
  'input[name="search"]',
  'input[type="search"]',
  'input[placeholder*="Search" i]',
  'input[aria-label*="search" i]',
  '[role="searchbox"]',
  'input[autocomplete*="search" i]',
  "#twotabsearchtextbox",
  'input[name="field-keywords"]',
  'input[name*="field-keywords"]',
  'input[name*="keyword"]',
  ".nav-search-field input",
  "#nav-search-bar-form input[type=\"text\"]",
  'form[role="search"] input[type="text"]',
  "form input[type=\"search\"]",
  "form input[type=\"text\"]",
];

/**
 * Fills the visible search input on the page (works for any site: main page, modal, dialog).
 * Tries: dialog search first if a dialog is open, then page-level selectors, then snapshot, then Claude Visual.
 * When frameCtx (ws, sessionId) is provided, highlights the element and sends a frame so the monitor shows it.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} value - Text to type (e.g. "Nike Shoes" or "ddmsaustralia.dev.membr.com").
 * @param {{ ws?: import('ws').WebSocket, sessionId?: string | null }} [frameCtx] - If set, highlight and send frame so monitor updates.
 * @returns {Promise<boolean>} True if an input was found and filled.
 */
async function fillSearchInput(page, value, frameCtx) {
  if (!value || typeof value !== "string") return false;
  const trimmed = String(value).trim().replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return false;
  const tryFill = async (locatorOrSelector) => {
    try {
      const loc = typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector).first() : locatorOrSelector.first();
      await loc.waitFor({ state: "visible", timeout: 5000 });
      await loc.scrollIntoViewIfNeeded();
      await new Promise((r) => setTimeout(r, 100));
      await highlightLocator(page, loc);
      if (frameCtx && frameCtx.ws && frameCtx.ws.readyState === 1) await sendFrameNow(frameCtx.ws, page, frameCtx.sessionId ?? null);
      await loc.fill(trimmed, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, SEARCH_TYPE_WAIT_MS));
      return true;
    } catch (_) {
      return false;
    }
  };
  // 1) If a dialog/modal is open, try search-like inputs inside it first (generic: works for any modal with a search field)
  try {
    const dialog = page.getByRole("dialog");
    if ((await dialog.count()) > 0) {
      const inDialogPlaceholder = dialog.getByPlaceholder(/search/i);
      if ((await inDialogPlaceholder.count()) > 0 && (await tryFill(inDialogPlaceholder))) return true;
      const inDialogLabel = dialog.getByLabel(/search/i);
      if ((await inDialogLabel.count()) > 0 && (await tryFill(inDialogLabel))) return true;
      const inDialogSearchbox = dialog.getByRole("searchbox");
      if ((await inDialogSearchbox.count()) > 0 && (await tryFill(inDialogSearchbox))) return true;
      const inDialogTextbox = dialog.getByRole("textbox");
      if ((await inDialogTextbox.count()) > 0 && (await tryFill(inDialogTextbox))) return true;
    }
  } catch (_) {}
  // 2) Page-level: label, placeholder, role, then known selectors
  try {
    const byLabel = page.getByLabel(/search/i);
    if ((await byLabel.count()) > 0 && (await tryFill(byLabel))) return true;
  } catch (_) {}
  try {
    const byPlaceholder = page.getByPlaceholder(/search/i);
    if ((await byPlaceholder.count()) > 0 && (await tryFill(byPlaceholder))) return true;
  } catch (_) {}
  try {
    const searchbox = page.getByRole("searchbox");
    if ((await searchbox.count()) > 0 && (await tryFill(searchbox))) return true;
  } catch (_) {}
  for (const sel of SEARCH_INPUT_SELECTORS) {
    try {
      if (await tryFill(sel)) return true;
    } catch (_) {
      continue;
    }
  }
  // 3) Snapshot-based best match for "search"
  try {
    const snapshot = await page.evaluate(getDomSnapshotInPage);
    const selector = findBestSelector(snapshot, "search", "fill");
    if (selector && (await tryFill(selector))) return true;
  } catch (_) {}
  // 4) Claude Visual: generic prompt works for any page or modal
  try {
    const discovery = await getVisualDiscoveryResult(page, "search input or text box to type a search query", { disambiguate: false });
    if (discovery) {
      await highlightAtPoint(page, discovery.x, discovery.y);
      if (frameCtx && frameCtx.ws && frameCtx.ws.readyState === 1) await sendFrameNow(frameCtx.ws, page, frameCtx.sessionId ?? null);
      await page.mouse.click(discovery.x, discovery.y);
      await new Promise((r) => setTimeout(r, 300));
      await page.keyboard.type(trimmed, { delay: 50 });
      await new Promise((r) => setTimeout(r, SEARCH_TYPE_WAIT_MS));
      return true;
    }
  } catch (_) {}
  return false;
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
 * Derives a stable CSS selector for the element at (x, y) so we can cache it for next run (SuccessMap).
 * Prefers id, data-testid, data-fs-id, then role+accessible name, then tag+unique class.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {number} x - Viewport x.
 * @param {number} y - Viewport y.
 * @returns {Promise<string | null>}
 */
async function getSelectorForPoint(page, x, y) {
  try {
    const sel = await page.evaluate(({ px, py }) => {
      const el = document.elementFromPoint(px, py);
          if (!el || el === document.body) return null;
          const id = el.id && /^[a-zA-Z][\w-]*$/.test(el.id);
          if (id && document.querySelector(`#${CSS.escape(el.id)}`) === el) return `#${el.id}`;
          const testId = el.getAttribute("data-testid");
          if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
          const fsId = el.getAttribute("data-fs-id");
          if (fsId) return `[data-fs-id="${CSS.escape(fsId)}"]`;
          const role = el.getAttribute("role") || (el.tagName && el.tagName.toLowerCase());
          const ariaLabel = el.getAttribute("aria-label");
          if (role && ariaLabel && document.querySelectorAll(`${role}[aria-label="${CSS.escape(ariaLabel)}"]`).length === 1)
            return `${role}[aria-label="${CSS.escape(ariaLabel)}"]`;
          const tag = el.tagName && el.tagName.toLowerCase();
          const cls = el.className && typeof el.className === "string" && el.className.trim();
          if (tag && cls) {
            const firstClass = cls.split(/\s+/)[0];
            if (firstClass && /^[a-zA-Z][\w-]*$/.test(firstClass)) {
              const q = `${tag}.${firstClass}`;
              if (document.querySelector(q) === el) return q;
            }
          }
          return null;
    }, { px: x, py: y });
    return typeof sel === "string" && sel.length > 0 ? sel : null;
  } catch (_) {
    return null;
  }
}

/** True if the error is from page JavaScript (e.g. "Assignment to constant variable"). */
function isPageScriptError(err) {
  return /assignment to constant|typeerror|reference error/i.test((err && err.message) || "");
}

/** True if Playwright threw because the page/context/browser was closed (e.g. session ended during step). */
function isPageClosedError(err) {
  return /target page, context or browser has been closed|page has been closed/i.test((err && err.message) || "");
}

/** User-facing message: never expose raw page script or session-closed errors. */
function userFacingMessage(err) {
  const msg = (err && err.message) || "";
  if (isPageScriptError(err)) return "Click or hover failed (page script error).";
  if (isPageClosedError(err)) return "Session ended during step (browser or connection closed).";
  return msg || "Step failed.";
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
    try {
      const pageScreenshot = await page.screenshot({ type: "png" });
      const pageScreenshotB64 = pageScreenshot.toString("base64");
      send(ws, "page_screenshot", { sessionId, url: page.url(), screenshot: pageScreenshotB64 });
    } catch (_) {}

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
    const msg = userFacingMessage(err);
    sendLog(ws, `Error: ${msg}`, "error", sessionId);
    send(ws, "test_error", { sessionId, message: msg, screenshot: screenshotBase64 });
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
 * Processes the next step in this connection's queue. Automation is driven by test case instructions; each
 * step is parsed to a single action and only that action runs (no extra clicks on verify steps).
 *
 * Browser actions (from test cases):
 * - verify_displayed: READ-ONLY — check that text/element is visible; no click, no fill, no navigation.
 * - navigate: go to URL.
 * - fill / type: enter value in field (username, password, search, etc.).
 * - submit_search: submit search (Enter or focus+Enter); never click the search button when avoidable.
 * - click / step: click or press (button, link, etc.).
 * - hover: hover over element.
 * - press: key on focused element.
 *
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
    /** Classify failure: 'selector' = element not found / action failed (fixable via AI); 'functional' = verify failed or real product bug. */
    let stepFailureType = "selector";
    /** Which resolved this step: interpreter, claude (LLM), or visual_discovery (Claude Visual). */
    let resolvedBy = "interpreter";
    const resolvedByLabel = (v) =>
      ({ interpreter: "Interpreter", claude: "Claude (LLM)", visual_discovery: "Claude (Visual)" }[v] || v);
    const stepDone = (payload) => {
      sendLog(ws, `Step used: ${resolvedByLabel(resolvedBy)}`, "info", sessionId);
      send(ws, "step_done", { sessionId, resolvedBy, ...payload });
    };
    try {
      let selector = msg.selector;
      const target = msg.target;
      const hasInstruction = Boolean(msg.instruction && msg.instruction.trim());
      /** Parse once early (cached ActionSchema so we don't re-parse the same instruction twice). */
      const parsedEarly = hasInstruction ? getCompiledActionSchema(msg.instruction) : null;

      // ─── Verify (read-only, no click): must run before any click/fill so assertions never trigger UI actions ─────────────────
      const isVerifyStep = parsedEarly && parsedEarly.action === "verify_displayed" && parsedEarly.target;
      if (isVerifyStep) {
        const verifyTarget = parsedEarly.target;
        let visible = false;
        let verifyReasoning = null;
        const deadline = Date.now() + VERIFY_RETRY_TOTAL_MS;
        while (Date.now() < deadline) {
          visible = await isElementWithTextVisible(activePage, verifyTarget, { timeout: VERIFY_RETRY_INTERVAL_MS });
          if (visible) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!visible) {
          const alternates = [verifyTarget];
          const lower = (verifyTarget || "").toLowerCase();
          if (/admin\s*control\s*panel/i.test(lower)) alternates.push("dashboard", "admin", "control panel");
          if (/dashboard/i.test(lower)) alternates.push("admin", "admin panel");
          if (/login\s*(success|successful)/i.test(lower)) alternates.push("dashboard", "admin", "home");
          for (const alt of alternates.slice(1)) {
            const found = await isElementWithTextVisible(activePage, alt, { timeout: 1500 });
            if (found) {
              visible = true;
              verifyReasoning = `Environment scan: "${verifyTarget}" not found; matched alternate "${alt}" as success.`;
              sendLog(ws, verifyReasoning, "info", sessionId);
              break;
            }
          }
        }
        let stepPayload = { success: visible, screenshot: await takeStepScreenshot(activePage), ...(verifyReasoning ? { discoveryReason: verifyReasoning } : {}) };
        if (visible) {
          sendLog(ws, "Step successful.", "info", sessionId);
        } else {
          const snippet = await getVisibleTextSnippet(activePage);
          const expectedMsg = `Expected: an element containing "${verifyTarget}" to be visible on the page.`;
          const actualMsg = snippet
            ? `Actual: no element with that text was found. Visible text on page includes: "${snippet}${snippet.length >= VERIFY_ACTUAL_SNIPPET_CHARS ? "…" : ""}"`
            : `Actual: no element containing "${verifyTarget}" was found in the viewport.`;
          sendLog(ws, `"${verifyTarget}" is not displayed.`, "error", sessionId);
          sendLog(ws, expectedMsg, "info", sessionId);
          sendLog(ws, actualMsg, "info", sessionId);
          stepFailureType = "functional";
          stepPayload = { ...stepPayload, message: `"${verifyTarget}" is not displayed.`, expectedElement: expectedMsg, actualPageContent: actualMsg, failureType: "functional" };
        }
        stepDone(stepPayload);
        done = true;
      }

      // ─── Fast path: Navigate — no Interpreter, no snapshot ─────────────────
      if (!done && parsedEarly && parsedEarly.action === "navigate") {
        const url = parsedEarly.value || parsedEarly.target || msg.url;
        if (url) {
          try {
            await gotoWithAbortHandling(activePage, url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await activePage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
            try {
              const b64 = (await activePage.screenshot({ type: "png" })).toString("base64");
              send(ws, "page_screenshot", { sessionId, url: activePage.url(), screenshot: b64 });
            } catch (_) {}
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true });
            done = true;
          } catch (navErr) {
            sendLog(ws, `Navigation failed: ${navErr.message}`, "error", sessionId);
            stepDone({ success: false, error: navErr.message, failureType: "functional" });
            done = true;
          }
        }
      }

      // ─── Fast path: Obvious fill (username/password) — wait for form then try multiple locators ─────────────────
      if (!done && (parsedEarly?.action === "fill" || parsedEarly?.action === "type") && parsedEarly?.target) {
        const field = String(parsedEarly.target).toLowerCase().replace(/\s+field$/i, "").trim();
        const value = parsedEarly.value != null ? String(parsedEarly.value) : (msg.value || msg.text || "");
        const isObviousField = /^(username|user|email|e-?mail|password|pass)$/i.test(field);
        if (isObviousField && value) {
          const timeout = FAST_PATH_LOCATOR_TIMEOUT_MS;
          let filled = false;
          try {
            await activePage.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
            await activePage.waitForSelector("input[type=\"text\"], input[type=\"email\"], input[type=\"password\"], input:not([type]), input[type=\"search\"]", { state: "attached", timeout: 5000 }).catch(() => {});
          } catch (_) {}
          try {
            const labelMatch = activePage.getByLabel(new RegExp(field.replace(/e-?mail/, "email"), "i"));
            if ((await labelMatch.count()) > 0) {
              await labelMatch.first().fill(value, { timeout });
              filled = true;
            }
          } catch (_) {}
          if (!filled && /password/i.test(field)) {
            try {
              const pwd = activePage.getByRole("textbox", { name: /password/i }).or(activePage.locator('input[type="password"]')).or(activePage.locator('input[autocomplete*="password"]'));
              if ((await pwd.count()) > 0) { await pwd.first().fill(value, { timeout }); filled = true; }
            } catch (_) {}
          }
          if (!filled && /username|user|email/i.test(field)) {
            try {
              const usernameInput = activePage.locator('input[type="email"]').or(activePage.locator('input[name*="user"]')).or(activePage.locator('input[name*="email"]')).or(activePage.locator('input[autocomplete*="username"]')).or(activePage.locator('input[autocomplete*="email"]')).or(activePage.getByPlaceholder(/username|email|user|e-?mail/i));
              if ((await usernameInput.count()) > 0) { await usernameInput.first().fill(value, { timeout }); filled = true; }
            } catch (_) {}
          }
          if (!filled) {
            try {
              const byPlaceholder = activePage.getByPlaceholder(new RegExp(field.replace(/e-?mail/, "e?mail"), "i"));
              if ((await byPlaceholder.count()) > 0) { await byPlaceholder.first().fill(value, { timeout }); filled = true; }
            } catch (_) {}
          }
          if (filled) {
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true });
            done = true;
          }
        }
      }

      // ─── Fast path: Click (e.g. Login) — try button, input[type=submit], link, then by text. Never run for verify steps. ─────────────────
      if (!done && parsedEarly?.action !== "verify_displayed" && (action === "click" || action === "step") && (hasInstruction || target)) {
        const clickTarget = (parsedEarly?.target || target || msg.instruction || "").trim();
        const looksLikeLogin = /\b(login|sign\s*in|log\s*in|submit)\b/i.test(clickTarget) || /\b(login|sign\s*in)\b/i.test((msg.instruction || "").trim());
        const timeout = FAST_PATH_LOCATOR_TIMEOUT_MS;
        let clicked = false;
        // Login step: submit form without Playwright click first (avoids "page script error" on many sites)
        if (looksLikeLogin) {
          try {
            clicked = await submitLoginFormWithoutClickingButton(activePage, LOGIN_NAV_WAIT_MS);
          } catch (_) {}
        }
        const re = new RegExp(clickTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const tryClickThenNav = async (loc) => {
          if ((await loc.count()) === 0) return false;
          await highlightLocator(activePage, loc);
          await sendFrameNow(ws, activePage, sessionId);
          const urlBefore = activePage.url();
          try {
            await loc.first().click({ timeout });
          } catch (e) {
            if (isPageScriptError(e)) {
              try {
                await loc.first().click({ timeout: 5000, force: true });
              } catch (_) {
                throw e;
              }
            } else {
              throw e;
            }
          }
          if (looksLikeLogin) {
            try { await activePage.waitForLoadState("networkidle", { timeout: LOGIN_NAV_WAIT_MS }); } catch (_) {}
            try { await activePage.waitForURL((u) => u !== urlBefore, { timeout: LOGIN_NAV_WAIT_MS }); } catch (_) {}
          }
          return true;
        };
        try {
          if (!clicked) clicked = await tryClickThenNav(activePage.getByRole("button", { name: re }));
        } catch (_) {}
        if (!clicked && clickTarget) {
          try {
            if ((await activePage.locator('input[type="submit"]').count()) > 0) {
              const firstSubmit = activePage.locator('input[type="submit"]').first();
              await firstSubmit.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
              if (await firstSubmit.isVisible().catch(() => false)) clicked = await tryClickThenNav(firstSubmit);
            }
          } catch (_) {}
        }
        if (!clicked && clickTarget) {
          try {
            if (looksLikeLogin) clicked = await tryClickThenNav(activePage.getByRole("link", { name: re }));
          } catch (_) {}
        }
        if (!clicked && clickTarget) {
          try {
            const byText = activePage.getByText(re).first();
            if ((await activePage.getByText(re).count()) > 0) clicked = await tryClickThenNav(byText);
          } catch (_) {}
        }
        if (clicked) {
          sendLog(ws, "Step successful.", "info", sessionId);
          stepDone({ success: true });
          done = true;
        }
      }

      // Early intercept: "click Search Button" — no LLM, no selector, never click the button
      const instr = (msg.instruction || "").trim().toLowerCase();
      const tgt = (target || "").trim().toLowerCase();
      const isSearchButtonStep =
        (action === "click" || action === "step") &&
        ((instr.includes("search") && instr.includes("button")) || (tgt.includes("search") && tgt.includes("button")));
      if (isSearchButtonStep) {
        // Try Enter first (focus is often already in search field after "fill search with X")
        let submitted = false;
        try {
          await activePage.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 1200));
          const url = activePage.url();
          if (url && (url.includes("/s?") || url.includes("/s/") || url.includes("search") || url.includes("q="))) submitted = true;
        } catch (_) {}
        if (!submitted) submitted = await submitSearchViaEnter(activePage);
        if (!submitted) {
          try {
            await activePage.keyboard.press("Enter");
            submitted = true;
          } catch (_) {}
        }
        if (!submitted) {
          const coords = await getVisualClickCoordinates(activePage, "search button");
          if (coords) {
            try {
              await highlightAtPointAndSendFrame(activePage, coords.x, coords.y, ws, sessionId);
              resolvedBy = "visual_discovery";
              await activePage.mouse.click(coords.x, coords.y);
              submitted = true;
            } catch (_) {}
          }
        }
        if (submitted) {
          sendLog(ws, "Step successful.", "info", sessionId);
          stepDone({ success: true });
        } else {
          sendLog(ws, "Trying Claude (Visual) for search/submit before failing…", "info", sessionId);
          const coords = await getVisualClickCoordinates(activePage, "search button or submit search");
          if (coords) {
            try {
              await highlightAtPointAndSendFrame(activePage, coords.x, coords.y, ws, sessionId);
              await activePage.mouse.click(coords.x, coords.y);
              submitted = true;
              sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
              stepDone({ success: true });
            } catch (_) {}
          }
          if (!submitted) {
            sendLog(ws, "Search submit failed.", "error", sessionId);
            stepDone({ success: false, error: "Search submit failed (Enter and visual fallback did not succeed)." });
          }
        }
        done = true;
      }
      if (!done && (action === "click" || action === "step") && hasInstruction) {
        const instrLower = (msg.instruction || "").trim().toLowerCase();
        if (instrLower.includes("click on") && !instrLower.includes("search") && !instrLower.includes("button")) {
          await dismissAmazonDeliveryPopup(activePage);
          await new Promise((r) => setTimeout(r, 600));
          const engineResult = await runSemanticLocatorFlow(activePage, msg.instruction.trim(), "click", {
            trySemanticLocators: clickOrHoverByText,
          });
          if (engineResult.success) {
            if (engineResult.method === "semantic") {
              resolvedBy = "interpreter";
              sendLog(ws, "Step successful (semantic locator).", "info", sessionId);
              stepDone({ success: true });
            } else {
              resolvedBy = "visual_discovery";
              sendLog(ws, `Using Claude (Visual Discovery) for step: ${(msg.instruction || "").trim().slice(0, 50)}…`, "info", sessionId);
              sendLog(ws, "Step successful (Visual Discovery).", "info", sessionId);
              stepDone({
                success: true,
                visualClick: true,
                discoveryReason: engineResult.reason,
                validationPassed: engineResult.validationPassed,
              });
            }
            done = true;
          } else if (engineResult.method === "visual") {
            sendLog(ws, "Trying LLM healing then Visual again before failing…", "info", sessionId);
            const instruction = (msg.instruction || "").trim();
            const heal = await findAndRetry(activePage, instruction, "click", instruction);
            if (heal.success && heal.selector) {
              try {
                await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
                resolvedBy = "claude";
                sendLog(ws, "Step successful (LLM rescue).", "info", sessionId);
                stepDone({ success: true, selfHealed: true, aiHeal: true });
                done = true;
              } catch (_) {}
            }
            if (!done) {
              const discovery = await getVisualDiscoveryResult(activePage, instruction, { disambiguate: true });
              if (discovery) {
                try {
                  await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                  await activePage.mouse.click(discovery.x, discovery.y);
                  resolvedBy = "visual_discovery";
                  sendLog(ws, "Step successful (Visual retry).", "info", sessionId);
                  stepDone({ success: true, visualClick: true });
                  done = true;
                } catch (_) {}
              }
            }
            if (!done) {
              resolvedBy = "visual_discovery";
              sendLog(ws, "Visual Discovery click failed.", "error", sessionId);
              stepDone({ success: false, error: "Visual Discovery did not succeed." });
              done = true;
            }
          }
        }
      }
      const parsedInstruction = parsedEarly || (hasInstruction ? getCompiledActionSchema(msg.instruction) : null);

      // Early intercept: "Search [for] X" → fill the visible search input (any page/modal) then submit (Enter). One path for all.
      const searchMatch = hasInstruction && msg.instruction.match(/^search\s+(?:for\s+)?(.+)$/i);
      const searchFillValue = (parsedEarly?.action === "fill" && parsedEarly?.target === "search" && parsedEarly?.value)
        ? String(parsedEarly.value).trim().replace(/^["']|["']$/g, "")
        : (searchMatch ? String(searchMatch[1]).replace(/^for\s+/i, "").trim().replace(/^["']|["']$/g, "") : null);
      if (!done && searchFillValue) {
        let filled = await fillSearchInput(activePage, searchFillValue, { ws, sessionId });
        if (!filled) {
          sendLog(ws, "Trying Claude (Visual) for search input…", "info", sessionId);
          const discovery = await getVisualDiscoveryResult(activePage, "search input or text box to type a search query", { disambiguate: false });
          if (discovery) {
            try {
              await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
              await activePage.mouse.click(discovery.x, discovery.y);
              await new Promise((r) => setTimeout(r, 300));
              await activePage.keyboard.type(searchFillValue, { delay: 50 });
              await new Promise((r) => setTimeout(r, SEARCH_TYPE_WAIT_MS));
              filled = true;
            } catch (_) {}
          }
        }
        if (filled) {
          const urlBeforeSearch = activePage.url();
          await new Promise((r) => setTimeout(r, 400));
          await activePage.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 1500));
          const urlAfter = activePage.url();
          const urlChanged = urlAfter && urlAfter !== urlBeforeSearch;
          const looksLikeResults = urlChanged || /\/s\?|\/s\/|search|q=|results/i.test(urlAfter || "");
          if (urlChanged || looksLikeResults) {
            sendLog(ws, "Step successful (search filled and submitted).", "info", sessionId);
            stepDone({ success: true });
            done = true;
          } else {
            const submitted = await submitSearchViaEnter(activePage);
            if (submitted) {
              sendLog(ws, "Step successful (search submitted via Enter).", "info", sessionId);
              stepDone({ success: true });
              done = true;
            } else {
              sendLog(ws, "Step successful (search filled; submit may not have navigated).", "info", sessionId);
              stepDone({ success: true });
              done = true;
            }
          }
        }
      }

      const isDynamic =
        !done &&
        !selector &&
        (target || hasInstruction) &&
        ["click", "fill", "type", "press", "hover", "step", "submit_search"].includes(action);

      if (isDynamic) {
        // Dismiss delivery/location popups before click steps so links (e.g. product cards) are not blocked
        if (action === "click" || action === "step") {
          await dismissAmazonDeliveryPopup(activePage);
          await new Promise((r) => setTimeout(r, 400));
        }
        let lastError = null;
        let resolvedAction = action;
        let resolvedValue = msg.value ?? msg.text ?? "";
        let resolvedTarget = target || (parsedEarly && (parsedEarly.target || parsedEarly.value));
        const stepPageUrl = activePage.url();
        const cacheAction = (parsedEarly?.action === "fill" || parsedEarly?.action === "type") ? "fill" : (parsedEarly?.action === "hover" ? "hover" : "click");
        const stepStartTime = Date.now();

        // Pre-flight: ensure page has finished loading (network idle) to prevent false failures from network lag
        try {
          await runPreFlightCheck(activePage);
        } catch (_) {}

        // 1) SuccessMap: use saved selector immediately (<200ms). Never burn tokens on steps that passed before.
        if (!done && hasInstruction && (cacheAction === "click" || cacheAction === "hover" || cacheAction === "fill")) {
          const cachedSelector = getCachedSelector(msg.instruction.trim(), cacheAction, stepPageUrl);
          if (cachedSelector) {
            const trySpeedLayer = async () => {
              const loc = activePage.locator(cachedSelector).first();
              await loc.waitFor({ state: "visible", timeout: Math.min(150, SUCCESS_MAP_TRY_TIMEOUT_MS - 50) });
              if (cacheAction === "click") {
                await clickWithVisibleOrForce(activePage, cachedSelector, { ws, sessionId });
              } else if (cacheAction === "hover") {
                await waitForVisibleAndScroll(activePage, cachedSelector);
                await highlightElement(activePage, cachedSelector);
                await sendFrameNow(ws, activePage, sessionId);
                await activePage.hover(cachedSelector, { timeout: SUCCESS_MAP_TRY_TIMEOUT_MS - 50 });
              } else {
                const fillVal = String(parsedEarly?.value ?? msg.value ?? msg.text ?? "").trim();
                await fillWithVisibleWait(activePage, cachedSelector, fillVal, { timeout: SUCCESS_MAP_TRY_TIMEOUT_MS - 50, ws, sessionId });
              }
            };
            try {
              await Promise.race([
                trySpeedLayer(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("SuccessMap timeout")), SUCCESS_MAP_TRY_TIMEOUT_MS)),
              ]);
              sendLog(ws, "Step successful (Success Map, <200ms).", "info", sessionId);
              stepDone({ success: true, cacheHit: true });
              done = true;
            } catch (_) {
              sendLog(ws, "SuccessMap missed; trying locate-first.", "info", sessionId);
            }
          }
        }

        // 2) Locate-First: standard Playwright locators only (getByLabel, getByPlaceholder, getByRole, input[...]). No AI. <200ms.
        if (!done && (cacheAction === "click" || cacheAction === "fill") && hasInstruction) {
          try {
            const locateFirstOpts = {
              action: cacheAction,
              target: parsedEarly?.target || resolvedTarget || (msg.instruction || "").trim(),
              value: parsedEarly?.value ?? msg.value ?? msg.text ?? "",
            };
            const locateFirstOk = await Promise.race([
              tryLocateFirstOnly(activePage, locateFirstOpts, LOCATE_FIRST_TIMEOUT_MS, { ws, sessionId }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("Locate-first timeout")), LOCATE_FIRST_TIMEOUT_MS)),
            ]).catch(() => false);
            if (locateFirstOk) {
              await waitForStability(activePage, { timeout: 5000 }).catch(() => {});
              sendLog(ws, "Step successful (locate-first, <200ms).", "info", sessionId);
              stepDone({ success: true });
              done = true;
            }
          } catch (_) {}
        }

        // Try by-text and other deterministic locators (still no AI)
        const tryTarget = String(resolvedTarget || (hasInstruction ? (msg.instruction || "").trim() : "") || "").trim();
        if (!done && tryTarget && (resolvedAction === "click" || resolvedAction === "hover" || action === "step")) {
          try {
            const byTextOk = await clickOrHoverByText(activePage, tryTarget, resolvedAction === "hover" ? "hover" : "click", { timeout: FAST_PATH_LOCATOR_TIMEOUT_MS });
            if (byTextOk) {
              lastError = null;
              sendLog(ws, "Step successful.", "info", sessionId);
              stepDone({ success: true });
              done = true;
            }
          } catch (_) {}
        }

        // Early Claude Visual: try immediately when by-text failed (works across many products).
        if (!done && hasInstruction && (resolvedAction === "click" || action === "step")) {
          const instructionOrTarget = (msg.instruction || tryTarget || "").trim();
          if (instructionOrTarget) {
            try {
              sendLog(ws, "Trying Claude (Visual)…", "info", sessionId);
              const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
              if (discovery) {
                const selectorFromPoint = await getSelectorForPoint(activePage, discovery.x, discovery.y);
                if (selectorFromPoint) setCachedSelector(msg.instruction.trim(), "click", stepPageUrl, selectorFromPoint);
                await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                await activePage.mouse.click(discovery.x, discovery.y);
                lastError = null;
                resolvedBy = "visual_discovery";
                sendLog(ws, "Step successful (Claude Visual).", "info", sessionId);
                stepDone({ success: true, visualClick: true, discoveryReason: discovery.reason });
                done = true;
              }
            } catch (_) {}
          }
        }

        // Introspection layer: fuzzy intent match against cached map. Use Claude only when match < 90%.
        if (!done) {
          const introIntent = hasInstruction ? msg.instruction.trim() : [action, target, msg.value].filter(Boolean).join(" ").trim();
          const introAction = (parsedEarly?.action === "fill" || parsedEarly?.action === "type") ? "fill" : (parsedEarly?.action === "hover" ? "hover" : "click");
          if (introIntent && (introAction === "click" || introAction === "hover" || introAction === "fill")) {
            const intro = await matchIntentWithIntrospection(activePage, introIntent, introAction);
            if (intro.normalizedScore >= INTROSPECTION_90_MATCH_THRESHOLD && intro.selector) {
              try {
                if (introAction === "click") {
                  const urlBefore = activePage.url();
                  await clickWithVisibleOrForce(activePage, intro.selector, { ws, sessionId });
                  await waitForStability(activePage, { urlBefore });
                  setCachedSelector(msg.instruction.trim(), introAction, stepPageUrl, intro.selector);
                  sendLog(ws, "Step successful (introspection).", "info", sessionId);
                  stepDone({ success: true, discoveryReason: intro.reasoning });
                  done = true;
                } else if (introAction === "hover") {
                  await waitForVisibleAndScroll(activePage, intro.selector);
                  await highlightElement(activePage, intro.selector);
                  await sendFrameNow(ws, activePage, sessionId);
                  await activePage.hover(intro.selector, { timeout: 5000 });
                  setCachedSelector(msg.instruction.trim(), introAction, stepPageUrl, intro.selector);
                  sendLog(ws, "Step successful (introspection).", "info", sessionId);
                  stepDone({ success: true, discoveryReason: intro.reasoning });
                  done = true;
                } else {
                  const fillVal = String(parsedEarly?.value ?? msg.value ?? msg.text ?? "").trim();
                  await fillWithVisibleWait(activePage, intro.selector, fillVal, { ws, sessionId });
                  setCachedSelector(msg.instruction.trim(), introAction, stepPageUrl, intro.selector);
                  sendLog(ws, "Step successful (introspection).", "info", sessionId);
                  stepDone({ success: true, discoveryReason: intro.reasoning });
                  done = true;
                }
              } catch (_) {}
            }
          }
        }

        if (!done) for (let attempt = 1; attempt <= MAX_FIND_ATTEMPTS; attempt++) {
          try {
            // When step is "search Gym X in Gym Selector", wait for the modal's search input so snapshot includes it
            const isGymSearchStep = hasInstruction && /search\s+(?:for\s+)?(?:gym|Gym)\s+/i.test(msg.instruction) && /Gym\s+Selector/i.test(msg.instruction);
            if (isGymSearchStep) {
              try {
                await activePage.getByPlaceholder(/search\s*gym/i).first().waitFor({ state: "visible", timeout: 5000 });
                await new Promise((r) => setTimeout(r, 300));
              } catch (_) {}
            }
            const snapshot = await activePage.evaluate(getDomSnapshotInPage);
            const intent = hasInstruction ? msg.instruction.trim() : [action, target, msg.value].filter(Boolean).join(" ").trim();
            // Parser first: use rule-based result when we have it so we avoid unnecessary LLM calls and failures
            const parserResult = hasInstruction ? getCompiledActionSchema(msg.instruction) : null;
            const parserHighConfidence =
              parserResult &&
              (parserResult.action === "navigate" ||
                parserResult.action === "submit_search" ||
                parserResult.action === "verify_displayed" ||
                parserResult.action === "fill");

            if (parserHighConfidence) {
              resolvedAction = parserResult.action;
              if (parserResult.value != null) resolvedValue = parserResult.value;
              if (parserResult.target != null) resolvedTarget = parserResult.target;
              if (resolvedAction === "submit_search") selector = null;
              else if (resolvedAction === "fill") {
                // Gym Selector modal: use "search gym" so we match the "Search gym" placeholder input
                const fillQuery = resolvedTarget === "gym" ? "search gym" : (resolvedTarget || "search");
                selector = findBestSelector(snapshot, fillQuery, "fill");
              }
            }

            // Gym search: 1) try direct placeholder match (reliable), 2) then Claude Visual, 3) then selector path
            if (
              !done &&
              parserHighConfidence &&
              resolvedAction === "fill" &&
              resolvedTarget === "gym" &&
              resolvedValue
            ) {
              // 1) Direct: fill input with placeholder "Search gym" (in dialog if present, else first match)
              try {
                let gymSearchInput = activePage.getByPlaceholder(/search\s*gym/i).first();
                try {
                  const inDialog = activePage.getByRole("dialog").getByPlaceholder(/search\s*gym/i).first();
                  await inDialog.waitFor({ state: "visible", timeout: 2000 });
                  gymSearchInput = inDialog;
                } catch (_) {}
                await gymSearchInput.waitFor({ state: "visible", timeout: 5000 });
                await highlightLocator(activePage, gymSearchInput);
                await sendFrameNow(ws, activePage, sessionId);
                await gymSearchInput.fill(resolvedValue);
                await new Promise((r) => setTimeout(r, TYPEAHEAD_SETTLE_MS));
                const stepScreenshot = await takeStepScreenshot(activePage);
                sendLog(ws, "Step successful (Gym Selector search).", "info", sessionId);
                stepDone({ success: true, screenshot: stepScreenshot });
                done = true;
                break;
              } catch (directErr) {
                // 2) Fallback: Claude Visual to find the search box
                try {
                  const discovery = await getVisualDiscoveryResult(
                    activePage,
                    "The text input field with placeholder 'Search gym' inside the Gym Selector modal dialog"
                  );
                  if (discovery) {
                    resolvedBy = "visual_discovery";
                    sendLog(ws, "Using Claude (Visual Discovery) for step: Search gym in Gym Selector…", "info", sessionId);
                    await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                    await activePage.mouse.click(discovery.x, discovery.y);
                    await activePage.keyboard.type(resolvedValue, { delay: 50 });
                    await new Promise((r) => setTimeout(r, TYPEAHEAD_SETTLE_MS));
                    const stepScreenshot = await takeStepScreenshot(activePage);
                    sendLog(ws, "Visual Discovery fill performed (Gym Selector).", "info", sessionId);
                    stepDone({
                      success: true,
                      screenshot: stepScreenshot,
                      visualClick: true,
                      discoveryReason: discovery.reason,
                    });
                    done = true;
                    break;
                  }
                } catch (_) {}
              }
            }

            // Use Claude only when introspection map cannot find a ≥90% match (cost & scale constraint)
            let discoveryReasonFromIntro = null;
            if (!selector && intent && (resolvedAction === "click" || resolvedAction === "hover" || resolvedAction === "fill" || resolvedAction === "type")) {
              const withScore = findBestSelectorWithScore(snapshot, intent, resolvedAction === "type" ? "fill" : resolvedAction);
              if (withScore.normalizedScore >= INTROSPECTION_90_MATCH_THRESHOLD && withScore.selector) {
                selector = withScore.selector;
                discoveryReasonFromIntro = withScore.reasoning;
              }
            }
            if (!selector && intent && !parserHighConfidence && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
              let aiResult = null;
              try {
                sendLog(ws, "Using Claude (LLM) for step (fast paths failed).", "info", sessionId);
                aiResult = await getAiAction(intent, snapshot);
              } catch (_) {}
              if (aiResult && aiResult._provider === "claude") {
                resolvedBy = "claude";
              }
              if (aiResult && aiResult.action && aiResult.target) {
                // Never let LLM override submit_search or fill+search (parser or early intercept are correct)
                const instructionLower = (msg.instruction || "").toLowerCase();
                const isSearchSubmit = instructionLower.includes("search") && instructionLower.includes("button");
                const isSearchFill = /^search\s+/i.test(msg.instruction || "");
                if (!isSearchSubmit && !isSearchFill) {
                  resolvedAction = aiResult.action;
                  if (aiResult.value != null) resolvedValue = aiResult.value;
                  resolvedTarget = aiResult.target.trim();
                }
                const aiTarget = resolvedTarget;
                if (resolvedAction === "submit_search") {
                  selector = null;
                  resolvedTarget = "search";
                } else if (resolvedAction === "fill" || resolvedAction === "type") {
                  selector = findBestSelector(snapshot, aiTarget, resolvedAction);
                } else if (aiTarget.startsWith("[") || aiTarget.startsWith("#") || aiTarget.startsWith(".") || /^input|^button|^a\s/i.test(aiTarget)) {
                  selector = aiTarget;
                } else {
                  selector = findBestSelector(snapshot, aiTarget, resolvedAction);
                }
              }
            }

            // Apply parser result when we didn't use it yet (LLM failed or wasn't called)
            if (!selector || (!parserHighConfidence && parserResult)) {
              const parsedFirst = parserResult;
              if (parsedFirst && parsedFirst.action === "submit_search") {
                resolvedAction = "submit_search";
                resolvedTarget = "search";
                selector = null;
              }
              if (parsedFirst && (parsedFirst.action === "fill" || parsedFirst.action === "type") && (parsedFirst.target || parsedFirst.value)) {
                resolvedAction = parsedFirst.action;
                if (parsedFirst.value != null) resolvedValue = parsedFirst.value;
                if (parsedFirst.target != null) resolvedTarget = parsedFirst.target;
                const fillQuery = resolvedAction === "fill" && resolvedTarget === "gym" ? "search gym" : (resolvedTarget || "username");
                if (!selector) selector = findBestSelector(snapshot, fillQuery, resolvedAction);
              }
              if (parsedFirst && (parsedFirst.action === "click" || parsedFirst.action === "hover") && parsedFirst.target != null) {
                resolvedAction = parsedFirst.action;
                resolvedTarget = parsedFirst.target;
                if (!selector) selector = findBestSelector(snapshot, resolvedTarget, resolvedAction);
              }
              const looksLikeFill = hasInstruction && /enter|type|fill/i.test(msg.instruction) && (/\busername\b|\bpassword\b|\bemail\b|\bsearch\b/i.test(msg.instruction) || /@.*\./.test(msg.instruction));
              if (!selector && looksLikeFill && hasInstruction) {
                const emailMatch = msg.instruction.match(/[\w.-]+@[\w.-]+\.\w+/);
                const field = /\bpassword\b/i.test(msg.instruction) ? "password" : "username";
                resolvedAction = "fill";
                if (emailMatch) resolvedValue = emailMatch[0];
                resolvedTarget = field;
                selector = findBestSelector(snapshot, field, "fill");
              }
              if (!selector && hasInstruction && !parsedFirst) {
                const parsed = getCompiledActionSchema(msg.instruction);
                if (parsed && parsed.action && (parsed.target || parsed.value)) {
                  resolvedAction = parsed.action;
                  if (parsed.value != null) resolvedValue = parsed.value;
                  if (parsed.target != null) resolvedTarget = parsed.target;
                  selector = findBestSelector(snapshot, resolvedTarget, resolvedAction);
                }
              }
              if ((resolvedAction === "fill" || resolvedAction === "type") && hasInstruction) {
                const parsedFill = getCompiledActionSchema(msg.instruction);
                const fillOnlyTarget = parsedFill?.target || resolvedTarget || target;
                const fillQuery = (resolvedAction === "fill" || resolvedAction === "type") && fillOnlyTarget === "gym" ? "search gym" : fillOnlyTarget;
                const fillSelector = findBestSelector(snapshot, fillQuery, resolvedAction);
                if (fillSelector) selector = fillSelector;
              }
              if ((resolvedAction === "click" || resolvedAction === "hover") && (resolvedTarget || target)) {
                resolvedTarget = String(resolvedTarget || target).replace(/\s*dropdown\s*$/gi, "").trim() || resolvedTarget || target;
              }
              const lastResolvedTarget = resolvedTarget || target;
              const queryForFind = (t) => ((resolvedAction === "fill" || resolvedAction === "type") && t === "gym" ? "search gym" : t);
              if (!selector) selector = findBestSelector(snapshot, queryForFind(lastResolvedTarget) || lastResolvedTarget, resolvedAction);
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
                  const fallbackTarget = hasInstruction ? (getCompiledActionSchema(msg.instruction)?.target || resolvedTarget) : resolvedTarget;
                  selector = findBestSelector(snapshot, queryForFind(fallbackTarget || target || "username") || fallbackTarget || target || "username", resolvedAction);
                }
              }
            }
            if (resolvedAction === "click" && hasInstruction) {
              const c = (msg.instruction + " " + (resolvedTarget || target || "")).toLowerCase();
              if (c.includes("search") && c.includes("button")) {
                resolvedAction = "submit_search";
                resolvedTarget = "search";
                selector = null;
              }
            }
            if (resolvedAction === "submit_search") {
              let submitted = await submitSearchViaEnter(activePage);
              if (!submitted) {
                try {
                  await activePage.keyboard.press("Enter");
                  submitted = true;
                } catch (_) {}
              }
              if (!submitted) {
                const coords = await getVisualClickCoordinates(activePage, "search button");
                if (coords) {
                  try {
                    await highlightAtPointAndSendFrame(activePage, coords.x, coords.y, ws, sessionId);
                    resolvedBy = "visual_discovery";
                    await activePage.mouse.click(coords.x, coords.y);
                    submitted = true;
                  } catch (_) {}
                }
              }
              if (submitted) {
                lastError = null;
                sendLog(ws, "Step successful.", "info", sessionId);
                stepDone({ success: true });
                done = true;
                break;
              }
              sendLog(ws, "Trying Claude (Visual) for search/submit before failing…", "info", sessionId);
              const coordsSubmit = await getVisualClickCoordinates(activePage, "search button or submit search");
              if (coordsSubmit) {
                try {
                  await highlightAtPointAndSendFrame(activePage, coordsSubmit.x, coordsSubmit.y, ws, sessionId);
                  await activePage.mouse.click(coordsSubmit.x, coordsSubmit.y);
                  submitted = true;
                  lastError = null;
                  sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                } catch (_) {}
              }
              if (!submitted) {
                lastError = new Error("Search submit failed (Enter and visual fallback did not succeed).");
                stepDone({ success: false, error: userFacingMessage(lastError) });
                done = true;
                break;
              }
            }
            if (!selector) {
              const instr = (msg.instruction || "").trim();
              const targetStr = String(resolvedTarget || target || "").toLowerCase();
              const combined = `${instr} ${targetStr}`.toLowerCase();
              const isSearchButtonStep =
                resolvedAction === "click" &&
                (/\bsearch\s*button\b/.test(combined) || (combined.includes("search") && combined.includes("button")));
              if (isSearchButtonStep) {
                let submitted = await submitSearchViaEnter(activePage);
                if (!submitted) {
                  try {
                    await activePage.keyboard.press("Enter");
                    submitted = true;
                  } catch (_) {}
                }
                if (submitted) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
                sendLog(ws, "Trying Claude (Visual) for search button before failing…", "info", sessionId);
                const coordsSearchBtn = await getVisualClickCoordinates(activePage, "search button or submit");
                if (coordsSearchBtn) {
                  try {
                    await highlightAtPointAndSendFrame(activePage, coordsSearchBtn.x, coordsSearchBtn.y, ws, sessionId);
                    await activePage.mouse.click(coordsSearchBtn.x, coordsSearchBtn.y);
                    submitted = true;
                    lastError = null;
                    sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
                    stepDone({ success: true });
                    done = true;
                    break;
                  } catch (_) {}
                }
                if (!submitted) {
                  lastError = new Error("Search submit via Enter failed (e.g. popup blocking or search input not found).");
                  stepDone({ success: false, error: userFacingMessage(lastError) });
                  done = true;
                  break;
                }
              }
              const textTarget = resolvedTarget || target;
              if ((resolvedAction === "click" || resolvedAction === "hover") && textTarget) {
                // Fill-then-Select: wait for filtered list result, then click the list row (not the radio)
                if (resolvedAction === "click" && isGymListSelectionTarget(String(textTarget), msg.instruction)) {
                  const gymName = normalizeGymListTarget(String(textTarget));
                  const dialogVisible = await waitForSelectorDialog(activePage, 4000);
                  if (!dialogVisible) {
                    sendLog(ws, "Selector dialog not open; trying Visual Discovery.", "info", sessionId);
                  } else {
                    sendLog(ws, "Waiting for list result to appear…", "info", sessionId);
                    await waitForGymListResult(activePage, gymName, 6000);
                  }
                  let gymClickOk = dialogVisible && (await clickGymListItem(activePage, gymName, 5000));
                  if (!gymClickOk) {
                    sendLog(ws, "Trying Claude (Visual Discovery) for failed click (disambiguate if multiple)…", "info", sessionId);
                    const discovery = await getVisualDiscoveryResult(activePage, (msg.instruction || textTarget || "").trim(), { disambiguate: true });
                    if (discovery) {
                      try {
                        await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                        await activePage.mouse.click(discovery.x, discovery.y);
                        gymClickOk = true;
                        resolvedBy = "visual_discovery";
                        sendLog(ws, "Step successful (Visual Discovery).", "info", sessionId);
                        stepDone({ success: true, discoveryReason: discovery.reason });
                        done = true;
                        break;
                      } catch (_) {}
                    }
                  }
                  if (gymClickOk) {
                    lastError = null;
                    sendLog(ws, "Step successful (Gym Selector list).", "info", sessionId);
                    stepDone({ success: true });
                    done = true;
                    break;
                  }
                }
                let byTextOk = false;
                let visualClickUsed = false;
                try {
                  byTextOk = await clickOrHoverByText(activePage, String(textTarget), resolvedAction, { timeout: 5000 });
                } catch (e) {
                  const errMsg = (e && e.message) || "";
                  if (/assignment to constant|typeerror|reference error/i.test(errMsg) && resolvedAction === "click") {
                    const instructionOrTarget = (msg.instruction || textTarget || "").trim();
                    const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                    if (discovery) {
                      try {
                        await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                        await activePage.mouse.click(discovery.x, discovery.y);
                        byTextOk = true;
                        visualClickUsed = true;
                      } catch (_) {}
                    }
                    if (!byTextOk) {
                      sendLog(ws, "Trying LLM healing then Visual again (page script error path)…", "info", sessionId);
                      const instructionOrTarget = (msg.instruction || textTarget || "").trim();
                      const heal = await findAndRetry(activePage, instructionOrTarget, "click", String(textTarget || ""));
                      if (heal.success && heal.selector) {
                        try {
                          await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
                          byTextOk = true;
                          sendLog(ws, "Step successful (LLM rescue).", "info", sessionId);
                          stepDone({ success: true, selfHealed: true, aiHeal: true });
                          done = true;
                          break;
                        } catch (_) {}
                      }
                      if (!done) {
                        const discovery2 = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                        if (discovery2) {
                          try {
                            await highlightAtPointAndSendFrame(activePage, discovery2.x, discovery2.y, ws, sessionId);
                            await activePage.mouse.click(discovery2.x, discovery2.y);
                            byTextOk = true;
                            sendLog(ws, "Step successful (Visual retry).", "info", sessionId);
                            stepDone({ success: true, visualClick: true });
                            done = true;
                            break;
                          } catch (_) {}
                        }
                      }
                      if (!done) {
                        sendLog(ws, "Click failed (page script error). Visual fallback did not succeed.", "error", sessionId);
                        stepDone({ success: false, error: "Click failed (page script error). Visual fallback did not succeed." });
                        done = true;
                        break;
                      }
                    }
                  } else {
                    throw e;
                  }
                }
                if (!byTextOk) {
                  try {
                    const corrected = getTypoCorrectedTarget(String(textTarget));
                    if (corrected) byTextOk = await clickOrHoverByText(activePage, corrected, resolvedAction, { timeout: 5000 });
                  } catch (_) {}
                }
                if (!byTextOk && hasInstruction) {
                  try {
                    byTextOk = await tryLlmFallbackClickOrHover(activePage, snapshot, msg.instruction.trim(), resolvedAction);
                  } catch (_) {}
                }
                if (byTextOk) {
                  lastError = null;
                  if (visualClickUsed) resolvedBy = "visual_discovery";
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true, visualClick: visualClickUsed });
                  done = true;
                  break;
                }
              }
              if (!done && hasInstruction && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
                const heal = await findAndRetry(activePage, msg.instruction.trim(), resolvedAction, String(resolvedTarget || target));
                if (heal.success && heal.selector) {
                  try {
                    if (resolvedAction === "click") {
                      await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
                    } else if (resolvedAction === "hover") {
                      await waitForVisibleAndScroll(activePage, heal.selector);
                      await highlightElement(activePage, heal.selector);
                      await sendFrameNow(ws, activePage, sessionId);
                      await activePage.hover(heal.selector, { timeout: INTERACTION_CLICK_TIMEOUT_MS });
                    }
                    if (resolvedAction === "click" || resolvedAction === "hover") {
                      lastError = null;
                      sendLog(ws, "Step successful." + (heal.healed ? " (self-healed)" : ""), "info", sessionId);
                      stepDone({ success: true, selfHealed: !!heal.healed, aiHeal: !!heal.healed });
                      done = true;
                      break;
                    }
                  } catch (_) {
                    // healed selector failed
                  }
                }
                if (!done && (heal.expectedElement != null || heal.actualPageContent != null)) {
                  sendLog(ws, "Trying Claude (Visual) one more time before ambiguity failure…", "info", sessionId);
                  const instructionForVisual = (msg.instruction || resolvedTarget || target || "").trim();
                  const discoveryAmb = await getVisualDiscoveryResult(activePage, instructionForVisual, { disambiguate: true });
                  if (discoveryAmb) {
                    try {
                      await highlightAtPointAndSendFrame(activePage, discoveryAmb.x, discoveryAmb.y, ws, sessionId);
                      if (resolvedAction === "click") {
                        await activePage.mouse.click(discoveryAmb.x, discoveryAmb.y);
                      } else if (resolvedAction === "hover") {
                        await activePage.mouse.move(discoveryAmb.x, discoveryAmb.y);
                      }
                      lastError = null;
                      sendLog(ws, "Step successful (Visual rescue before ambiguity).", "info", sessionId);
                      stepDone({ success: true, visualClick: resolvedAction === "click" });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                  if (!done) {
                    const errMsg = `No element matched "${resolvedTarget || target}" (attempt ${attempt}/${MAX_FIND_ATTEMPTS})`;
                    lastError = new Error(errMsg);
                    const stepScreenshot = await takeStepScreenshot(activePage);
                    sendLog(ws, `Step failed: ${errMsg}`, "error", sessionId);
                    stepDone({
                      success: false,
                      screenshot: stepScreenshot,
                      message: errMsg,
                      expectedElement: heal.expectedElement,
                      actualPageContent: heal.actualPageContent,
                    });
                    send(ws, "ambiguity_error", {
                      sessionId,
                      message: errMsg,
                      target: resolvedTarget ?? target,
                      screenshot: stepScreenshot,
                      expectedElement: heal.expectedElement,
                      actualPageContent: heal.actualPageContent,
                    });
                    return;
                  }
                }
              }
              lastError = new Error(`No element matched "${resolvedTarget || target}" (attempt ${attempt}/${MAX_FIND_ATTEMPTS})`);
              continue;
            }
            if (resolvedAction === "click") {
              // Fill-then-Select: wait for filtered list result, then prefer dialog list row over selector
              const gymListTarget = resolvedTarget || target;
              if (resolvedAction === "click" && gymListTarget && isGymListSelectionTarget(String(gymListTarget), msg.instruction)) {
                const gymName = normalizeGymListTarget(String(gymListTarget));
                const dialogVisible = await waitForSelectorDialog(activePage, 4000);
                if (!dialogVisible) {
                  sendLog(ws, "Selector dialog not open; trying Visual Discovery.", "info", sessionId);
                } else {
                  sendLog(ws, "Waiting for list result to appear…", "info", sessionId);
                  await waitForGymListResult(activePage, gymName, 6000);
                }
                let gymClickOk = dialogVisible && (await clickGymListItem(activePage, gymName, 5000));
                if (!gymClickOk) {
                  sendLog(ws, "Trying Claude (Visual Discovery) for failed click (disambiguate if multiple)…", "info", sessionId);
                  const discovery = await getVisualDiscoveryResult(activePage, (msg.instruction || gymListTarget || "").trim(), { disambiguate: true });
                  if (discovery) {
                    try {
                      await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                      await activePage.mouse.click(discovery.x, discovery.y);
                      gymClickOk = true;
                      resolvedBy = "visual_discovery";
                      sendLog(ws, "Step successful (Visual Discovery).", "info", sessionId);
                      stepDone({ success: true, discoveryReason: discovery.reason });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                }
                if (gymClickOk) {
                  lastError = null;
                  sendLog(ws, "Step successful (Gym Selector list).", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
              }
              const instr = (msg.instruction || "").trim();
              const targetStr = String(resolvedTarget || target || "").toLowerCase();
              const combined = `${instr} ${targetStr}`.toLowerCase();
              const isSearchButtonStep =
                /\bsearch\s*button\b/.test(combined) || (combined.includes("search") && combined.includes("button"));
              const selectorLooksLikeSearchSubmit =
                selector && (/nav-search-submit|search-submit|searchbar.*submit|submit.*search|magnifying|twotabsearch/i.test(selector));
              if (isSearchButtonStep || selectorLooksLikeSearchSubmit) {
                let submitted = await submitSearchViaEnter(activePage);
                if (!submitted) {
                  try {
                    await activePage.keyboard.press("Enter");
                    submitted = true;
                  } catch (_) {
                    // focus may not be in search field
                  }
                }
                if (submitted) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
                if (isSearchButtonStep || selectorLooksLikeSearchSubmit) {
                  sendLog(ws, "Trying Claude (Visual) for search/submit before failing…", "info", sessionId);
                  const coordsV = await getVisualClickCoordinates(activePage, "search button or submit");
                  if (coordsV) {
                    try {
                      await highlightAtPointAndSendFrame(activePage, coordsV.x, coordsV.y, ws, sessionId);
                      await activePage.mouse.click(coordsV.x, coordsV.y);
                      lastError = null;
                      sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
                      stepDone({ success: true });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                  lastError = new Error("Search submit via Enter failed (e.g. popup blocking or search input not found).");
                  stepDone({ success: false, error: userFacingMessage(lastError) });
                  done = true;
                  break;
                }
              }
              const instrForGuard = (msg.instruction || "").trim().toLowerCase();
              const targetForGuard = String(resolvedTarget || target || "").toLowerCase();
              const isSearchButtonByWording = (instrForGuard.includes("search") && instrForGuard.includes("button")) || (targetForGuard.includes("search") && targetForGuard.includes("button"));
              if (resolvedAction === "click" && isSearchButtonByWording) {
                let submitted = await submitSearchViaEnter(activePage);
                if (!submitted) {
                  try {
                    await activePage.keyboard.press("Enter");
                    submitted = true;
                  } catch (_) {}
                }
                if (submitted) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
                sendLog(ws, "Trying Claude (Visual) for search button before failing…", "info", sessionId);
                const coordsV2 = await getVisualClickCoordinates(activePage, "search button or submit");
                if (coordsV2) {
                  try {
                    await highlightAtPointAndSendFrame(activePage, coordsV2.x, coordsV2.y, ws, sessionId);
                    await activePage.mouse.click(coordsV2.x, coordsV2.y);
                    lastError = null;
                    sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
                    stepDone({ success: true });
                    done = true;
                    break;
                  } catch (_) {}
                }
                lastError = new Error("Search submit via Enter failed (e.g. popup blocking or search input not found).");
                stepDone({ success: false, error: userFacingMessage(lastError) });
                done = true;
                break;
              }
              try {
                const urlBeforeClick = activePage.url();
                await clickWithVisibleOrForce(activePage, selector, { ws, sessionId });
                await waitForStability(activePage, { urlBefore: urlBeforeClick });
              } catch (clickErr) {
                const textTarget = resolvedTarget || target;
                const errMsg = (clickErr && clickErr.message) || "";
                const isSearchScriptError = /assignment to constant|typeerror|reference error/i.test(errMsg);
                const targetLooksLikeSearchButton = /\bsearch\s*button\b/i.test(String(textTarget || "")) || (/search/i.test(String(msg.instruction || "")) && /button/i.test(String(msg.instruction || "")));
                if (isSearchScriptError && targetLooksLikeSearchButton) {
                  let submitted = await submitSearchViaEnter(activePage);
                  if (!submitted) {
                    try {
                      await activePage.keyboard.press("Enter");
                      submitted = true;
                    } catch (_) {}
                  }
                  if (submitted) {
                    lastError = null;
                    sendLog(ws, "Step successful (search via Enter after script error).", "info", sessionId);
                    stepDone({ success: true });
                    done = true;
                    break;
                  }
                  sendLog(ws, "Trying Claude (Visual) for search button before failing…", "info", sessionId);
                  const coordsV3 = await getVisualClickCoordinates(activePage, "search button or submit");
                  if (coordsV3) {
                    try {
                      await highlightAtPointAndSendFrame(activePage, coordsV3.x, coordsV3.y, ws, sessionId);
                      await activePage.mouse.click(coordsV3.x, coordsV3.y);
                      lastError = null;
                      sendLog(ws, "Step successful (Visual rescue).", "info", sessionId);
                      stepDone({ success: true });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                  lastError = new Error("Search submit via Enter failed (e.g. popup blocking or search input not found).");
                  sendLog(ws, lastError.message, "error", sessionId);
                  stepDone({ success: false, error: userFacingMessage(lastError) });
                  done = true;
                  break;
                }
                if (isSearchScriptError) {
                  const instructionOrTarget = (msg.instruction || textTarget || "").trim();
                  const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                  if (discovery) {
                    try {
                      const selFromPoint = await getSelectorForPoint(activePage, discovery.x, discovery.y);
                      if (selFromPoint) setCachedSelector(msg.instruction.trim(), "click", stepPageUrl, selFromPoint);
                      await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                      resolvedBy = "visual_discovery";
                      await activePage.mouse.click(discovery.x, discovery.y);
                      lastError = null;
                      sendLog(ws, "Step successful (visual click after script error).", "info", sessionId);
                      stepDone({ success: true, visualClick: true });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                  if (!done) {
                    sendLog(ws, "Trying LLM healing then Visual again (selector click script error)…", "info", sessionId);
                    const healClick = await findAndRetry(activePage, (msg.instruction || textTarget || "").trim(), "click", String(textTarget || ""));
                    if (healClick.success && healClick.selector) {
                      try {
                        await clickWithVisibleOrForce(activePage, healClick.selector, { ws, sessionId });
                        lastError = null;
                        sendLog(ws, "Step successful (LLM rescue).", "info", sessionId);
                        stepDone({ success: true, selfHealed: true, aiHeal: true });
                        done = true;
                        break;
                      } catch (_) {}
                    }
                    if (!done) {
                      const discoveryRetry = await getVisualDiscoveryResult(activePage, (msg.instruction || textTarget || "").trim(), { disambiguate: true });
                      if (discoveryRetry) {
                        try {
                          await highlightAtPointAndSendFrame(activePage, discoveryRetry.x, discoveryRetry.y, ws, sessionId);
                          await activePage.mouse.click(discoveryRetry.x, discoveryRetry.y);
                          lastError = null;
                          sendLog(ws, "Step successful (Visual retry).", "info", sessionId);
                          stepDone({ success: true, visualClick: true });
                          done = true;
                          break;
                        } catch (_) {}
                      }
                    }
                    if (!done) {
                      lastError = new Error("Click failed (page script error). Visual fallback did not succeed.");
                      sendLog(ws, lastError.message, "error", sessionId);
                      stepDone({ success: false, error: userFacingMessage(lastError) });
                      done = true;
                      break;
                    }
                  }
                }
                let byTextOk = textTarget && (await clickOrHoverByText(activePage, String(textTarget), "click", { timeout: 5000 }));
                if (!byTextOk && textTarget) {
                  const corrected = getTypoCorrectedTarget(String(textTarget));
                  if (corrected) byTextOk = await clickOrHoverByText(activePage, corrected, "click", { timeout: 5000 });
                }
                if (!byTextOk && hasInstruction && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
                  byTextOk = await tryLlmFallbackClickOrHover(activePage, snapshot, msg.instruction.trim(), "click");
                }
                if (!byTextOk && hasInstruction && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
                  const heal = await findAndRetry(activePage, msg.instruction.trim(), "click", String(textTarget || resolvedTarget || target));
                  if (heal.success && heal.selector) {
                    if (/\bsearch\s*button\b|nav-search-submit|search-submit/i.test(String(heal.selector))) {
                      const submitted = await submitSearchViaEnter(activePage);
                      if (submitted) {
                        lastError = null;
                        sendLog(ws, "Step successful." + (heal.healed ? " (self-healed)" : ""), "info", sessionId);
                        stepDone({ success: true, selfHealed: !!heal.healed, aiHeal: !!heal.healed });
                        done = true;
                        break;
                      }
                    }
                    try {
                      await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
                      lastError = null;
                      sendLog(ws, "Step successful." + (heal.healed ? " (self-healed)" : ""), "info", sessionId);
                      stepDone({ success: true, selfHealed: !!heal.healed, aiHeal: !!heal.healed });
                      done = true;
                      break;
                    } catch (_) {
                      // healed selector failed
                    }
                  }
                }
                if (byTextOk) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
                throw clickErr;
              }
            } else if (resolvedAction === "hover") {
              try {
                await waitForVisibleAndScroll(activePage, selector);
                await highlightElement(activePage, selector);
                await sendFrameNow(ws, activePage, sessionId);
                await activePage.hover(selector, { timeout: INTERACTION_CLICK_TIMEOUT_MS });
              } catch (hoverErr) {
                if (isPageScriptError(hoverErr)) {
                  const instructionOrTarget = (msg.instruction || resolvedTarget || target || "").trim();
                  const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                  if (discovery) {
                    try {
                      resolvedBy = "visual_discovery";
                      await activePage.mouse.move(discovery.x, discovery.y);
                      lastError = null;
                      sendLog(ws, "Step successful (visual hover).", "info", sessionId);
                      stepDone({ success: true, visualClick: true });
                      done = true;
                      break;
                    } catch (_) {}
                  }
                  if (!done) {
                    lastError = new Error(userFacingMessage(hoverErr));
                    sendLog(ws, lastError.message, "error", sessionId);
                    stepDone({ success: false, error: userFacingMessage(lastError) });
                    done = true;
                    break;
                  }
                }
                const textTarget = resolvedTarget || target;
                let byTextOk = textTarget && (await clickOrHoverByText(activePage, String(textTarget), "hover", { timeout: 5000 }));
                if (!byTextOk && textTarget) {
                  const corrected = getTypoCorrectedTarget(String(textTarget));
                  if (corrected) byTextOk = await clickOrHoverByText(activePage, corrected, "hover", { timeout: 5000 });
                }
                if (!byTextOk && hasInstruction && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
                  byTextOk = await tryLlmFallbackClickOrHover(activePage, snapshot, msg.instruction.trim(), "hover");
                }
                if (!byTextOk && hasInstruction && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
                  const heal = await findAndRetry(activePage, msg.instruction.trim(), "hover", String(textTarget || resolvedTarget || target));
                  if (heal.success && heal.selector) {
                    try {
                      await waitForVisibleAndScroll(activePage, heal.selector);
                      await highlightElement(activePage, heal.selector);
                      await activePage.hover(heal.selector, { timeout: INTERACTION_CLICK_TIMEOUT_MS });
                      lastError = null;
                      sendLog(ws, "Step successful." + (heal.healed ? " (self-healed)" : ""), "info", sessionId);
                      stepDone({ success: true, selfHealed: !!heal.healed, aiHeal: !!heal.healed });
                      done = true;
                      break;
                    } catch (_) {
                      // healed selector failed
                    }
                  }
                }
                if (byTextOk) {
                  lastError = null;
                  sendLog(ws, "Step successful.", "info", sessionId);
                  stepDone({ success: true });
                  done = true;
                  break;
                }
                throw hoverErr;
              }
            } else if (resolvedAction === "type" || resolvedAction === "fill") {
              const fillTargetQuery = resolvedTarget === "gym" ? "search gym" : (resolvedTarget || "username");
              let finalSelector = findBestSelector(snapshot, fillTargetQuery, "fill");
              if (!finalSelector) finalSelector = findBestSelector(snapshot, "email", "fill");
              if (!finalSelector) finalSelector = selector;
              try {
                const tag = await activePage.locator(finalSelector).evaluate((el) => (el ? (el.tagName || "").toLowerCase() : ""));
                if (tag !== "input" && tag !== "textarea") {
                  finalSelector = findBestSelector(snapshot, resolvedTarget === "gym" ? "search gym" : "username", "fill") || findBestSelector(snapshot, "email", "fill");
                }
              } catch (_) {}
              if (!finalSelector) throw new Error("No fillable input found for " + (resolvedTarget === "gym" ? "gym search" : "username/email"));
              const isPassword =
                /password/.test(String(resolvedTarget || "").toLowerCase()) ||
                /password/.test(String(msg.instruction || "").toLowerCase());
              if (isPassword && resolvedValue) {
                await waitForVisibleAndScroll(activePage, finalSelector);
                await highlightElement(activePage, finalSelector);
                await sendFrameNow(ws, activePage, sessionId);
                await activePage.locator(finalSelector).focus();
                await activePage.locator(finalSelector).pressSequentially(resolvedValue, { delay: 60 });
              } else {
                // For search-type steps, wait after fill so typeahead dropdown can filter before "Select X"
                const isSearchStep =
                  String(resolvedTarget || "").toLowerCase() === "search" ||
                  String(resolvedTarget || "").toLowerCase() === "gym" ||
                  /search\s+gym|search\s+for|search\s+club/i.test(String(msg.instruction || ""));
                await fillWithVisibleWait(activePage, finalSelector, resolvedValue, {
                  waitAfterMs: isSearchStep ? TYPEAHEAD_SETTLE_MS : 0,
                  ws,
                  sessionId,
                });
              }
            } else if (resolvedAction === "press") {
              await waitForVisibleAndScroll(activePage, selector);
              await highlightElement(activePage, selector);
              await sendFrameNow(ws, activePage, sessionId);
              await activePage.press(selector, msg.key || "Enter");
            }
            lastError = null;
            const actionForCache = resolvedAction === "type" ? "fill" : resolvedAction;
            if (selector && (actionForCache === "click" || actionForCache === "hover" || actionForCache === "fill")) {
              setCachedSelector(msg.instruction.trim(), actionForCache, stepPageUrl, selector);
            }
            const stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({
              success: true,
              screenshot: stepScreenshot,
              ...(discoveryReasonFromIntro ? { discoveryReason: discoveryReasonFromIntro } : {}),
            });
            done = true;
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (!done && lastError) {
          // LLM fallback: reinterpret instruction for different phrasings and situations (millions of users, millions of ways)
          const hasRetryIntent = hasInstruction || action || target;
          if (hasRetryIntent && (Date.now() - stepStartTime >= AI_FALLBACK_DELAY_MS)) {
            try {
              const freshSnapshot = await activePage.evaluate(getDomSnapshotInPage);
              const retryIntent = hasInstruction ? msg.instruction.trim() : [action, target, msg.value].filter(Boolean).join(" ").trim();
              if (!retryIntent) throw new Error("No intent");
              sendLog(ws, "Trying Claude (LLM) fallback…", "info", sessionId);
              const aiResult = await getAiAction(retryIntent, freshSnapshot);
              if (aiResult && aiResult.action && aiResult.target) {
                const provider = aiResult._provider || "AI";
                sendLog(ws, `LLM (${provider}) suggested: ${aiResult.action} "${(aiResult.target || "").slice(0, 40)}…"`, "info", sessionId);
                if (aiResult._provider === "claude") resolvedBy = "claude";
                else if (aiResult._provider === "claude") resolvedBy = "claude";
                const aiTarget = String(aiResult.target).trim();
                const aiValue = aiResult.value != null ? String(aiResult.value) : (resolvedValue || "");
                if (aiResult.action === "click" || aiResult.action === "hover") {
                  const act = aiResult.action === "hover" ? "hover" : "click";
                  let ok = false;
                  if (act === "click" && isGymListSelectionTarget(aiTarget, msg.instruction)) {
                    await waitForGymListResult(activePage, normalizeGymListTarget(aiTarget), 4000);
                    ok = await clickGymListItem(activePage, normalizeGymListTarget(aiTarget), 5000);
                  }
                  if (!ok) ok = await clickOrHoverByText(activePage, aiTarget, act, { timeout: 5000 });
                  if (ok) {
                    lastError = null;
                    sendLog(ws, "Step successful (LLM suggestion).", "info", sessionId);
                    stepDone({ success: true });
                    done = true;
                  }
                } else if ((aiResult.action === "fill" || aiResult.action === "type") && (aiTarget || aiValue)) {
                  const fillSelector = findBestSelector(freshSnapshot, aiTarget || "search", "fill");
                  if (fillSelector) {
                    try {
                      await fillWithVisibleWait(activePage, fillSelector, aiValue, { timeout: 5000, ws, sessionId });
                      lastError = null;
                      sendLog(ws, "Step successful (LLM suggestion).", "info", sessionId);
                      stepDone({ success: true });
                      done = true;
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          // AI Visual Discovery fallback when semantic/selector path failed (generic: works for gym, region, store, or any selector with duplicate text)
          if (!done && resolvedAction === "click") {
            try {
              const instructionOrTarget = (hasInstruction ? msg.instruction.trim() : (resolvedTarget ?? target)) || "search button";
              sendLog(ws, "Trying Claude (Visual Discovery) for failed click (disambiguate if multiple)…", "info", sessionId);
              const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
              if (discovery) {
                const selFromPoint = await getSelectorForPoint(activePage, discovery.x, discovery.y);
                if (selFromPoint) setCachedSelector(msg.instruction.trim(), "click", stepPageUrl, selFromPoint);
                resolvedBy = "visual_discovery";
                sendLog(ws, `Using Claude (Visual Discovery) for step: ${(instructionOrTarget || "").slice(0, 50)}…`, "info", sessionId);
                await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                const urlBefore = activePage.url();
                await activePage.mouse.click(discovery.x, discovery.y);
                lastError = null;
                const validationPassed = await validateAfterClick(activePage, urlBefore);
                const stepScreenshot = await takeStepScreenshot(activePage);
                sendLog(ws, "Visual Discovery click performed.", "info", sessionId);
                stepDone({
                  success: true,
                  screenshot: stepScreenshot,
                  visualClick: true,
                  discoveryReason: discovery.reason,
                  validationPassed,
                });
                done = true;
              }
            } catch (visualErr) {
              sendLog(ws, `Visual Discovery failed: ${visualErr.message}`, "warn", sessionId);
            }
          } else if ((resolvedAction === "fill" || resolvedAction === "type") && resolvedValue) {
            // Visual fallback for fill/search: find input by screenshot, click to focus, type value
            try {
              const fillInstruction =
                hasInstruction ? msg.instruction.trim() : `Search or input field for ${resolvedTarget || "text"}`;
              const discovery = await getVisualDiscoveryResult(activePage, fillInstruction);
              if (discovery) {
                const selFromPoint = await getSelectorForPoint(activePage, discovery.x, discovery.y);
                if (selFromPoint) setCachedSelector(msg.instruction.trim(), "fill", stepPageUrl, selFromPoint);
                resolvedBy = "visual_discovery";
                sendLog(ws, `Using Claude (Visual Discovery) for step: ${(fillInstruction || "").slice(0, 50)}…`, "info", sessionId);
                await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                await activePage.mouse.click(discovery.x, discovery.y);
                await activePage.keyboard.type(resolvedValue, { delay: 50 });
                const isSearchStep =
                  String(resolvedTarget || "").toLowerCase() === "search" ||
                  String(resolvedTarget || "").toLowerCase() === "gym" ||
                  /search\s+gym|search\s+for|search\s+club/i.test(String(msg.instruction || ""));
                if (isSearchStep) await new Promise((r) => setTimeout(r, TYPEAHEAD_SETTLE_MS));
                lastError = null;
                const stepScreenshot = await takeStepScreenshot(activePage);
                sendLog(ws, "Visual Discovery fill performed.", "info", sessionId);
                stepDone({
                  success: true,
                  screenshot: stepScreenshot,
                  visualClick: true,
                  discoveryReason: discovery.reason,
                });
                done = true;
              }
            } catch (visualErr) {
              sendLog(ws, `Visual Discovery fill failed: ${visualErr.message}`, "warn", sessionId);
            }
          }
          if (!done) {
            let screenshotBase64 = null;
            try {
              const buf = await activePage.screenshot({ type: "png" });
              screenshotBase64 = buf.toString("base64");
            } catch (_) {}
            let actualPageContent = "";
            try {
              const interactive = await activePage.evaluate(getInteractiveSubtreeInPage);
              actualPageContent = domSanitizer(interactive.html || "").slice(0, MAX_ACTUAL_PAGE_CONTENT_CHARS);
            } catch (_) {}
            const expectedElement = hasInstruction ? msg.instruction.trim() : (resolvedTarget ?? target);
            const failureMsg = userFacingMessage(lastError);
            sendLog(ws, `Step failed: ${failureMsg}`, "error", sessionId);
            stepDone({
              success: false,
              screenshot: screenshotBase64,
              message: failureMsg,
              expectedElement: expectedElement || undefined,
              actualPageContent: actualPageContent || undefined,
            });
            const errTarget = resolvedTarget ?? target;
            send(ws, "ambiguity_error", {
              sessionId,
              message: failureMsg || `Could not find or interact with "${errTarget}" after ${MAX_FIND_ATTEMPTS} attempts.`,
              target: errTarget,
              screenshot: screenshotBase64,
              expectedElement: expectedElement || undefined,
              actualPageContent: actualPageContent || undefined,
            });
            send(ws, "test_error", { sessionId, message: failureMsg, screenshot: screenshotBase64 });
          }
        }
      } else if (selector || action === "navigate" || action === "wait") {
        try {
          let stepScreenshot = null;
          if (action === "click" && selector) {
            try {
              await clickWithVisibleOrForce(activePage, selector, { ws, sessionId });
            } catch (clickE) {
              const errMsg = (clickE && clickE.message) || "";
              if (/assignment to constant|typeerror|reference error/i.test(errMsg)) {
                const instructionOrTarget = (msg.instruction || msg.target || "").trim();
                const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                if (discovery) {
                  try {
                    const selFromPoint = await getSelectorForPoint(activePage, discovery.x, discovery.y);
                    if (selFromPoint) setCachedSelector(msg.instruction.trim(), "click", stepPageUrl, selFromPoint);
                    resolvedBy = "visual_discovery";
                sendLog(ws, `Using Claude (Visual Discovery) for step: ${(instructionOrTarget || "").slice(0, 50)}…`, "info", sessionId);
                await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                const urlBefore = activePage.url();
                await activePage.mouse.click(discovery.x, discovery.y);
                const validationPassed = await validateAfterClick(activePage, urlBefore);
                    stepScreenshot = await takeStepScreenshot(activePage);
                    sendLog(ws, "Step successful (Visual Discovery).", "info", sessionId);
                    stepDone({
                      success: true,
                      screenshot: stepScreenshot,
                      visualClick: true,
                      discoveryReason: discovery.reason,
                      validationPassed,
                    });
                    done = true;
                  } catch (_) {}
                }
                if (!done) {
                  const instructionOrTarget = (msg.instruction || msg.target || "").trim();
                  sendLog(ws, "Trying LLM healing then Visual as final rescue…", "info", sessionId);
                  const healFinal = await findAndRetry(activePage, instructionOrTarget, "click", instructionOrTarget);
                  if (healFinal.success && healFinal.selector) {
                    try {
                      await clickWithVisibleOrForce(activePage, healFinal.selector, { ws, sessionId });
                      resolvedBy = "claude";
                      stepScreenshot = await takeStepScreenshot(activePage);
                      sendLog(ws, "Step successful (LLM final rescue).", "info", sessionId);
                      stepDone({ success: true, screenshot: stepScreenshot, selfHealed: true, aiHeal: true });
                      done = true;
                    } catch (_) {}
                  }
                  if (!done) {
                    const discovery = await getVisualDiscoveryResult(activePage, instructionOrTarget, { disambiguate: true });
                    if (discovery) {
                      try {
                        await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                        await activePage.mouse.click(discovery.x, discovery.y);
                        resolvedBy = "visual_discovery";
                        stepScreenshot = await takeStepScreenshot(activePage);
                        sendLog(ws, "Step successful (Claude Visual final rescue).", "info", sessionId);
                        stepDone({ success: true, screenshot: stepScreenshot, visualClick: true });
                        done = true;
                      } catch (_) {}
                    }
                  }
                  if (!done) {
                    sendLog(ws, "Click failed (page script error). Visual fallback did not succeed.", "error", sessionId);
                    stepDone({ success: false, error: "Click failed (page script error). Visual fallback did not succeed." });
                    done = true;
                  }
                }
              } else {
                throw clickE;
              }
            }
            if (!done) {
              stepScreenshot = await takeStepScreenshot(activePage);
              sendLog(ws, "Step successful.", "info", sessionId);
              stepDone({ success: true, screenshot: stepScreenshot });
              done = true;
            }
          } else if ((action === "type" || action === "fill") && selector) {
            await fillWithVisibleWait(activePage, selector, msg.text ?? msg.value ?? "", { ws, sessionId });
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true, screenshot: stepScreenshot });
          } else if (action === "navigate" && msg.url) {
            await gotoWithAbortHandling(activePage, msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true, screenshot: stepScreenshot });
          } else if (action === "press" && selector) {
            await highlightElement(activePage, selector);
            await sendFrameNow(ws, activePage, sessionId);
            await activePage.press(selector, msg.key || "Enter");
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true, screenshot: stepScreenshot });
          } else if (action === "wait") {
            const ms = typeof msg.value === "number" ? msg.value : 1000;
            await new Promise((r) => setTimeout(r, ms));
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true, screenshot: stepScreenshot });
          } else {
            stepScreenshot = await takeStepScreenshot(activePage);
            sendLog(ws, "Step successful.", "info", sessionId);
            stepDone({ success: true, screenshot: stepScreenshot });
          }
          done = true;
        } catch (e) {
          const instruction = (msg.instruction || "").trim() || [msg.action, msg.target].filter(Boolean).join(" ");
          const lastResortAction = (msg.action === "fill" || msg.action === "type") ? "fill" : "click";
          const lastResortTarget = msg.target || instruction;
          if (instruction && lastResortTarget) {
            sendLog(ws, "Trying LLM healing after selector error…", "info", sessionId);
            const heal = await findAndRetry(activePage, instruction, lastResortAction, String(lastResortTarget));
            if (heal.success && heal.selector) {
              try {
                if (lastResortAction === "click") {
                  await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
                } else {
                  await fillWithVisibleWait(activePage, heal.selector, msg.value ?? msg.text ?? "", { ws, sessionId });
                }
                sendLog(ws, "Step successful (LLM healing).", "info", sessionId);
                resolvedBy = "claude";
                stepDone({ success: true, selfHealed: true, aiHeal: true, screenshot: await takeStepScreenshot(activePage) });
                done = true;
              } catch (_) {}
            }
            if (!done) {
              sendLog(ws, "Trying Claude (Visual) as final rescue…", "info", sessionId);
              const discovery = await getVisualDiscoveryResult(activePage, instruction, { disambiguate: true });
              if (discovery) {
                try {
                  await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                  await activePage.mouse.click(discovery.x, discovery.y);
                  if (lastResortAction === "fill") {
                    await new Promise((r) => setTimeout(r, 200));
                    await activePage.keyboard.type(String(msg.value ?? msg.text ?? "").trim(), { delay: 40 });
                  }
                  resolvedBy = "visual_discovery";
                  sendLog(ws, "Step successful (Claude Visual final rescue).", "info", sessionId);
                  stepDone({ success: true, visualClick: true, screenshot: await takeStepScreenshot(activePage) });
                  done = true;
                } catch (_) {}
              }
            }
          }
          if (!done) {
            let screenshotBase64 = null;
            try {
              const buf = await activePage.screenshot({ type: "png" });
              screenshotBase64 = buf.toString("base64");
            } catch (_) {}
            const errMsg = userFacingMessage(e);
            sendLog(ws, `Step failed: ${errMsg}`, "error", sessionId);
            stepDone({ success: false, screenshot: screenshotBase64, failureType: stepFailureType });
            send(ws, "error", { sessionId, message: errMsg });
            send(ws, "test_error", { sessionId, message: errMsg, screenshot: screenshotBase64 });
          }
        }
      } else if (!done) {
        const instruction = (msg.instruction || "").trim() || [msg.action, msg.target].filter(Boolean).join(" ");
        const lastResortAction = (msg.action === "fill" || msg.action === "type") ? "fill" : "click";
        const lastResortTarget = msg.target || instruction;
        const isVerify = parsedEarly && parsedEarly.action === "verify_displayed";
        if (instruction && lastResortTarget && !isVerify) {
          sendLog(ws, "Trying LLM healing before failing step…", "info", sessionId);
          const heal = await findAndRetry(activePage, instruction, lastResortAction, String(lastResortTarget));
          if (heal.success && heal.selector) {
            try {
              if (lastResortAction === "click") {
                await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
              } else {
                await fillWithVisibleWait(activePage, heal.selector, msg.value ?? msg.text ?? "", { ws, sessionId });
              }
              sendLog(ws, "Step successful (LLM healing).", "info", sessionId);
              resolvedBy = "claude";
              stepDone({ success: true, selfHealed: true, aiHeal: true, screenshot: await takeStepScreenshot(activePage) });
              done = true;
            } catch (_) {}
          }
          if (!done) {
            sendLog(ws, "Trying Claude (Visual) as final rescue…", "info", sessionId);
            const discovery = await getVisualDiscoveryResult(activePage, instruction, { disambiguate: true });
            if (discovery) {
              try {
                await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
                await activePage.mouse.click(discovery.x, discovery.y);
                if (lastResortAction === "fill") {
                  await new Promise((r) => setTimeout(r, 200));
                  await activePage.keyboard.type(String(msg.value ?? msg.text ?? "").trim(), { delay: 40 });
                }
                resolvedBy = "visual_discovery";
                sendLog(ws, "Step successful (Claude Visual final rescue).", "info", sessionId);
                stepDone({ success: true, visualClick: true, screenshot: await takeStepScreenshot(activePage) });
                done = true;
              } catch (_) {}
            }
          }
        }
        if (!done) {
          let screenshotBase64 = null;
          try {
            const buf = await activePage.screenshot({ type: "png" });
            screenshotBase64 = buf.toString("base64");
          } catch (_) {}
          const errMsg = "Step could not be executed: no matching element or action resolved.";
          sendLog(ws, `Step failed: ${errMsg}`, "error", sessionId);
          stepDone({ success: false, screenshot: screenshotBase64, failureType: stepFailureType });
        }
      }
    } catch (err) {
      const instruction = (msg.instruction || "").trim() || [msg.action, msg.target].filter(Boolean).join(" ");
      const lastResortAction = (msg.action === "fill" || msg.action === "type") ? "fill" : "click";
      const lastResortTarget = msg.target || instruction;
      const isVerify = parsedEarly && parsedEarly.action === "verify_displayed";
      if (instruction && lastResortTarget && !isVerify) {
        sendLog(ws, "Trying LLM healing after error…", "info", sessionId);
        const heal = await findAndRetry(activePage, instruction, lastResortAction, String(lastResortTarget));
        if (heal.success && heal.selector) {
          try {
            if (lastResortAction === "click") {
              await clickWithVisibleOrForce(activePage, heal.selector, { ws, sessionId });
            } else {
              await fillWithVisibleWait(activePage, heal.selector, msg.value ?? msg.text ?? "", { ws, sessionId });
            }
            sendLog(ws, "Step successful (LLM healing after error).", "info", sessionId);
            resolvedBy = "claude";
            stepDone({ success: true, selfHealed: true, aiHeal: true, screenshot: await takeStepScreenshot(activePage) });
            done = true;
          } catch (_) {}
        }
        if (!done) {
          sendLog(ws, "Trying Claude (Visual) as final rescue…", "info", sessionId);
          const discovery = await getVisualDiscoveryResult(activePage, instruction, { disambiguate: true });
          if (discovery) {
            try {
              await highlightAtPointAndSendFrame(activePage, discovery.x, discovery.y, ws, sessionId);
              await activePage.mouse.click(discovery.x, discovery.y);
              if (lastResortAction === "fill") {
                await new Promise((r) => setTimeout(r, 200));
                await activePage.keyboard.type(String(msg.value ?? msg.text ?? "").trim(), { delay: 40 });
              }
              resolvedBy = "visual_discovery";
              sendLog(ws, "Step successful (Claude Visual final rescue).", "info", sessionId);
              stepDone({ success: true, visualClick: true, screenshot: await takeStepScreenshot(activePage) });
              done = true;
            } catch (_) {}
          }
        }
      }
      if (!done) {
        let screenshotBase64 = null;
        try {
          const buf = await activePage.screenshot({ type: "png" });
          screenshotBase64 = buf.toString("base64");
        } catch (_) {}
        const errMsg = userFacingMessage(err);
        sendLog(ws, `Step failed: ${errMsg}`, "error", sessionId);
        stepDone({ success: false, screenshot: screenshotBase64, failureType: stepFailureType });
        send(ws, "test_error", { sessionId, message: errMsg, screenshot: screenshotBase64 });
      }
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

    if (type === "interact") {
      const activePage = currentRun && currentRun.ws === ws ? currentRun.page : null;
      if (!activePage) return;
      const act = msg.action;
      const sid = currentRun && currentRun.ws === ws ? currentRun.sessionId : null;
      if (act === "click" && typeof msg.x === "number" && typeof msg.y === "number") {
        const cw = Math.max(1, Number(msg.canvasWidth) || 1280);
        const ch = Math.max(1, Number(msg.canvasHeight) || 720);
        const vp = activePage.viewportSize();
        const vw = (vp && vp.width) || 1280;
        const vh = (vp && vp.height) || 720;
        const vx = Math.round((msg.x / cw) * vw);
        const vy = Math.round((msg.y / ch) * vh);
        activePage.mouse.click(vx, vy).then(() => {
          sendLog(ws, `Live click at (${vx}, ${vy})`, "info", sid);
        }).catch(() => {});
      } else if (act === "key" && typeof msg.key === "string") {
        activePage.keyboard.press(msg.key).then(() => {
          sendLog(ws, `Live key: ${msg.key}`, "info", sid);
        }).catch(() => {});
      } else if (act === "scroll" && (typeof msg.deltaY === "number" || typeof msg.deltaX === "number")) {
        const dx = typeof msg.deltaX === "number" ? msg.deltaX : 0;
        const dy = typeof msg.deltaY === "number" ? msg.deltaY : 0;
        activePage.mouse.wheel(dx, dy).then(() => {
          sendLog(ws, `Live scroll (${dx}, ${dy})`, "info", sid);
        }).catch(() => {});
      }
      return;
    }

    if (type === "step") {
      const activePage = currentRun && currentRun.ws === ws ? currentRun.page : null;
      if (activePage) {
        getStepQueue(ws).queue.push(msg);
        processStepQueue(ws);
      } else {
        sendLog(ws, "Step used: Interpreter", "info", sessionId);
        send(ws, "step_done", { success: false, sessionId, resolvedBy: "interpreter" });
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
