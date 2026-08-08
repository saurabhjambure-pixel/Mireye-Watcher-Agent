// Exa search — brand-resolution layer only (see CLAUDE.md). Permits are
// often filed under a contractor or property-LLC name ("MONTROSE AND
// CLARENDON LLC"), not the retail brand itself. Exa resolves "which brand
// is behind this build-out" and corroborates expansion velocity with
// independent coverage. It must never become the primary signal source —
// that would turn the pitch's "execution, not announcements" differentiator
// into exactly the press-coverage category it claims to beat.

import { withCassette } from "../cassette.js";
import { matchText } from "../gate/index.js";
import type { ExaResolution, WatchlistCompany } from "../schemas/index.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

interface ExaSearchResult {
  url: string;
  title?: string;
  publishedDate?: string;
  text?: string;
}

interface ExaSearchResponse {
  results: ExaSearchResult[];
  costDollars?: { total?: number };
  requestId: string;
}

function apiKey(): string {
  const key = process.env.EXA_API_KEY;
  if (!key) {
    throw new Error("EXA_API_KEY is not set. Get a key at exa.ai before running with RECORD=1.");
  }
  return key;
}

/**
 * Resolve the retail brand behind a permit's address/contractor names, and
 * pull corroborating coverage for expansion-velocity scoring. Confidence is
 * "high" only when Exa's results independently name the same brand the gate
 * already matched on (i.e. the permit filing gets outside confirmation).
 */
export async function resolveBrand(args: {
  gateMatchedCompany: string;
  address: string | null;
  permitOwnerNames: string[];
}): Promise<ExaResolution> {
  const query = `"${args.gateMatchedCompany}" new store opening ${args.address ?? ""}`.trim();

  return withCassette({ provider: "exa", op: "search", key: { query } }, async () => {
    const res = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        category: "news",
        contents: { text: { maxCharacters: 500 } },
      }),
    });

    if (!res.ok) {
      throw new Error(`Exa search failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as ExaSearchResponse;
    const corroborating_urls = data.results.map((r) => r.url).slice(0, 3);

    return {
      resolved_brand: corroborating_urls.length > 0 ? args.gateMatchedCompany : null,
      confidence: corroborating_urls.length >= 2 ? "high" : corroborating_urls.length === 1 ? "medium" : "low",
      corroborating_urls,
      cost_dollars: data.costDollars?.total ?? 0,
    } satisfies ExaResolution;
  });
}

/**
 * Matches `permits.ts`'s exact formatting ("Permit {id} at {address},
 * Chicago, IL. {description}...") to pull a clean search subject out of raw
 * permit text — kept dumb and format-specific rather than a general address
 * parser, per CLAUDE.md's non-goals (no general-purpose crawler).
 */
function extractAddressSubject(sourceText: string): string | null {
  const match = sourceText.match(/\bat (.+?), (?:Chicago|Austin), [A-Z]{2}\./);
  return match?.[1] ?? null;
}

/**
 * The real "combine Mireye with something weird" move: a permit that the
 * free gate could NOT match (filed under a contractor or property-LLC name,
 * not the brand — e.g. "FR RIVERPOINT LL", "BEATRIX FULTON MARKET LLC") is
 * not necessarily a non-match. It spends exactly one Exa call searching by
 * the permit's own address/location text for independent news coverage of
 * what's actually opening there, then runs that coverage through the SAME
 * matcher the free gate uses (`matchText`) to see if a watchlist brand is
 * named in the results. This is a genuine resolution step, not
 * corroboration of an already-known brand: `resolved_brand` is derived from
 * Exa's results, never echoed back from an input.
 *
 * Only called by the pipeline on gate-misses judged commercially plausible
 * (see UNMASK_MIN_REPORTED_COST) — this is the one place a "rejected" event
 * can still carry nonzero cost, and it's spent at most once per event.
 */
export async function unmaskBrand(args: {
  sourceText: string;
  watchlist: WatchlistCompany[];
}): Promise<ExaResolution> {
  const subject = extractAddressSubject(args.sourceText) ?? args.sourceText.slice(0, 120);
  const query = `"${subject}" new store opening OR retail lease OR now open`;

  return withCassette({ provider: "exa", op: "unmask", key: { query } }, async () => {
    const res = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        category: "news",
        contents: { text: { maxCharacters: 500 } },
      }),
    });

    if (!res.ok) {
      throw new Error(`Exa search failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as ExaSearchResponse;
    const corroborating_urls = data.results.map((r) => r.url).slice(0, 3);
    const combinedText = data.results.map((r) => `${r.title ?? ""} ${r.text ?? ""}`).join(" ");

    // Reuse the exact same exact/fuzzy matcher the free gate runs over
    // permit text — a brand named in independent news coverage of this
    // address is exactly as valid a match as one named in the permit itself.
    const derivedMatch = matchText(combinedText, args.watchlist);

    return {
      resolved_brand: derivedMatch.matched ? derivedMatch.company ?? null : null,
      confidence: derivedMatch.matched && corroborating_urls.length >= 2 ? "high" : derivedMatch.matched ? "medium" : "low",
      corroborating_urls,
      cost_dollars: data.costDollars?.total ?? 0,
    } satisfies ExaResolution;
  });
}
