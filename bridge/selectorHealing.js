/**
 * AI-assisted selector healing: when exact + fuzzy fail, ask Claude for a CSS selector from DOM.
 * Claude only (ANTHROPIC_API_KEY). Strict JSON-only output to save tokens.
 */

const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
const { domSanitizer } = require("./domSanitizer");

const CACHE_DIR = path.resolve(__dirname, "..");
const CACHE_FILENAME = ".flowstate-selector-cache.json";
const CACHE_PATH = path.join(CACHE_DIR, CACHE_FILENAME);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function cacheKey(instruction, action, pageUrl) {
  const u = (pageUrl || "").replace(/#.*$/, "").replace(/\?.*$/, "");
  return `${action}:${(instruction || "").trim().toLowerCase()}:${u}`;
}

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const data = JSON.parse(raw);
    return typeof data === "object" && data !== null ? data : {};
  } catch (_) {
    return {};
  }
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 0), "utf8");
  } catch (_) {
    // ignore
  }
}

/**
 * Get healed selector from cache if present and not expired. Key: instruction + action + page URL.
 * @returns {string | null}
 */
function getCachedSelector(instruction, action, pageUrl) {
  const key = cacheKey(instruction, action, pageUrl);
  const cache = loadCache();
  const entry = cache[key];
  if (!entry || typeof entry.selector !== "string") return null;
  const age = Date.now() - (entry.timestamp || 0);
  if (age > CACHE_TTL_MS) return null;
  return entry.selector;
}

/**
 * Store healed selector so the next test run uses it immediately (avoids a second AI call).
 */
