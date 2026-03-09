/**
 * Bridge copy of elementFinder logic (plain JS so bridge can require without TS build).
 * Fuzzy search over DOM snapshot: aria-label, text, id, class, placeholder, role.
 */

const MIN_SCORE_THRESHOLD = 0.1;

/**
 * Normalizes a string for fuzzy matching: trim, lowercase, collapse whitespace to single space.
 * @param {string} s - Raw string (e.g. from aria-label, text, placeholder).
 * @returns {string} Normalized string.
 */
function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Splits a string into non-empty words (after normalizing).
 * @param {string} s - Input string.
 * @returns {string[]} Array of words.
 */
function toWords(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

/**
 * Scores how well a field value matches a query (exact match, contains, or word overlap).
 * Used to rank DOM snapshot entries when searching by text/placeholder/aria-label etc.
 * @param {string} fieldValue - Value from the snapshot entry (e.g. entry.text).
 * @param {string} query - Search query (e.g. "search", "Submit").
 * @returns {number} Score between 0 and 1.
 */
function fieldScore(fieldValue, query) {
  const nq = normalize(query);
  const nf = normalize(fieldValue);
  if (!nq) return 0;
  if (!nf) return 0;
  if (nf === nq) return 1;
  if (nf.includes(nq)) return 0.6;
  if (nf.startsWith(nq) || nq.startsWith(nf)) return 0.5;
  const qWords = toWords(query);
  const fWords = new Set(toWords(fieldValue));
  let wordScore = 0;
  let matchedWords = 0;
  for (const w of qWords) {
    if (fWords.has(w)) {
      wordScore += 0.35;
      matchedWords += 1;
    } else if ([...fWords].some((f) => f.includes(w) || w.includes(f))) {
      wordScore += 0.2;
      matchedWords += 1;
    }
  }
  if (qWords.length > 0) wordScore = Math.min(0.5, wordScore / qWords.length);
  if (qWords.length >= 2 && matchedWords < qWords.length * 0.5) return 0;
  return wordScore;
}

/**
 * Global aliases: minimal set of common terms so any app works without site-specific config.
 * Used only to expand variants; primary matching is by query + words (see below).
 * Keep this small—design for millions of products/words via patterns and variants, not enum growth.
 */
const GLOBAL_FILL_ALIASES = {
  username: ["email", "login", "user", "phone"],
  email: ["username", "login", "user"],
  password: ["pass", "pwd"],
  search: ["q", "query", "search box"],
  gym: ["search gym", "gym search"],
};
const GLOBAL_CLICK_ALIASES = {
  login: ["sign in", "log in", "submit", "signin"],
  submit: ["login", "sign in", "log in"],
  go: ["submit", "search button"],
  save: ["save for later", "save item", "save changes", "save and close"],
};

/** Common typos so automation finds the right element (e.g. "Comapnies" → "Companies"). */
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
  sucessful: "successful",
  logn: "login",
  sigin: "sign in",
  sigout: "sign out",
  serach: "search",
  serch: "search",
  sve: "save",
  sav: "save",
};

/** Generic words we must not match on alone for click/hover when query has other words (avoids "Companies Menu" matching random "Menu"). */
const GENERIC_CLICK_WORDS = new Set(["menu", "button", "link", "tab", "item", "dropdown", "icon", "option"]);

/**
 * Returns variants for fuzzy matching: query, its words, and optional global aliases.
 * Dynamic: "search gym" → ["search gym", "search", "gym"] so any "Search gym" placeholder matches
 * without hardcoding site-specific phrases. Supports millions of user phrasings.
 * @param {string} query - Original query (e.g. "search gym", "admin panel").
 * @param {string} [action] - "fill" | "type" | "click" | "hover" for alias expansion.
 * @returns {string[]} List of query and variants to score against.
 */
function getQueryVariants(query, action) {
  const q = normalize(query);
  if (!q) return [];
  const words = toWords(query).filter((w) => w.length > 1);
  const list = [q, ...words];

  // Add corrected spellings so "Comapnies Menu" matches "Companies" in the DOM.
  for (const word of words) {
    const corrected = COMMON_TYPO_CORRECTIONS[word];
    if (corrected && corrected !== word) list.push(corrected);
  }
  const correctedPhrase = q
    .split(/\s+/)
    .map((w) => COMMON_TYPO_CORRECTIONS[w] || w)
    .join(" ");
  if (correctedPhrase !== q) list.push(correctedPhrase);

  if (action === "fill" || action === "type") {
    for (const [key, vals] of Object.entries(GLOBAL_FILL_ALIASES)) {
      if (key === q || vals.includes(q) || words.includes(key)) {
        list.push(key, ...vals);
        break;
      }
    }
  }
  if (action === "click" || action === "hover") {
    for (const [key, vals] of Object.entries(GLOBAL_CLICK_ALIASES)) {
      if (key === q || vals.includes(q) || words.includes(key)) {
        list.push(key, ...vals);
        break;
      }
    }
    // When query has multiple words, do not use generic words as standalone variants (avoids clicking wrong "Menu" for "Companies Menu").
    if (words.length >= 2) {
      list = list.filter((v) => !GENERIC_CLICK_WORDS.has((v || "").trim().toLowerCase()));
    }
  }
  return [...new Set(list)];
}

/**
 * Computes a single entry's match score against the query by scoring aria-label, text, id, name,
 * className, placeholder, and role. For fill/type, also scores query aliases (e.g. username -> email).
 * @param {object} entry - One item from the DOM snapshot (selector, tagName, id, name, text, placeholder, ariaLabel, role).
 * @param {string} query - Search query.
 * @param {string} [action] - "fill" | "type" to enable alias scoring.
 * @returns {{ score: number, hint: string }} Score and comma-separated list of fields that matched.
 */
