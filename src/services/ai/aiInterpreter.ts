/**
 * AI-Driven Step Interpreter using Hugging Face Inference API.
 * Given a user intent and DOM snapshot, returns a structured action for the browser agent.
 */

import { InferenceClient } from "@huggingface/inference";

const DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct";

const SYSTEM_PROMPT = `You are an autonomous browser agent. Given a DOM snapshot (array of elements with selector, tagName, id, text, placeholder, ariaLabel, role) and a user goal, return exactly one JSON object with no other text:
{ "action": "click" | "fill" | "navigate" | "press" | "hover", "target": "selector or short description for the element", "value": "optional value for fill" }

Rules:
- action must be one of: click, fill, navigate, press, hover.
- target must be a CSS selector from the snapshot (use the selector field) or a very short description that matches one element (e.g. "search input", "Submit button").
- For "fill", include value with the text to type. For "navigate", target can be the URL or "address bar".
- Return only valid JSON, no markdown or explanation.`;

export interface AiAction {
  action: "click" | "fill" | "navigate" | "press" | "hover";
  target: string;
  value?: string;
}

let client: InferenceClient | null = null;

/**
 * Returns a singleton InferenceClient when HUGGINGFACE_API_KEY or HF_TOKEN is set.
 * Used by getAiAction to call the Hugging Face Inference API.
 */
function getClient(): InferenceClient | null {
  const token = process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN;
  if (!token) return null;
  if (!client) client = new InferenceClient(token);
  return client;
}

/**
 * Calls a high-reasoning model (via Hugging Face Inference API) to interpret the user intent
 * and DOM snapshot into a single browser action. Returns parsed JSON { action, target, value? }
 * or null on failure (API error or invalid JSON). Used by the bridge when no hardcoded selector exists.
 */
export async function getAiAction(
  intent: string,
  domSnapshot: unknown[]
): Promise<AiAction | null> {
  try {
    const hf = getClient();
    if (!hf) return null;

    const snapshotStr = JSON.stringify(domSnapshot.slice(0, 150)); // cap size
    const userContent = `User goal: ${intent}\n\nDOM snapshot:\n${snapshotStr}`;

    const response = await hf.chatCompletion({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: userContent },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });

    const raw = response.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonStr) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      "action" in parsed &&
      typeof (parsed as AiAction).action === "string" &&
      "target" in parsed &&
      typeof (parsed as AiAction).target === "string"
    ) {
      const a = parsed as AiAction;
      const action = a.action as AiAction["action"];
      if (["click", "fill", "navigate", "press", "hover"].includes(action)) {
        return {
          action,
          target: a.target,
          value: typeof a.value === "string" ? a.value : undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
