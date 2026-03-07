/**
 * Dynamic element finder: fuzzy search over a DOM snapshot to resolve
 * a human-readable target (e.g. "Login button") to a ranked list of selectors.
 * Used by the bridge for component-based mapping and self-healing.
 */

export interface DomSnapshotEntry {
  selector: string;
  tagName: string;
  id: string;
  className: string;
  ariaLabel: string;
  text: string;
  /** Placeholder for inputs */
  placeholder?: string;
  /** role attribute */
  role?: string;
}

export interface RankedCandidate {
  selector: string;
  score: number;
  /** Optional reason for debugging */
  matchHint?: string;
}

const MIN_SCORE_THRESHOLD = 0.1;

/**
 * Normalizes a string for fuzzy comparison: lowercase, collapse whitespace, trim.
 */
function normalize(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Splits query into words for partial matching.
 */
function toWords(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

/**
 * Computes a similarity score between query and a field value.
 * - Exact match (after normalize): 1
 * - Field contains query: 0.6
 * - Field equals query (ignoring case): 0.9
 * - Word overlap: 0.3 per word
 */
function fieldScore(fieldValue: string, query: string): number {
  const nq = normalize(query);
  const nf = normalize(fieldValue);
  if (!nq) return 0;
  if (!nf) return 0;
  if (nf === nq) return 1;
  if (nf.includes(nq)) return 0.6;
  const qWords = toWords(query);
  const fWords = new Set(toWords(fieldValue));
  let wordScore = 0;
  for (const w of qWords) {
    if (fWords.has(w)) wordScore += 0.35;
    else if ([...fWords].some((f) => f.includes(w) || w.includes(f))) wordScore += 0.2;
  }
  if (qWords.length > 0) wordScore = Math.min(0.5, (wordScore / qWords.length));
  return wordScore;
}

/**
 * Scores a single snapshot entry against the query.
 * Weights: aria-label and visible text are strongest; then id; then class.
 */
function scoreEntry(entry: DomSnapshotEntry, query: string): { score: number; hint: string } {
  const q = normalize(query);
  if (!q) return { score: 0, hint: "" };

  let score = 0;
  const hints: string[] = [];

  const ariaScore = fieldScore(entry.ariaLabel, query);
  if (ariaScore > 0) {
    score += ariaScore * 1.2;
    hints.push("aria-label");
  }

  const textScore = fieldScore(entry.text, query);
  if (textScore > 0) {
    score += textScore * 1.1;
    hints.push("text");
  }

  const idScore = fieldScore(entry.id, query);
  if (idScore > 0) {
    score += idScore * 1.0;
    hints.push("id");
  }

  const classScore = fieldScore(entry.className, query);
  if (classScore > 0) {
    score += classScore * 0.7;
    hints.push("class");
  }

  const placeholderScore = fieldScore(entry.placeholder ?? "", query);
  if (placeholderScore > 0) {
    score += placeholderScore * 0.9;
    hints.push("placeholder");
  }

  const roleScore = fieldScore(entry.role ?? "", query);
  if (roleScore > 0) {
    score += roleScore * 0.8;
    hints.push("role");
  }

  return {
    score,
    hint: hints.length ? hints.join(",") : "",
  };
}

/**
 * Returns candidates from the snapshot that match the query, ranked by probability (score descending).
 * Only entries with score >= MIN_SCORE_THRESHOLD are returned.
 */
export function findCandidates(
  snapshot: DomSnapshotEntry[],
  query: string
): RankedCandidate[] {
  if (!query || !snapshot?.length) return [];

  const withScores: RankedCandidate[] = snapshot
    .map((entry) => {
      const { score, hint } = scoreEntry(entry, query);
      return { selector: entry.selector, score, matchHint: hint || undefined };
    })
    .filter((c) => c.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  return withScores;
}

/**
 * Returns the best candidate selector, or null if none above threshold.
 */
export function findBestSelector(
  snapshot: DomSnapshotEntry[],
  query: string
): string | null {
  const candidates = findCandidates(snapshot, query);
  return candidates.length > 0 ? candidates[0].selector : null;
}
