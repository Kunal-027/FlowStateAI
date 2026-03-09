/**
 * DOM sanitizer for sending to Claude: strip script, style, svg to save tokens and avoid noise.
 * Use with getInteractiveSubtreeInPage so we send only the interactive part of the page.
 */

/**
 * Strips <script>, <style>, and <svg> tags (and their contents) from HTML.
 * Reduces token count and avoids sending executable or non-interactive markup to the LLM.
 * @param {string} html - Raw HTML string (e.g. document.body.innerHTML or a subtree).
 * @returns {string} Sanitized HTML.
 */
function domSanitizer(html) {
  if (!html || typeof html !== "string") return "";
  let out = html;
  // Remove script tags and their content (including multi-line)
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  // Remove self-closing or empty script/style/svg
  out = out.replace(/<script(?:\s[^>]*)?\/?>/gi, "");
  out = out.replace(/<style(?:\s[^>]*)?\/?>/gi, "");
  out = out.replace(/<svg(?:\s[^>]*)?\/?>/gi, "");
  // Collapse excessive whitespace to save tokens
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Run inside page.evaluate() to get the "interactive" subtree HTML.
 * Prefers main, [role="main"], form, or body. Call domSanitizer(result.html) in Node after.
 */
function getInteractiveSubtreeInPage() {
  const root = document.body;
  if (!root) return { html: "" };
  let container = root.querySelector("main") || root.querySelector('[role="main"]') || root.querySelector("form");
  if (!container) {
    const withInteractive = root.querySelectorAll("a, button, input, select, textarea, [role=button], [role=link], [role=textbox], [role=menuitem]");
    if (withInteractive.length > 0) {
      const best = withInteractive[0].closest("form") || withInteractive[0].closest("main") || withInteractive[0].closest('[role="main"]');
      container = best || root;
    } else {
      container = root;
    }
  }
  const html = container ? (container.innerHTML || "") : root.innerHTML || "";
  return { html };
}

module.exports = { domSanitizer, getInteractiveSubtreeInPage };
