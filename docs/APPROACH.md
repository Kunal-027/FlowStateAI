# Flowstate: Approach & Architecture

This doc describes how we approach the problem (LLM parser, DOM selector, execution) and the rules we follow so the codebase stays consistent.

## 1. Step message shape

- **Source:** Frontend sends step messages over WebSocket. No selector is sent from the frontend.
- **Shape:** `{ type: "step", action, target?, instruction?, url? }`
- **Resolution:** The bridge turns `action` + `target`/`instruction` into a concrete action and a selector (or no selector) via LLM + DOM utilities.

## 2. Resolution order (bridge)

We resolve and execute in this order so that safe, special-case paths run first and we avoid triggering page bugs (e.g. Amazon’s “Assignment to constant variable” when clicking the search button):

1. **Early intercepts (no DOM click for risky elements)**  
   - **Search submit:** If the step is “click Search Button” / “submit search” (by instruction or resolved target), we **never** click the search button. We only: try Enter in focused field → `submitSearchViaEnter` (focus search input + Enter) → “just press Enter” → visual fallback.  
   - **“Click on X” (non-search):** For steps like “Click on Nike shoes”, we can try **visual click first** (screenshot → AI coordinates → `page.mouse.click(x,y)`) before falling back to selector/by-text.

2. **LLM (AI interpreter)**  
   - `getAiAction` / `parseInstructionDynamically`: from `instruction` (and optional `target`) we get `resolvedAction`, `resolvedTarget`, and sometimes a **selector**.  
   - For “click Search Button” / “submit search” the LLM returns **action: submit_search**, and we treat that as submit-only (no button click).

3. **Selector resolution**  
   - **findBestSelector** (and related DOM utilities): given snapshot or page, we get a selector for the target.  
   - We may still **ignore** that selector for submit_search and use Enter + visual only.

4. **Execution branches**  
   - **submit_search:** Only `submitSearchViaEnter` + Enter + visual fallback.  
   - **click** with selector: `clickWithVisibleOrForce(selector)` (with retries and Enter/visual fallbacks on script error).  
   - **click** without selector: by-text, typo correction, LLM fallback, findAndRetry, then visual fallback on failure.  
   - **hover** with selector: `hover(selector)`; on **page script error** we try visual fallback (coordinates → `mouse.move`) and never surface raw errors.

5. **Healing & fallbacks**  
   - **findAndRetry**, **getTypoCorrectedTarget**, **tryLlmFallbackClickOrHover**.  
   - **Visual fallback:** When a click (or hover) fails—especially with a page script error—we use **getVisualClickCoordinates** (screenshot + AI) and **page.mouse.click(x,y)** or **page.mouse.move(x,y)**.

## 3. Page script errors: never show raw to the user

- Errors like **“Assignment to constant variable”**, **TypeError**, **ReferenceError** come from **page JavaScript**, not from our bridge.
- **Rule:** We never send these raw messages to the UI. We always normalize.
- **Implementation:**  
  - **isPageScriptError(err):** returns true if `err.message` matches a known page-script pattern.  
  - **userFacingMessage(err):** if `isPageScriptError(err)`, return a single generic message (e.g. “Click or hover failed (page script error).”); otherwise return `err.message` or “Step failed.”.  
  - **All send sites** that report step failure to the frontend use **userFacingMessage(lastError)** (or the same logic): `step_done`, `ambiguity_error`, `test_error`, and any catch blocks that send a message to the user.

So: **one conceptual rule (no raw page script errors), one helper (userFacingMessage), applied everywhere we send failure messages.**

## 4. Context separation

- **Flowstate app UI** (sidebar, test case Save, etc.) and the **page under test** (e.g. Amazon) are separate contexts.  
- Don’t mix fixes or assumptions between them. See `.cursor/rules/context-separation.mdc`.

## 5. Ports and scripts

- **App:** 3000  
- **Bridge:** 4000  
- **Kill ports:** `npm run kill-ports` (and see `KILL-PORTS.md`).  
- **EPERM / .next locked:** `npm run clean-and-kill` (kill Node, delete `.next`).

## 6. Optional rework directions

- **Single “step executor” function:** One place that receives (action, target, instruction, optional selector) and runs the resolution order above (intercepts → LLM → selector → execute). That would make it easier to add new intercepts and to ensure every path goes through the same normalization.  
- **Stricter types:** Explicit step result type (success / failure with user-facing message only) so we never send raw `lastError.message` by mistake.  
- **Visual fallback as first-class:** For “click on X” and “hover on X”, consider making visual resolution a supported path (with a clear “visual click” / “visual hover” in the report) instead of only a fallback.

These are documented here so future changes (LLM parser, DOM selector, or execution) stay aligned with the approach above.
