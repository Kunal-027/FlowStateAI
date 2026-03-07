/**
 * LLM Step Interpreter (Node/bridge). Uses Hugging Face Inference API so the user can
 * enter steps in ANY natural language (e.g. "Enter username admin@yc.com", "Type pwd in password", "Click Login").
 * The bridge calls this first; if the LLM fails or no API key is set, it falls back to regex + elementFinder.
 * Set HUGGINGFACE_API_KEY or HF_TOKEN. Optional: HF_MODEL to override the model (e.g. a smaller/faster one).
 */

const { InferenceClient } = require("@huggingface/inference");

const DEFAULT_MODEL = process.env.HF_MODEL || "Qwen/Qwen2.5-72B-Instruct";

const SYSTEM_PROMPT = `You are a step interpreter for browser automation. The user can describe their goal in ANY natural language. Examples of valid phrasings:
- "Enter username admin@yc.com" / "Enter username - admin@yc.com" / "Enter username \"admin@yc.com\"" / "Type admin@yc.com in username field"
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

let client = null;

/**
 * Returns a singleton InferenceClient when HUGGINGFACE_API_KEY or HF_TOKEN is set.
 * Used by getAiAction to call the Hugging Face Inference API.
 * @returns {InferenceClient | null} The client instance or null if no token is configured.
 */
function getClient() {
  const token = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
  if (!token) return null;
  if (!client) client = new InferenceClient(token);
  return client;
}

/**
 * Calls the Hugging Face Inference API (high-reasoning model) to interpret the user intent
 * and DOM snapshot into a single browser action. Used when the bridge has no hardcoded selector.
 * On API failure or invalid JSON, returns null so the bridge can fall back to the fuzzy elementFinder.
 * @param {string} intent - User goal / step instruction (e.g. "fill search with FlowState AI").
 * @param {unknown[]} domSnapshot - DOM snapshot from getDomSnapshotInPage (selector, tagName, id, text, etc.).
 * @returns {Promise<{ action: string, target: string, value?: string } | null>} Parsed action or null.
 */
async function getAiAction(intent, domSnapshot) {
  try {
    const hf = getClient();
    if (!hf) return null;

    const snapshotStr = JSON.stringify((domSnapshot || []).slice(0, 150));
    const userContent = `User goal: ${intent}\n\nDOM snapshot:\n${snapshotStr}`;

    const response = await hf.chatCompletion({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });

    const raw = response.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
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
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { getAiAction };
