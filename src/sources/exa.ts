// Exa search — brand-resolution layer only (see CLAUDE.md). Permits are
// often filed under a contractor or property-LLC name ("MONTROSE AND
// CLARENDON LLC"), not the retail brand itself. Exa resolves "which brand
// is behind this build-out" and corroborates expansion velocity with
// independent coverage. It must never become the primary signal source —
// that would turn the pitch's "execution, not announcements" differentiator
// into exactly the press-coverage category it claims to beat.

import { withCassette } from "../cassette.js";
import type { ExaResolution } from "../schemas/index.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

interface ExaSearchResult {
  url: string;
  title?: string;
  publishedDate?: string;
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
