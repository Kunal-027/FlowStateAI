/**
 * AI-assisted selector healing: when exact + fuzzy fail, ask LLM for a CSS selector from DOM.
 * Uses HuggingFace first (cheaper), then Claude. Strict JSON-only output to save tokens.
 */

const path = require("path");
const fs = require("fs");
const { InferenceClient } = require("@huggingface/inference");
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

const HF_MODEL = process.env.HF_MODEL || "Qwen/Qwen2.5-72B-Instruct";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

/** System prompt: return ONLY valid JSON to minimize output tokens. */
const HEAL_SYSTEM_PROMPT = `You are a selector finder for browser automation. Given the user's goal and a DOM snippet, return a single CSS selector that targets the best matching element (button, link, input, etc.). Return ONLY valid JSON. No markdown, no code fences, no explanation.
Format: {"selector": "css selector string"} if found, or {"selector": null, "reason": "brief reason"} if not found.`;

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

/**
 * Get a CSS selector for the element that matches the user's instruction, using the given DOM.
 * Tries HuggingFace first (cost-effective), then Claude. Does not loop; one call per provider.
 * @param {string} instruction - User step (e.g. "Click on Companies Menu").
 * @param {string} domSnippet - Sanitized HTML or JSON snapshot string (interactive subtree only).
 * @returns {Promise<{ selector: string | null, reason?: string }>}
 */
async function getSelectorFromDom(instruction, domSnippet) {
  const snippet = typeof domSnippet === "string"
    ? domSnippet.slice(0, MAX_DOM_CHARS)
    : JSON.stringify(domSnippet).slice(0, MAX_DOM_CHARS);
  const userContent = `User goal: ${instruction}\n\nDOM snippet:\n${snippet}`;

  // 1) HuggingFace first (simpler/cheaper)
  try {
    const hf = getHfClient();
    if (hf) {
      const response = await hf.chatCompletion({
        model: HF_MODEL,
        messages: [
          { role: "system", content: HEAL_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 128,
        temperature: 0,
      });
      const raw = response.choices?.[0]?.message?.content?.trim();
      const result = parseHealResponse(raw);
      if (result.selector) return result;
      if (result.reason) return result;
    }
  } catch (_) {
    // HF failed; try Claude
  }

  // 2) Claude fallback (strict JSON system prompt)
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
      const result = parseHealResponse(raw);
      return result;
    }
  } catch (_) {
    // both failed
  }

  return { selector: null };
}

module.exports = {
  getSelectorFromDom,
  domSanitizer,
  parseHealResponse,
  getCachedSelector,
  setCachedSelector,
};
