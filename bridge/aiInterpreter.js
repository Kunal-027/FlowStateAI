/**
 * LLM Step Interpreter. Same contract as instructionParser: { action, target, value? }.
 * Claude only (ANTHROPIC_API_KEY). Use when parser returns null or when DOM disambiguation is needed.
 */

const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

/** Canonical actions (must match instructionParser.ACTIONS for fill/click/navigate/hover/submit_search). */
const VALID_ACTIONS = ["click", "fill", "navigate", "press", "hover", "submit_search"];

const SYSTEM_PROMPT = `You are a step interpreter for browser automation. Output exactly one JSON object (no other text, no markdown).

Output format: { "action": "<action>", "target": "<short description or selector>", "value": "<only for fill>" }

Rules:
- action must be one of: click | fill | navigate | press | hover | submit_search
- target: short element description (e.g. "Login", "search", "Nike shoes") or a selector from the snapshot if you use one
- value: only for action "fill". The exact text to type (e.g. "Nike Shoes", "admin@test.com")

Critical mappings (use these exactly):
1. "Click Search Button" / "Submit search" / "Press search" → action: "submit_search", target: "search", no value
2. "Search X" / "Search for X" → action: "fill", target: "search", value: "X" (e.g. value: "Nike Shoes")
3. "Click on X" / "Click on any X" → action: "click", target: "X" (e.g. target: "Nike shoes" or "any Nike shoes")
4. "Enter X in Y" / "Fill Y with X" → action: "fill", target: "Y", value: "X"
5. "Navigate to URL" / "Go to URL" → action: "navigate", target: URL, value: URL
6. Buttons/links (Login, Submit, Add to cart) → action: "click", target: that text

Examples:
- "Search Nike Shoes" → {"action":"fill","target":"search","value":"Nike Shoes"}
- "Click Search Button" → {"action":"submit_search","target":"search"}
- "Click on any Nike shoes" → {"action":"click","target":"Nike shoes"}
- "Enter email user@test.com" → {"action":"fill","target":"email","value":"user@test.com"}
- "Navigate to https://amazon.com" → {"action":"navigate","target":"https://amazon.com","value":"https://amazon.com"}

Return only valid JSON.`;

let anthropicClient = null;

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

/**
 * Normalizes LLM output to avoid known failures (e.g. click on search button → submit_search).
 * @param {{ action: string, target: string, value?: string }} result - Parsed AI result.
 * @returns {{ action: string, target: string, value?: string }}
 */
function normalizeAiResult(result) {
  if (!result || result.action !== "click") return result;
  const t = (result.target || "").toLowerCase();
  if (/search\s*button|submit\s*search|search\s+button/.test(t) || (t.includes("search") && t.includes("button"))) {
    return { action: "submit_search", target: "search", value: result.value };
  }
  return result;
}

/**
 * Parses raw LLM text into a valid action object. Returns null if invalid.
 * Result is normalized (e.g. click+search button → submit_search).
 * @param {string} raw - Raw content from LLM (may include ```json).
 * @returns {{ action: string, target: string, value?: string } | null}
 */
function parseActionResult(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const jsonStr = trimmed.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.action === "string" &&
      typeof parsed.target === "string" &&
      VALID_ACTIONS.includes(parsed.action)
    ) {
      const result = {
        action: parsed.action,
        target: parsed.target.trim(),
        value: typeof parsed.value === "string" ? parsed.value.trim() : undefined,
      };
      return normalizeAiResult(result);
    }
  } catch (_) {
    // ignore
  }
  return null;
}

/**
 * Claude only. Returns { action, target, value?, _provider: "claude" } or null.
 * @param {string} intent - User goal / step instruction.
 * @param {unknown[]} domSnapshot - DOM snapshot from getDomSnapshotInPage.
 * @returns {Promise<{ action: string, target: string, value?: string } | null>}
 */
async function getAiAction(intent, domSnapshot) {
  const snapshotStr = JSON.stringify((domSnapshot || []).slice(0, 150));
  const userContent = `User goal: ${intent}\n\nDOM snapshot:\n${snapshotStr}`;

  try {
    const anthropic = getAnthropicClient();
    if (anthropic) {
      const message = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      });
      const textBlock = message.content?.find((b) => b.type === "text");
      const raw = textBlock?.text?.trim();
      const result = parseActionResult(raw);
      if (result) return { ...result, _provider: "claude" };
    }
  } catch (_) {}

  return null;
}

module.exports = { getAiAction, parseActionResult, normalizeAiResult, VALID_ACTIONS };
