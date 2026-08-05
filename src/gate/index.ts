// Deterministic watchlist gate. Zero network calls, zero LLM calls — this
// is the free-rejection step the one-pager's cost-discipline claim rests
// on, so it must actually be free. Matches on exact substring first, then
// falls back to a small-edit-distance (Levenshtein) window match so a
// permit reading "TRADER JOES" still matches watchlist entry "Trader Joe's"
// without being an exact string.

import type { GateResult, RawEvent, WatchlistCompany } from "../schemas/index.js";

const FUZZY_MAX_DISTANCE = 2;

function normalize(s: string): string {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** True if `candidate` appears verbatim, or within FUZZY_MAX_DISTANCE edits, in `haystack`. */
function isMatch(haystack: string, candidate: string): "exact" | "fuzzy" | null {
  const normHaystack = normalize(haystack);
  const normCandidate = normalize(candidate);
  if (normCandidate.length === 0) return null;

  if (normHaystack.includes(normCandidate)) return "exact";

  // Sliding window over the haystack, same character-length ballpark as the
  // candidate, checking edit distance. Windows are word-boundary aligned so
  // we're comparing "phrase to phrase," not arbitrary substrings.
  const words = normHaystack.split(" ");
  const candidateWordCount = normCandidate.split(" ").length;

  for (let i = 0; i + candidateWordCount <= words.length; i++) {
    const window = words.slice(i, i + candidateWordCount).join(" ");
    if (Math.abs(window.length - normCandidate.length) > FUZZY_MAX_DISTANCE) continue;
    if (levenshtein(window, normCandidate) <= FUZZY_MAX_DISTANCE) return "fuzzy";
  }
  return null;
}

/**
 * Check a raw permit event against the watchlist. Pure function: no
 * network, no LLM. Matches against both the permit's free-text description
 * and its contact/owner names (brands are often named in one but not the
 * other — a description may say "OLD NAVY" while the owner of record is an
 * LLC, or vice versa).
 */
export function matchWatchlist(rawEvent: RawEvent, watchlist: WatchlistCompany[]): GateResult {
  const haystack = [rawEvent.source_text, ...rawEvent.contacts].join(" ");

  for (const company of watchlist) {
    const candidates = [company.name, ...(company.aliases ?? [])];
    for (const candidate of candidates) {
      const kind = isMatch(haystack, candidate);
      if (kind) {
        return { matched: true, company: company.name, matched_on: candidate };
      }
    }
  }
  return { matched: false };
}
