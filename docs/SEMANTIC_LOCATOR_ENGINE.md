# Semantic Locator Engine

Handles dynamic, human-style steps like **"Click on any Nike shoes"** with a clear order: semantic locators first, then AI Visual Discovery, then validation.

## Flow

1. **Semantic search**  
   Use Playwright semantic locators from the instruction:
   - Extract target from instruction (e.g. "Click on any Nike shoes" → "Nike shoes").
   - Try `getByRole('link', { name: /.../ })`, `getByText(...)`, including flexible multi-word match (e.g. "Nike.*shoes" for product titles).

2. **AI Visual Discovery (fallback only)**  
   If semantic locators find nothing:
   - Send current page screenshot to the AI (Claude; GPT-4o/Gemini can be added via env).
   - Prompt: find the element that matches the instruction; return **strict JSON only**: `{ "x": number, "y": number, "reason": string }`. No conversational text.
   - Click at the returned (x, y).

3. **Validation**  
   After a Visual Discovery click:
   - Wait ~1.5s, then check if the page URL changed.
   - Report `validationPassed: true/false` so we can see when the agent likely clicked the right thing.

## Efficiency

- **AI Visual Discovery is only a fallback.** Semantic locators are always tried first (no API call for many steps).
- **Strict JSON:** AI response must be exactly `{ "x": number, "y": number, "reason": string }` so we never parse conversational text.
- **Hit-rate monitoring:** Every Visual Discovery success is logged with `visualClick: true`, `discoveryReason`, and `validationPassed` in the report (Reports tab, timeline badges, HTML export).

## Code

- **Engine:** `bridge/semanticLocatorEngine.js` — `runSemanticLocatorFlow(page, instruction, action, { trySemanticLocators })`.
- **Visual Discovery:** `bridge/visualFallback.js` — `getVisualDiscoveryResult(page, instruction)` returns `{ x, y, reason }` or null.
- **Bridge:** For "click on X" steps, the bridge calls the engine; on success it sends `step_done` with `visualClick`, `discoveryReason`, and `validationPassed`.

## Report

- **Visual Discovery** badge on steps that used AI fallback.
- **discoveryReason** in expanded step detail and HTML export (for hit-rate analysis).
- **(unverified)** when `validationPassed === false` (click may have missed).