function setCachedSelector(instruction, action, pageUrl, selector) {
  const key = cacheKey(instruction, action, pageUrl);
  const cache = loadCache();
  cache[key] = { selector, timestamp: Date.now() };
  saveCache(cache);
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
/** Haiku for simple selector repairs (token economy); Sonnet for complex reasoning. */
const ANTHROPIC_MODEL_HAIKU = process.env.ANTHROPIC_MODEL_HAIKU || "claude-3-5-haiku-20241022";

/** System prompt: return ONLY valid JSON to minimize output tokens. */
const HEAL_SYSTEM_PROMPT = `You are a selector finder for browser automation. Given the user's goal and a DOM snippet, return a single CSS selector that targets the best matching element (button, link, input, etc.). Return ONLY valid JSON. No markdown, no code fences, no explanation.
Format: {"selector": "css selector string"} if found, or {"selector": null, "reason": "brief reason"} if not found.`;

/** For a11y + image: use accessibility tree (and optional screenshot) to find the element. */
const HEAL_A11Y_SYSTEM_PROMPT = `You are a selector finder for browser automation. You will receive the user's goal and a compact Accessibility Tree (role, name, selector per line). Optionally a screenshot is attached. Identify the element that best matches the user's goal and return its selector. Return ONLY valid JSON. No markdown, no code fences.
Format: {"selector": "css selector string"} if found (use the [selector] from the tree line), or {"selector": null, "reason": "brief reason"} if not found.`;

let hfClient = null;
let anthropicClient = null;

function getHfClient() {
  const token = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
  if (!token) return null;
  if (!hfClient) hfClient = new InferenceClient(token);
  return hfClient;
}

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

/**
 * Parse LLM response into { selector, reason }. Expects only JSON.
 * @param {string} raw - Raw response from LLM.
 * @returns {{ selector: string | null, reason?: string }}
 */
function parseHealResponse(raw) {
  if (!raw || typeof raw !== "string") return { selector: null };
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const sel = parsed.selector;
      return {
        selector: typeof sel === "string" && sel.length > 0 ? sel : null,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
  } catch (_) {
    // ignore
  }
  return { selector: null };
}

/** Max length of DOM snippet to send (chars) to stay within context. */
const MAX_DOM_CHARS = 12000;
/** Max length of a11y snippet (token economy). */
const MAX_A11Y_CHARS = 8000;

/**
 * Build a compact Accessibility Tree snippet from a DOM snapshot (role, name, selector per line).
 * Sanitized for LLM; no full HTML. Used for AI-driven healing with optional screenshot.
 * @param {Array<{ selector?: string, tagName?: string, role?: string, text?: string, ariaLabel?: string, placeholder?: string }>} snapshot - From getDomSnapshotInPage.
 * @returns {string}
 */
function snapshotToA11yLines(snapshot) {
  if (!Array.isArray(snapshot)) return "";
  const lines = snapshot.map((e) => {
    const role = (e.role || e.tagName || "unknown").toLowerCase();
    const name = [e.ariaLabel, e.placeholder, e.text].filter(Boolean).join(" ").trim().slice(0, 80);
    const sel = e.selector || "";
    return `${role} "${name}" [${sel}]`;
  });
  return lines.join("\n").slice(0, MAX_A11Y_CHARS);
}

/**
 * Get a CSS selector using sanitized Accessibility Tree and optional screenshot. Uses Haiku for simple repairs (token economy), Sonnet for complex reasoning.
 * @param {string} instruction - User step (e.g. "Click on Companies Menu").
 * @param {string} a11ySnippet - Compact a11y tree from snapshotToA11yLines(snapshot).
 * @param {string} [screenshotBase64] - Optional base64 PNG for vision.
 * @param {{ useComplexModel?: boolean }} [opts] - If true, use Sonnet; else Haiku.
 * @returns {Promise<{ selector: string | null, reason?: string }>}
 */
async function getSelectorFromA11yAndImage(instruction, a11ySnippet, screenshotBase64, opts = {}) {
  const useSonnet = !!opts.useComplexModel;
  const model = useSonnet ? ANTHROPIC_MODEL : ANTHROPIC_MODEL_HAIKU;
  const textContent = `User goal: ${instruction}\n\nAccessibility Tree (role "name" [selector]):\n${(a11ySnippet || "").slice(0, MAX_A11Y_CHARS)}`;
  const anthropic = getAnthropicClient();
  if (!anthropic) return getSelectorFromDom(instruction, a11ySnippet);

  const content = [{ type: "text", text: textContent }];
  if (screenshotBase64 && typeof screenshotBase64 === "string" && screenshotBase64.length > 0) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: screenshotBase64.replace(/^data:image\/\w+;base64,/, "") },
    });
  }

  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 128,
      system: HEAL_A11Y_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });
    const textBlock = message.content?.find((b) => b.type === "text");
    const raw = textBlock?.text?.trim();
    return parseHealResponse(raw);
  } catch (_) {
    return { selector: null };
  }
}

/**
 * Get a CSS selector for the element that matches the user's instruction, using the given DOM.
 * Claude only. Does not loop; one call.
 * @param {string} instruction - User step (e.g. "Click on Companies Menu").
 * @param {string} domSnippet - Sanitized HTML or JSON snapshot string (interactive subtree only).
 * @returns {Promise<{ selector: string | null, reason?: string }>}
 */
async function getSelectorFromDom(instruction, domSnippet) {
  const snippet = typeof domSnippet === "string"
    ? domSnippet.slice(0, MAX_DOM_CHARS)
    : JSON.stringify(domSnippet).slice(0, MAX_DOM_CHARS);
  const userContent = `User goal: ${instruction}\n\nDOM snippet:\n${snippet}`;

  try {
    const anthropic = getAnthropicClient();
    if (anthropic) {
      const message = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 128,
        system: HEAL_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      });
      const textBlock = message.content?.find((b) => b.type === "text");
      const raw = textBlock?.text?.trim();
      return parseHealResponse(raw);
    }
  } catch (_) {}

  return { selector: null };
}

module.exports = {
  getSelectorFromDom,
  getSelectorFromA11yAndImage,
  snapshotToA11yLines,
  domSanitizer,
  parseHealResponse,
  getCachedSelector,
  setCachedSelector,
};
