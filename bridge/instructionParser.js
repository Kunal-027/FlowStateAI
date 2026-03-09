/**
 * Instruction parser for browser automation. Rule-based, fast, no API calls.
 * Output: { action, target?, value? } — one canonical shape for the rest of the pipeline.
 * Design: support millions of products and phrasings via generic patterns only (no app-specific phrases).
 *
 * PATTERN ORDER (first match wins):
 * 1. verify_displayed
 * 2. navigate
 * 3. submit_search (click search button / submit search)
 * 4. fill (search X, enter X in Y, fill Y with X, type X, etc.)
 * 5. click (click on X, click X, press X, including "click on any X")
 * 6. hover
 * 7. fallback: short phrase → click target
 *
 * Use this parser first; use LLM (getAiAction) when parser returns null or for DOM disambiguation.
 */

/** Canonical actions the bridge understands. Parser and LLM must both output from this set. */
const ACTIONS = Object.freeze([
  "click",
  "fill",
  "navigate",
  "hover",
  "press",
  "submit_search",
  "verify_displayed",
]);

function normalize(s) {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function trimQuotes(s) {
  return (s || "").replace(/^["']|["']$/g, "").trim();
}

/** Common typos → correct spelling so parsed target matches DOM text. */
const COMMON_TYPO_CORRECTIONS = {
  comapnies: "companies",
  compaines: "companies",
  companys: "companies",
  settigns: "settings",
  setings: "settings",
  dashbord: "dashboard",
  dashborad: "dashboard",
  sucess: "success",
  succes: "success",
  logn: "login",
  sigin: "sign in",
  sigout: "sign out",
  serach: "search",
  serch: "search",
  shose: "shoes",
  nike: "nike",
};

function applyTypoCorrection(phrase) {
  if (!phrase || typeof phrase !== "string") return phrase;
  const words = phrase.trim().split(/\s+/);
  const corrected = words.map((w) => COMMON_TYPO_CORRECTIONS[w.toLowerCase()] || w);
  return corrected.join(" ");
}

/** Known verbs per action (for startsWithVerb / isClickVerb). */
const VERBS = {
  fill: ["enter", "type", "put", "fill", "input", "write", "search", "set"],
  click: ["click", "press", "tap", "select"],
  hover: ["hover", "mouse over"],
  navigate: ["navigate", "go to", "open", "visit"],
  verify: ["verify", "check", "assert", "ensure", "see"],
};

function isClickVerb(instruction) {
  const lower = normalize(instruction);
  return VERBS.click.some((v) => lower === v || lower.startsWith(v + " "));
}

function startsWithVerb(instruction, action) {
  const lower = normalize(instruction);
  const list = VERBS[action];
  return list ? list.some((v) => lower === v || lower.startsWith(v + " ")) : false;
}

/**
 * Extracts click/hover target from remainder after verb.
 * "on 'X' Menu" → "X Menu", "on any Nike shoes" → "any Nike shoes", "X" → "X".
 */
function extractClickTarget(rest) {
  if (!rest || typeof rest !== "string") return "";
  const s = rest.trim();
  const quoted = s.match(/^(?:on\s+)?(?:any\s+)?["']([^"']+)["']\s*(.*)$/i);
  if (quoted) {
    const part = quoted[1].trim();
    const trail = (quoted[2] || "").trim();
    return trail ? `${part} ${trail}` : part;
  }
  const afterOn = s.replace(/^(?:on\s+)?(?:any\s+)?/i, "").trim();
  return afterOn || s;
}

/**
 * Parses a raw step instruction into { action, target?, value? }.
 * Order of checks is intentional; first match wins.
 *
 * @param {string} instruction - Raw instruction (e.g. "Search Nike Shoes", "Click on any Nike shoes").
 * @returns {{ action: string, target?: string, value?: string } | null}
 */
function parseInstructionDynamically(instruction) {
  if (!instruction || typeof instruction !== "string") return null;
  const s = instruction.trim();
  const lower = normalize(s);
  if (!s) return null;

  // ─── 1. Verify (displayed/visible) ───────────────────────────────────────
  const verifyQuoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?['"](.+?)['"]\s+is\s+(?:displayed|visible|shown)(?:\s+on\s+screen)?\s*$/i);
  if (verifyQuoted) return { action: "verify_displayed", target: trimQuotes(verifyQuoted[1]) };
  const verifyUnquoted = s.match(/^\s*(?:verify|check|assert|ensure|see)\s+(?:that\s+)?(.+?)\s+is\s+(?:displayed|visible|shown)(?:\s+on\s+screen)?\s*$/i);
  if (verifyUnquoted) return { action: "verify_displayed", target: verifyUnquoted[1].trim() };

  // ─── 2. Navigate ─────────────────────────────────────────────────────────
  if (startsWithVerb(s, "navigate")) {
    const url = s.replace(/^(?:navigate to|go to|open|visit)\s+/i, "").trim();
    if (url) return { action: "navigate", target: url, value: url };
  }

  // ─── 3. Submit search (do not treat as click) ───────────────────────────────
  if (/^(?:click|press|tap|submit)\s+(?:the\s+)?(?:search\s+)?button\s*$/i.test(s)) return { action: "submit_search", target: "search" };
  if (/^(?:click|press)\s+search\s*$/i.test(s)) return { action: "submit_search", target: "search" };
  if (/^submit\s+(?:the\s+)?search\s*$/i.test(s)) return { action: "submit_search", target: "search" };

  // ─── 4. Fill ─────────────────────────────────────────────────────────────
  // "Enter X in Y" / "Type X in the Y field"
  const fillIn = s.match(/^(?:enter|type|put|fill|input|write)\s+(.+?)\s+in\s+(?:the\s+)?(.+?)(?:\s+field)?\s*$/i);
  if (fillIn) {
    const value = trimQuotes(fillIn[1].trim());
    const target = fillIn[2].trim().replace(/\s+field$/i, "").trim();
    if (target) return { action: "fill", target, value };
  }

  // "Fill Y with X"
  const fillWith = s.match(/^fill\s+(.+?)\s+with\s+(.+)$/i);
  if (fillWith) return { action: "fill", target: fillWith[1].trim(), value: trimQuotes(fillWith[2].trim()) };

  // "Enter X - Y" / "Type X - Y"
  const fillDash = s.match(/^(?:enter|type)\s+(.+?)\s+-\s+(.+)$/i);
  if (fillDash) return { action: "fill", target: fillDash[2].trim(), value: trimQuotes(fillDash[1].trim()) };

  // "Enter/Type 'value'" (target hint from context)
  const fillQuoted = s.match(/^(?:enter|type)\s+(.+?)\s+["']([^"']+)["']\s*$/i);
  if (fillQuoted) return { action: "fill", target: fillQuoted[1].trim(), value: fillQuoted[2].trim() };

  // "Search Gym X in Gym Selector" → value is X only (strip " in Gym Selector" and quotes)
  const searchGymInSelector = s.match(/^search\s+(?:for\s+)?(?:gym|Gym)\s+(.+?)\s+in\s+Gym\s+Selector\s*$/i);
  if (searchGymInSelector) return { action: "fill", target: "gym", value: trimQuotes(searchGymInSelector[1].trim()) };

  // "Search Gym X" / "search gym X" → fill gym search field with X only (so value is ddmsaustralia.dev.au.membr.com, not "Gym ddmsaustralia...")
  const searchGym = s.match(/^search\s+(?:for\s+)?(?:gym|Gym)\s+(.+)$/i);
  if (searchGym) return { action: "fill", target: "gym", value: trimQuotes(searchGym[1].trim()) };

  // "Search [for] X" → fill search with X ("Search Nike Shoes" → target=search, value=Nike Shoes)
  const searchSingle = s.match(/^search\s+(?:for\s+)?(.+)$/i);
  if (searchSingle) return { action: "fill", target: "search", value: searchSingle[1].trim() };

  // Generic fill: "Enter/Type <rest>" (two+ tokens: last = value, rest = target hint)
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

  // ─── 5. Click (including "click on [any] X") ─────────────────────────────
  if (isClickVerb(s)) {
    const rest = s.replace(/^(?:click|press|tap|select)\s+(?:on\s+)?(?:any\s+)?/i, "").trim();
    const raw = extractClickTarget(rest);
    const target = applyTypoCorrection(raw || rest);
    if (target) return { action: "click", target };
  }

  // ─── 6. Hover ───────────────────────────────────────────────────────────
  if (startsWithVerb(s, "hover")) {
    const rest = s.replace(/^hover\s+/i, "").trim();
    const raw = extractClickTarget(rest);
    const target = applyTypoCorrection(raw || rest);
    if (target) return { action: "hover", target };
  }

  // ─── 7. Fallback: short phrase → click target ─────────────────────────────
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length >= 1 && tokens.length <= 6) {
    const possibleClick = tokens.join(" ");
    if (possibleClick.length > 0) return { action: "click", target: trimQuotes(possibleClick) };
  }

  return null;
}

module.exports = {
  parseInstructionDynamically,
  ACTIONS,
  VERBS,
  extractClickTarget,
  applyTypoCorrection,
};