function scoreEntry(entry, query, action) {
  const variants = getQueryVariants(query, action);
  if (variants.length === 0) return { score: 0, hint: "" };
  let bestScore = 0;
  let bestHints = [];
  for (const q of variants) {
    const nq = normalize(q);
    if (!nq) continue;
    let score = 0;
    const hints = [];
    const ariaScore = fieldScore(entry.ariaLabel, q);
    if (ariaScore > 0) {
      score += ariaScore * 1.2;
      hints.push("aria-label");
    }
    const textScore = fieldScore(entry.text, q);
    if (textScore > 0) {
      score += textScore * 1.1;
      hints.push("text");
    }
    const idScore = fieldScore(entry.id, q);
    if (idScore > 0) {
      score += idScore * 1.0;
      hints.push("id");
    }
    const nameScore = fieldScore(entry.name || "", q);
    if (nameScore > 0) {
      score += nameScore * 1.1;
      hints.push("name");
    }
    const classScore = fieldScore(entry.className, q);
    if (classScore > 0) {
      score += classScore * 0.7;
      hints.push("class");
    }
    const placeholderScore = fieldScore(entry.placeholder || "", q);
    if (placeholderScore > 0) {
      score += placeholderScore * 0.9;
      hints.push("placeholder");
    }
    const roleScore = fieldScore(entry.role || "", q);
    if (roleScore > 0) {
      score += roleScore * 0.8;
      hints.push("role");
    }
    if (score > bestScore) {
      bestScore = score;
      bestHints = hints;
    }
  }
  return { score: bestScore, hint: bestHints.join(",") };
}

/**
 * @param {Array} snapshot - from getDomSnapshotInPage (has selector, tagName, id, text, placeholder, etc.)
 * @param {string} query - e.g. "search"
 * @param {string} [action] - "fill" | "type" | "click" | etc. For "fill"/"type" we prefer input/textarea only.
 */
function findCandidates(snapshot, query, action) {
  if (!query || !snapshot?.length) return [];
  let list = snapshot;
  if (action === "fill" || action === "type") {
    const editableInputTypes = new Set(["text", "search", "email", "tel", "url", "password", ""]);
    const fillable = snapshot.filter((e) => {
      if (e.tagName === "textarea") return true;
      if (e.tagName !== "input") return false;
      const type = (e.type || "").toLowerCase();
      return editableInputTypes.has(type);
    });
    if (fillable.length > 0) list = fillable;
  }
  return list
    .map((entry) => {
      const { score, hint } = scoreEntry(entry, query, action);
      return { selector: entry.selector, score, matchHint: hint || undefined };
    })
    .filter((c) => c.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

/**
 * Returns the best-matching CSS selector for the query, or null if no candidate meets the threshold.
 * For "fill"/"type" actions, only input and textarea elements are considered.
 * If no candidate matches and action is fill/type, returns the first text-like input as fallback for login pages.
 * @param {Array} snapshot - DOM snapshot from getDomSnapshotInPage.
 * @param {string} query - Search query (e.g. "search").
 * @param {string} [action] - Optional action; "fill" or "type" limits to editable elements.
 * @returns {string | null} The selector string (e.g. [data-fs-id="fs-0"]) or null.
 */
function findBestSelector(snapshot, query, action) {
  let candidates = findCandidates(snapshot, query, action);
  if (candidates.length === 0) {
    if (action === "fill" || action === "type") {
      const editableInputTypes = new Set(["text", "search", "email", "tel", "url", "password", ""]);
      const fillable = snapshot.filter((e) => {
        if (e.tagName === "textarea") return true;
        if (e.tagName !== "input") return false;
        return editableInputTypes.has((e.type || "").toLowerCase());
      });
      const textLike = fillable.filter((e) => {
        const type = (e.type || "").toLowerCase();
        return ["text", "email", "tel", "", "search"].includes(type);
      });
      if (textLike.length >= 1) return textLike[0].selector;
    }
    return null;
  }
  if (action === "click" || action === "hover") {
    const nq = normalize(query);
    const qWords = nq.split(/\s+/).filter(Boolean);
    if (qWords.length >= 2) {
      // Prefer full phrase in text/ariaLabel (e.g. "Admin Control Panel"); if none, use best variant match (e.g. "Search Button" -> "Go")
      const phraseCandidates = candidates.filter((c) => {
        const entry = snapshot.find((e) => e.selector === c.selector);
        const text = normalize((entry && (entry.text || entry.ariaLabel)) || "");
        return text.includes(nq);
      });
      if (phraseCandidates.length > 0) {
        candidates = phraseCandidates;
      }
      // else: keep candidates (scored via aliases, e.g. "Search Button" matches "Go" button)
      candidates = [...candidates].sort((a, b) => {
        const entryA = snapshot.find((e) => e.selector === a.selector);
        const entryB = snapshot.find((e) => e.selector === b.selector);
        const textA = normalize((entryA && (entryA.text || entryA.ariaLabel)) || "");
        const textB = normalize((entryB && (entryB.text || entryB.ariaLabel)) || "");
        const phraseA = textA.includes(nq);
        const phraseB = textB.includes(nq);
        if (phraseA && !phraseB) return -1;
        if (!phraseA && phraseB) return 1;
        return b.score - a.score;
      });
    }
  }
  return candidates[0].selector;
}

/** Returns typo-corrected string for click/hover targets (e.g. "Comapnies Menu" → "Companies Menu"). */
function getTypoCorrectedTarget(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const words = trimmed.split(/\s+/);
  const corrected = words.map((w) => COMMON_TYPO_CORRECTIONS[w.toLowerCase()] || w).join(" ");
  return corrected !== trimmed ? corrected : null;
}

module.exports = { findCandidates, findBestSelector, getTypoCorrectedTarget };
