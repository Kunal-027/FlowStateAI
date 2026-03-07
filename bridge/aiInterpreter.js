/**
 * LLM Step Interpreter (Node/bridge). Primary: Hugging Face Inference API. Fallback: Claude (Anthropic).
 * If both fail or no keys, the bridge falls back to regex + elementFinder.
 * Keys: HUGGINGFACE_API_KEY or HF_TOKEN (primary), ANTHROPIC_API_KEY (fallback only).
 * Optional: HF_MODEL, ANTHROPIC_MODEL.
 */

const { InferenceClient } = require("@huggingface/inference");
const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");

const HF_MODEL = process.env.HF_MODEL || "Qwen/Qwen2.5-72B-Instruct";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

const SYSTEM_PROMPT = `You are a step interpreter for browser automation. The user can describe their goal in ANY natural language. Examples of valid phrasings:
- "Enter username admin@yc.com" / "Enter username - admin@yc.com" / "Enter username \\"admin@yc.com\\"" / "Type admin@yc.com in username field"
- "Fill password with secret123" / "Enter Password - admin123" / "Put mypass in password"
- "Click Login" / "Click Sign in" / "Press Submit"
- "Navigate to https://example.com" / "Go to google.com"

Your job: from the user goal and the DOM snapshot, output exactly one JSON object (no other text, no markdown):
{ "action": "click" | "fill" | "navigate" | "press" | "hover", "target": "short element description or selector from snapshot", "value": "for fill only: the text to type" }

Rules:
- action: click (buttons/links), fill (inputs), navigate (URLs), press (key), hover.
- target: Use a selector from the snapshot (e.g. [data-fs-id="fs-5"]) if you can match the right element; otherwise use a short description (e.g. "username", "password", "Login button", "search input") so the system can fuzzy-match. For fill, target is the field (username, email, password, search). For navigate, target is the URL.
- value: Only for action "fill". Extract the exact text the user wants to type (email, password, search term, etc.).
- Interpret ANY phrasing: "Enter X in Y", "Type X - Y", "Fill Y with X", "Put X in Y field", quoted values, etc. Return only valid JSON.`;

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
 * Parses raw LLM text into a valid action object. Returns null if invalid.
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
      ["click", "fill", "navigate", "press", "hover"].includes(parsed.action)
    ) {
      return {
        action: parsed.action,
        target: parsed.target,
        value: typeof parsed.value === "string" ? parsed.value : undefined,
      };
    }
  } catch (_) {
    // ignore
  }
  return null;
}

/**
 * 1) Tries Hugging Face. 2) On failure or no key, tries Claude. 3) Returns null for regex fallback.
 * @param {string} intent - User goal / step instruction.
 * @param {unknown[]} domSnapshot - DOM snapshot from getDomSnapshotInPage.
 * @returns {Promise<{ action: string, target: string, value?: string } | null>}
 */
async function getAiAction(intent, domSnapshot) {
  const snapshotStr = JSON.stringify((domSnapshot || []).slice(0, 150));
  const userContent = `User goal: ${intent}\n\nDOM snapshot:\n${snapshotStr}`;

  // 1) Primary: Hugging Face
  try {
    const hf = getHfClient();
    if (hf) {
      const response = await hf.chatCompletion({
        model: HF_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 256,
        temperature: 0.1,
      });
      const raw = response.choices?.[0]?.message?.content?.trim();
      const result = parseActionResult(raw);
      if (result) return result;
    }
  } catch (_) {
    // HF failed; try Claude fallback
  }

  // 2) Fallback: Claude (only when HF unavailable or failed)
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
      if (result) return result;
    }
  } catch (_) {
    // Claude also failed; bridge will use regex
  }

  return null;
}

module.exports = { getAiAction };
