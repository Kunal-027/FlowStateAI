/**
 * Semantic Locator Engine: handle dynamic, human-style steps like "Click on any Nike shoes".
 *
 * Flow:
 * 1. Semantic search: try Playwright semantic locators (getByRole('link', { name }), getByText(...)).
 * 2. AI Visual Discovery (fallback): screenshot → AI → { x, y, reason }; click at coords.
 * 3. Validation: after click, verify page changed (URL or DOM) to confirm correct target.
 *
 * AI Visual Discovery is used only when semantic locators fail. Visual Discovery success is
 * reported (visualClick + discoveryReason) so we can monitor hit rate.
 */

const { getVisualDiscoveryResult } = require("./visualFallback");
const { parseInstructionDynamically } = require("./instructionParser");

const VALIDATION_WAIT_MS = 1500;

/**
 * Extracts click target from instruction (e.g. "Click on any Nike shoes" → "Nike shoes").
 * @param {string} instruction
 * @returns {string}
 */
function extractTargetFromInstruction(instruction) {
  if (!instruction || typeof instruction !== "string") return "";
  const parsed = parseInstructionDynamically(instruction);
  if (parsed && (parsed.action === "click" || parsed.action === "hover") && parsed.target) return parsed.target.trim();
  const m = instruction.match(/click\s+on\s+(?:any\s+)?(.+)$/i);
  return m ? m[1].trim() : instruction.trim();
}

/**
 * Validates that the page changed after a click (e.g. URL change or navigation).
 * @param {import('playwright').Page} page
 * @param {string} urlBefore - URL before click.
 * @returns {Promise<boolean>}
 */
async function validateAfterClick(page, urlBefore) {
  await new Promise((r) => setTimeout(r, VALIDATION_WAIT_MS));
  try {
    const urlAfter = page.url();
    if (urlAfter && urlBefore && urlAfter !== urlBefore) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Runs the Semantic Locator flow: semantic first, then AI Visual Discovery, then validation.
 *
 * @param {import('playwright').Page} page - Playwright page.
 * @param {string} instruction - Step instruction (e.g. "Click on any Nike shoes").
 * @param {'click'|'hover'} action - "click" or "hover".
 * @param {object} options
 * @param {(page: import('playwright').Page, targetText: string, action: string) => Promise<boolean>} options.trySemanticLocators - e.g. bridge's clickOrHoverByText.
 * @returns {Promise<{ success: boolean, method: 'semantic'|'visual'|null, reason?: string, validationPassed?: boolean }>}
 */
async function runSemanticLocatorFlow(page, instruction, action, options) {
  const { trySemanticLocators } = options;
  const target = extractTargetFromInstruction(instruction);

  // 1. Semantic search first
  if (target && trySemanticLocators) {
    const semanticOk = await trySemanticLocators(page, target, action);
    if (semanticOk) return { success: true, method: "semantic" };
  }

  // 2. AI Visual Discovery fallback (strict JSON: { x, y, reason })
  const discovery = await getVisualDiscoveryResult(page, instruction);
  if (!discovery) return { success: false, method: null };

  const urlBefore = page.url();

  try {
    if (action === "click") {
      await page.mouse.click(discovery.x, discovery.y);
    } else {
      await page.mouse.move(discovery.x, discovery.y);
    }
  } catch (e) {
    return { success: false, method: "visual", reason: discovery.reason };
  }

  const validationPassed = action === "click" ? await validateAfterClick(page, urlBefore) : undefined;
  return {
    success: true,
    method: "visual",
    reason: discovery.reason,
    validationPassed,
  };
}

module.exports = {
  runSemanticLocatorFlow,
  extractTargetFromInstruction,
  validateAfterClick,
};
