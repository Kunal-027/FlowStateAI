/**
 * Generic, dynamic instruction parser for browser automation.
 * Designed for global use: millions of users can write steps in their own way.
 * No site-specific phrases—only structural patterns (verb + arguments).
 *
 * Output: { action, target?, value? } for actions: click | fill | navigate | hover | verify_displayed.
 * The bridge tries AI first (getAiAction); this parser is the fallback when AI is unavailable.
 */

function normalize(s) {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function trimQuotes(s) {
  return (s || "").replace(/^["']|["']$/g, "").trim();
}

/** Known verbs per action (expandable; no site-specific terms). */
const VERBS = {
  fill: ["enter", "type", "put", "fill", "input", "write", "search", "set"],
  click: ["click", "press", "tap", "select"],
  hover: ["hover", "mouse over"],
  navigate: ["navigate", "go to", "open", "visit"],
  verify: ["verify", "check", "assert", "ensure", "see"],
};

function startsWithVerb(instruction, action) {
  const lower = normalize(instruction);
  for (const v of VERBS[action] || []) {
    if (lower === v || lower.startsWith(v + " ")) return true;
  }
  return false;
}

/**
 * Parses a raw step instruction into { action, target?, value? } using generic structural patterns.
 * Works for any language/phrasing that follows common patterns (e.g. "X in Y", "Y with X", "verb target").
 * @param {string} instruction - Raw instruction (e.g. "Enter email user@test.com", "Search gym australia").
 * @returns {{ action: string, target?: string, value?: string } | null}
 */
function parseInstructionDynamically(instruction) {
  if (!instruction || typeof instruction !== "string") return null;
  const s = instruction.trim();
  const lower = normalize(s);
  if (!s) return null;

  // ─── Verify (displayed/visible) ─────────────────────────────────────────
  const verifyQuoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?['"](.+?)['"]\s+is\s+(?:displayed|visible|shown)(?:\s+on\s+screen)?\s*$/i);
  if (verifyQuoted) return { action: "verify_displayed", target: trimQuotes(verifyQuoted[1]) };
  const verifyUnquoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?(.+?)\s+is\s+(?:displayed|visible|shown)(?:\s+on\s+screen)?\s*$/i);
  if (verifyUnquoted) return { action: "verify_displayed", target: verifyUnquoted[1].trim() };

  // ─── Navigate ───────────────────────────────────────────────────────────
  if (startsWithVerb(s, "navigate")) {
    const url = s.replace(/^(?:navigate to|go to|open|visit)\s+/i, "").trim();
    if (url) return { action: "navigate", target: url, value: url };
  }

  // ─── Fill-like: structural patterns (order matters) ──────────────────────
  // "Enter X in Y" / "Type X in the Y field"
  const fillIn = s.match(/^(?:enter|type|put|fill|input|write)\s+(.+?)\s+in\s+(?:the\s+)?(.+?)(?:\s+field)?\s*$/i);
  if (fillIn) {
    const value = trimQuotes(fillIn[1].trim());
    const target = fillIn[2].trim().replace(/\s+field$/i, "").trim();
    if (target) return { action: "fill", target, value };
  }

  // "Enter/Type 'value'" or "Enter/Type \"value\"" (target from context; we use first word as target hint)
  const fillQuoted = s.match(/^(?:enter|type)\s+(.+?)\s+["']([^"']+)["']\s*$/i);
  if (fillQuoted) return { action: "fill", target: fillQuoted[1].trim(), value: fillQuoted[2].trim() };

  // "Fill Y with X" / "Enter X - Y"
  const fillWith = s.match(/^fill\s+(.+?)\s+with\s+(.+)$/i);
  if (fillWith) return { action: "fill", target: fillWith[1].trim(), value: trimQuotes(fillWith[2].trim()) };
  const fillDash = s.match(/^(?:enter|type)\s+(.+?)\s+-\s+(.+)$/i);
  if (fillDash) return { action: "fill", target: fillDash[2].trim(), value: trimQuotes(fillDash[1].trim()) };

  // Generic: "Search [for] <field> <value>" → fill(target=field, value=value). No hardcoded "gym".
  const searchMatch = s.match(/^search\s+(?:for\s+)?(.+?)\s+(.+)$/i);
  if (searchMatch) {
    const target = searchMatch[1].trim();
    const value = searchMatch[2].trim();
    if (target && value) return { action: "fill", target, value };
  }

  // "Search <value>" (single token) → fill(target=search, value=value)
  const searchSingle = s.match(/^search\s+(.+)$/i);
  if (searchSingle) return { action: "fill", target: "search", value: searchSingle[1].trim() };

  // Generic fill: "Enter/Type <target> <value>" (two or more tokens)
  if (startsWithVerb(s, "fill")) {
    const rest = s.replace(/^(?:enter|type|put|fill|input|write)\s+/i, "").trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const value = trimQuotes(parts[parts.length - 1]);
      const target = parts.slice(0, -1).join(" ").replace(/^["']|["']$/g, "").trim() || parts[0];
      return { action: "fill", target, value };
    }
    if (parts.length === 1) return { action: "fill", target: parts[0], value: "" };
  }

  // ─── Click ──────────────────────────────────────────────────────────────
  if (startsWithVerb(s, "click")) {
    let target = s.replace(/^click\s+(?:on\s+)?/i, "").trim();
    const onQuoted = target.match(/^["'](.+?)["']\s*$/);
    if (onQuoted) target = onQuoted[1];
    target = trimQuotes(target);
    if (target) return { action: "click", target };
  }

  // ─── Hover ──────────────────────────────────────────────────────────────
  if (startsWithVerb(s, "hover")) {
    const target = trimQuotes(s.replace(/^hover\s+(?:on\s+)?/i, "").trim());
    if (target) return { action: "hover", target };
  }

  // ─── Last resort: unknown verb or single phrase ──────────────────────────
  // "Something" with no known verb → treat as click target (e.g. "Login", "Submit")
  const oneOrTwo = s.split(/\s+/).filter(Boolean);
  if (oneOrTwo.length >= 1 && oneOrTwo.length <= 4) {
    const possibleClick = oneOrTwo.join(" ");
    if (possibleClick.length > 0) return { action: "click", target: trimQuotes(possibleClick) };
  }

  return null;
}

module.exports = { parseInstructionDynamically, VERBS };
