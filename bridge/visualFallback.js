/**
 * AI Visual Discovery: when semantic locators fail, send screenshot to AI and get click coordinates.
 * Strict JSON only: { "x": number, "y": number, "reason": string }. No conversational text.
 * Providers: Claude (primary), optional OpenAI GPT-4o / Google Gemini via env.
 * Use only as fallback after semantic locators (Semantic Locator Engine).
 */

const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

const VISUAL_DISCOVERY_PROMPT = `You are a UI element locator. You receive a screenshot and an instruction (e.g. "Click on any Nike shoes").
Your task: find the CENTER pixel coordinates (x, y) of ONE element that matches the instruction. Origin (0,0) is top-left; x increases right, y increases down.

Output rules:
- Return ONLY a single JSON object. No markdown, no code fences, no explanation outside the JSON.
- Required schema: {"x": number, "y": number, "reason": string}
- reason: brief explanation (e.g. "First product card matching Nike shoes").
- If the element is not visible or you cannot identify it, return: {"x": null, "y": null, "reason": "not found"}`;

let anthropicClient = null;

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

/**
 * Parses strict JSON response: { x, y, reason }. Returns null if invalid.
 * @param {string} raw - Raw content from AI.
 * @returns {{ x: number, y: number, reason: string } | null}
 */
function parseVisualDiscoveryResponse(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const x = parsed.x;
    const y = parsed.y;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (x != null && y != null && typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      return { x: Math.round(x), y: Math.round(y), reason: reason || "AI visual discovery" };
    }
  } catch (_) {
    // ignore
  }
  return null;
}

async function getViewportSize(page) {
  const v = page.viewportSize();
  if (v && v.width && v.height) return { width: v.width, height: v.height };
  try {
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  } catch (_) {
    return { width: 1280, height: 720 };
  }
}

/**
 * Generic disambiguation hint added to the instruction when the same text may appear multiple times
 * (e.g. list row vs radio, or different selectors tomorrow). Keeps Visual Discovery app-agnostic.
 */
const DISAMBIGUATE_HINT = " If the target text or label appears in more than one place (e.g. in a list and as a radio, header, or label), choose the element that best matches the user's intent: prefer the clickable list row, list item, or button—not a radio or label that only displays the same text.";

/**
 * AI Visual Discovery: screenshot → AI → strict JSON { x, y, reason }.
 * Only call as fallback after semantic locators fail.
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} instruction - Step instruction (e.g. "Click on any Nike shoes").
 * @param {{ disambiguate?: boolean }} [options] - If disambiguate is true, add a generic hint so the model prefers the clickable list row/button over a radio or label when the same text appears twice.
 * @returns {Promise<{ x: number, y: number, reason: string } | null>}
 */
async function getVisualDiscoveryResult(page, instruction, options = {}) {
  const client = getAnthropicClient();
  if (!client) return null;

  let screenshotBase64 = null;
  let imageWidth = 0;
  let imageHeight = 0;
  try {
    const buf = await page.screenshot({ type: "png" });
    screenshotBase64 = buf.toString("base64");
    const v = await getViewportSize(page);
    imageWidth = v.width;
    imageHeight = v.height;
  } catch (_) {
    return null;
  }
  if (!screenshotBase64 || imageWidth <= 0 || imageHeight <= 0) return null;

  let instructionText = instruction || "click the element that best matches the user intent";
  if (options.disambiguate) instructionText += DISAMBIGUATE_HINT;
  const userText = `Instruction: ${instructionText}\nImage dimensions: ${imageWidth} x ${imageHeight}. Return x,y within this range.`;

  try {
    console.log("[bridge] Using ANTHROPIC_API_KEY (Visual Discovery)");
    const message = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotBase64 } },
            { type: "text", text: [VISUAL_DISCOVERY_PROMPT, userText].join("\n\n") },
          ],
        },
      ],
    });
    const textBlock = message.content?.find((b) => b.type === "text");
    const raw = textBlock?.text?.trim();
    const result = parseVisualDiscoveryResponse(raw);
    if (!result) return null;
    const x = Math.max(0, Math.min(result.x, imageWidth - 1));
    const y = Math.max(0, Math.min(result.y, imageHeight - 1));
    return { x, y, reason: result.reason };
  } catch (_) {
    return null;
  }
}

/**
 * Legacy: returns only { x, y } for backward compatibility. Prefer getVisualDiscoveryResult for reporting reason.
 */
async function getVisualClickCoordinates(page, instructionOrTarget) {
  const result = await getVisualDiscoveryResult(page, instructionOrTarget);
  return result ? { x: result.x, y: result.y } : null;
}

function scaleCoordinatesToViewport(coords, sourceSize, viewportSize) {
  if (!sourceSize.width || !sourceSize.height) return coords;
  return {
    x: Math.round(coords.x * (viewportSize.width / sourceSize.width)),
    y: Math.round(coords.y * (viewportSize.height / sourceSize.height)),
  };
}

module.exports = {
  getVisualClickCoordinates,
  getVisualDiscoveryResult,
  parseVisualDiscoveryResponse,
  scaleCoordinatesToViewport,
};
