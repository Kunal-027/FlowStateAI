# Parser: Contract & Strategy

One **canonical output shape** for the whole pipeline: `{ action, target?, value? }`.  
When the parser (or LLM) gets this right, selector resolution and execution are straightforward.

## Canonical actions

| Action           | When to use                    | target example     | value example    |
|-----------------|--------------------------------|--------------------|------------------|
| `click`         | Buttons, links, "click on X"   | "Login", "Nike shoes" | —             |
| `fill`          | Inputs, search box             | "search", "email"  | "Nike Shoes"     |
| `navigate`      | Go to URL                      | URL                | URL              |
| `hover`         | Hover over element             | "Menu"             | —                |
| `press`         | Key on focused element         | selector or key    | —                |
| `submit_search` | Submit search (no button click)| "search"           | —                |
| `verify_displayed` | Assert element visible      | "Success"          | —                |

## Strategy: Parser first, LLM only when needed

1. **Parser first** (bridge)  
   - For every step with an instruction, run the rule-based parser first.  
   - If parser returns **high-confidence** (navigate, submit_search, verify_displayed, fill): use it and **do not call the LLM**. This avoids API failures, latency, and wrong interpretations for steps we already parse correctly.

2. **LLM only for disambiguation**  
   - Call the LLM only when parser did **not** return high-confidence (parser returned `null` or click/hover). Then use LLM to get a DOM-aware target/selector.  
   - If the LLM fails or returns invalid JSON, the bridge still has the parser result (for click/hover) so the step does not fail unnecessarily.

3. **Never let LLM override safe parser results**  
   - For instructions that look like "search button" or "Search X", the bridge never overwrites with LLM output (parser and early intercepts are correct).  
   - LLM output is normalized: if it returns click + target "search button", it is converted to `submit_search` so we never trigger page bugs.

4. **Rule-based parser** (`instructionParser.js`)  
   - Fast, no API, deterministic. Pattern order: verify → navigate → submit_search → fill → click → hover → fallback click.

5. **LLM** (`aiInterpreter.js`)  
   - Same contract: `{ action, target, value? }`. `normalizeAiResult()` maps click+search button → submit_search.  
   - Used only when parser didn’t give high-confidence, so fewer failures and lower cost.

## Pattern order (instructionParser)

First match wins:

1. **verify_displayed** – "Verify X is displayed"
2. **navigate** – "Navigate to …", "Go to …"
3. **submit_search** – "Click search button", "Submit search", "Press search"
4. **fill** – "Enter X in Y", "Fill Y with X", "Search X", "Type X - Y"
5. **click** – "Click on X", "Click X", "Press X", "Click on any X"
6. **hover** – "Hover over X"
7. **fallback** – short phrase → click target

## Extending

- **New action:** Add to `ACTIONS` in instructionParser and `VALID_ACTIONS` in aiInterpreter; add bridge handling.  
- **New phrasing:** Add a regex/pattern in instructionParser in the right order (e.g. new fill pattern before generic click).  
- **New site:** Prefer generic patterns (search, fill, click) over site-specific text; use elementFinder aliases if needed.

Keeping the parser optimized and the contract single makes the rest of the pipeline (selector, execution, reporting) easy to reason about and extend.
