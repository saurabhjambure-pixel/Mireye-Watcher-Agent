// One-time fixture authoring tool — NOT part of the runtime pipeline.
//
// Why this exists: the demo needs real permit data (genuinely live-fetched,
// no key required — Chicago's Socrata endpoint is public) plus Mireye/Exa/LLM
// responses shaped exactly like the verified live contract. Nobody on this
// build has a Mireye or Exa key yet (Day 0 of the plan — sign up with code
// GROWTH — hasn't happened), so this script drives the REAL pipeline code
// (fetchFacts, proximityToNodes, lookup, fieldRequest, extractEvent,
// recalibrate, draftOutreach, resolveBrand) with global.fetch patched to
// return crafted-but-schema-correct responses for api.mireye.com, api.exa.ai,
// and the configured LLM_PROVIDER's endpoint (gemini or anthropic), while
// letting the real Chicago permits call through untouched. Every fixture
// this produces is clearly a PLACEHOLDER pending a real `RECORD=1` pass once
// real keys are in `.env` — see CLAUDE.md.
//
// Run: npx tsx scripts/author-fixtures.ts

process.env.RECORD = "1";
process.env.MIREYE_API_KEY ||= "placeholder-mireye-key";
process.env.EXA_API_KEY ||= "placeholder-exa-key";
process.env.LLM_PROVIDER_API_KEY ||= "placeholder-llm-key";
process.env.LLM_PROVIDER ||= "gemini";

import { fetchPermitById } from "../src/sources/permits.js";
import { processEvent } from "../src/pipeline.js";
import type { ReferenceNode, WatchlistCompany } from "../src/schemas/index.js";

const realFetch = global.fetch;

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "X-Request-ID": "req_demo_placeholder", ...headers },
  });
}

// --- Per-event synthetic profiles -------------------------------------------
// Detected by matching a distinctive substring against the outgoing request
// (address, permit street name, or company name — whichever the call
// actually carries). Values are plausible placeholders, not live-verified
// facts; replace via `RECORD=1` with real keys once available.

interface Profile {
  detect: string; // substring to match against url+body text (street name)
  companyName: string; // substring to match against recalibrate/outreach prompts (no street name in those)
  footprintSqm: number | null; // null => field comes back "absent" (evidence gap)
  parcelAreaM2: number | null;
  overtureClass: string;
  nearestNodeIndex: number;
  nearestMinutes: number;
  exaUrls: string[];
  extractJson: string;
  recalibrateText: string | null; // null if this event never reaches recalibrate
  outreachText: string | null;
}

const PROFILES: Profile[] = [
  {
    detect: "FULLERTON",
    companyName: "Old Navy",
    footprintSqm: 460,
    parcelAreaM2: 900,
    overtureClass: "commercial",
    nearestNodeIndex: 2,
    nearestMinutes: 22,
    exaUrls: [
      "https://chicagoretailwatch.example.com/old-navy-fullerton-buildout",
      "https://retaildive-demo.example.com/old-navy-chicago-expansion",
    ],
    extractJson: JSON.stringify({
      address: "1730 W Fullerton Ave, Chicago, IL",
      needs_geocode: false,
      event_type: "new_store_buildout",
      event_date: "2026-08-03",
    }),
    recalibrateText:
      "Old Navy's fourth Chicago-area buildout this quarter is a genuine flagship at roughly 4,950 sq ft and just 22 minutes from Node - Elk Grove Village — a serviceable, high-priority account.",
    outreachText:
      "Saw Old Navy's new buildout at 1730 W Fullerton Ave — the fourth Chicago-area opening this quarter per city permit records. At roughly 4,950 sq ft and 22 minutes from our Elk Grove Village node, this location sits well within our service radius. Worth a conversation about fulfillment for it.",
  },
  {
    detect: "MONTROSE",
    companyName: "Trader Joe's",
    footprintSqm: 350,
    parcelAreaM2: 700,
    overtureClass: "commercial",
    nearestNodeIndex: 2,
    nearestMinutes: 24,
    exaUrls: [
      "https://chicagoretailwatch.example.com/trader-joes-montrose",
      "https://groceryinsider-demo.example.com/trader-joes-lincoln-square",
    ],
    extractJson: JSON.stringify({
      address: "804 W Montrose Ave, Chicago, IL",
      needs_geocode: false,
      event_type: "new_store_buildout",
      event_date: "2026-03-27",
    }),
    recalibrateText:
      "Trader Joe's $700K ground-floor buildout on Montrose signals real commitment, but at 24 minutes from the nearest node and mid-range velocity this is a watch, not yet a priority.",
    outreachText: null,
  },
  {
    detect: "33RD",
    companyName: "Five Below",
    footprintSqm: null,
    parcelAreaM2: null,
    overtureClass: "commercial",
    nearestNodeIndex: 1,
    nearestMinutes: 45,
    exaUrls: ["https://retaildive-demo.example.com/five-below-bridgeport-coming-soon"],
    extractJson: JSON.stringify({
      address: null,
      needs_geocode: true,
      event_type: "new_store_opening_signage",
      event_date: "2025-08-25",
    }),
    recalibrateText: null,
    outreachText: null,
  },
  {
    detect: "RUSH",
    companyName: "lululemon",
    footprintSqm: null,
    parcelAreaM2: null,
    overtureClass: "commercial",
    nearestNodeIndex: 2,
    nearestMinutes: 10,
    exaUrls: [
      "https://chicagoretailwatch.example.com/lululemon-rush-street",
      "https://retaildive-demo.example.com/lululemon-gold-coast-expansion",
    ],
    extractJson: JSON.stringify({
      address: "930 N Rush St, Chicago, IL",
      needs_geocode: false,
      event_type: "storefront_signage",
      event_date: "2026-06-29",
    }),
    recalibrateText:
      "Four lululemon Chicago-area permits this window and just 10 minutes from Node - Elk Grove Village make this account highly serviceable, even though Mireye has no footprint on file yet for this unit — worth closing that gap before committing outreach.",
    outreachText: null,
  },
];

function findProfile(text: string): Profile {
  const upper = text.toUpperCase();
  const match = PROFILES.find((p) => upper.includes(p.detect));
  if (!match) throw new Error(`No fixture profile matched request text (looking for one of: ${PROFILES.map((p) => p.detect).join(", ")})\n${text.slice(0, 300)}`);
  return match;
}

/** Recalibrate/outreach prompts carry the company name, not a street address. */
function findProfileByCompany(text: string): Profile {
  const match = PROFILES.find((p) => text.includes(p.companyName));
  if (!match) throw new Error(`No fixture profile matched company name in prompt:\n${text.slice(0, 300)}`);
  return match;
}

const NODE_ADDRESSES = [
  "20901 Walter Strawn Drive, Elwood, IL 60421",
  "969 Veterans Parkway, Bolingbrook, IL 60446",
  "2301 Lively Blvd, Elk Grove Village, IL 60007",
];

// --- Patched fetch: real network for Socrata, canned for everything else ---
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

  if (url.includes("data.cityofchicago.org")) {
    return realFetch(input as any, init);
  }

  const bodyText = init?.body ? String(init.body) : "";

  if (url.includes("api.mireye.com/v1/fetch")) {
    const body = JSON.parse(bodyText) as { address?: string; lat?: number; lng?: number; fields: string[] };
    const detectText = body.address ?? `${body.lat},${body.lng}`;
    // For the lat/lng-only case (Five Below), detect via known coordinate.
    const profile =
      body.address !== undefined
        ? findProfile(body.address)
        : PROFILES.find((p) => p.detect === "33RD")!;
    void detectText;

    const now = new Date().toISOString();
    const field = (value: unknown, source: string) => ({
      value,
      unit: null,
      source,
      source_url: `https://mireye.example.com/sources/${source}`,
      confidence: value === null ? "unknown" : "high",
      fetched_at: now,
      dataset_vintage: "2025",
      ttl_seconds: 86400,
      notes: null,
      status: value === null ? "absent" : "ok",
    });

    return jsonResponse({
      lat: body.lat ?? 41.9,
      lng: body.lng ?? -87.65,
      fetched_at: now,
      fields: {
        primary_building_footprint_sqm: field(profile.footprintSqm, "overture_buildings"),
        primary_building_overture_class: field(profile.overtureClass, "overture_buildings"),
        parcel_zoning: field("B3-2", "regrid"),
        parcel_area_m2: field(profile.parcelAreaM2, "regrid"),
        political_locality: field("Chicago", "overture_divisions"),
      },
      partial_failures:
        profile.footprintSqm === null
          ? [{ field: "primary_building_footprint_sqm", source: "overture_buildings", error: "no_match", retryable: false }]
          : [],
      resolved_location: { lat: body.lat ?? 41.9, lng: body.lng ?? -87.65, source: body.address ? "address" : "coordinate" },
    });
  }

  if (url.includes("api.mireye.com/v1/proximity")) {
    const body = JSON.parse(bodyText) as { origins: string[]; destinations: string[] };
    const origin = body.origins[0] ?? "";
    // A "lat,lng" origin has no letters at all — a street address always
    // does (at minimum a street/city name). Don't test for a leading digit:
    // house numbers ("804 W Montrose...") also start with one.
    const isCoordinateOrigin = !/[A-Za-z]/.test(origin);
    const profile = isCoordinateOrigin ? PROFILES.find((p) => p.detect === "33RD")! : findProfile(origin);
    const legs = body.destinations.map((_dest, i) => {
      const isNearest = i === profile.nearestNodeIndex;
      const minutes = isNearest ? profile.nearestMinutes : profile.nearestMinutes + 15 + i * 5;
      return {
        origin_index: 0,
        destination_index: i,
        distance_miles: Number((minutes * 0.6).toFixed(1)),
        distance_km: Number((minutes * 0.97).toFixed(1)),
        duration_seconds: minutes * 60,
        duration_minutes: minutes,
        flag: null,
      };
    });
    return jsonResponse({
      op: "distance",
      legs,
      resolved_origins: [],
      resolved_destinations: [],
      paid_driving_calcs: legs.length,
      notes: ["coverage: US + Canada", "durations reflect typical traffic", "PLACEHOLDER fixture — not live-verified"],
    });
  }

  if (url.includes("api.mireye.com/v1/lookup")) {
    const body = JSON.parse(bodyText) as { input: string };
    const profile = findProfile(body.input);
    return jsonResponse({
      input: body.input,
      resolved_address: body.input,
      coordinate: { lat: 41.9, lng: -87.65 },
      parcel: { zoning: "B3-2", overture_class: profile.overtureClass },
      context: { opportunity_zone: false, flood_risk: "low" },
      fetched_at: new Date().toISOString(),
    });
  }

  if (url.includes("api.mireye.com/v1/field-requests")) {
    return jsonResponse({
      request_id: "fr_demo_lululemon001",
      status: "queued",
      disposition: [],
      resolved_locations: [],
      queue_position: 1,
      estimated_ready_at: null,
      context_blob: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  if (url.includes("api.exa.ai")) {
    const body = JSON.parse(bodyText) as { query: string };
    const profile = findProfileByCompany(body.query);
    return jsonResponse({
      results: profile.exaUrls.map((u) => ({ url: u, title: "placeholder", publishedDate: "2026-07-01" })),
      costDollars: { total: 0.005 * profile.exaUrls.length },
      requestId: "req_demo_exa",
    });
  }

  const isAnthropic = url.includes("api.anthropic.com");
  const isGemini = url.includes("generativelanguage.googleapis.com");

  if (isAnthropic || isGemini) {
    const prompt = isAnthropic
      ? ((JSON.parse(bodyText) as { messages: { content: string }[] }).messages[0]?.content ?? "")
      : ((JSON.parse(bodyText) as { contents: { parts: { text: string }[] }[] }).contents[0]?.parts[0]?.text ?? "");

    let text: string;
    if (prompt.includes("extracting structured data")) {
      text = findProfile(prompt).extractJson;
    } else if (prompt.includes("why this account matters")) {
      const profile = findProfileByCompany(prompt);
      if (!profile.recalibrateText) throw new Error("recalibrate called for an event that shouldn't reach it");
      text = profile.recalibrateText;
    } else if (prompt.includes("outreach message")) {
      const profile = findProfileByCompany(prompt);
      if (!profile.outreachText) throw new Error("draftOutreach called for an event that shouldn't reach it");
      text = profile.outreachText;
    } else {
      throw new Error(`Unrecognized LLM prompt shape:\n${prompt.slice(0, 200)}`);
    }

    return isAnthropic
      ? jsonResponse({ content: [{ type: "text", text }] })
      : jsonResponse({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
  }

  throw new Error(`author-fixtures: no canned handler for ${url}`);
}) as typeof fetch;

// --- Drive the real pipeline for each demo event ----------------------------

const watchlist: WatchlistCompany[] = [
  { name: "Old Navy" },
  { name: "Trader Joe's", aliases: ["Trader Joes"] },
  { name: "Five Below" },
  { name: "lululemon", aliases: ["Lululemon Athletica"] },
];

const nodes: ReferenceNode[] = [
  { label: "Node - Elwood, IL", address: NODE_ADDRESSES[0]! },
  { label: "Node - Bolingbrook, IL", address: NODE_ADDRESSES[1]! },
  { label: "Node - Elk Grove Village, IL", address: NODE_ADDRESSES[2]! },
];

// Rolling-window velocity: current live permit + a stated historical count of
// prior known openings for that brand (see demo-data/watchlist.json comment
// and CLAUDE.md — this augments the one live signal per brand we have on
// file with a documented assumption, not fabricated Mireye/Exa data).
const VELOCITY_COUNTS: Record<string, number> = {
  "chi-3445485": 4, // Old Navy: 3 historical + this one
  "chi-3436792": 2, // Trader Joe's: 1 historical + this one
  "chi-3424236": 1, // Five Below: 0 historical + this one
  "chi-3451685": 4, // lululemon: 3 historical + this one
};

const DEMO_PERMIT_IDS = ["3445485", "3436792", "3424236", "3451685", "3429666"];

async function main() {
  for (const id of DEMO_PERMIT_IDS) {
    console.log(`Recording permit fixture for id=${id}...`);
    const event = await fetchPermitById(id);
    if (!event) throw new Error(`No permit found for id=${id}`);

    const velocityCount = VELOCITY_COUNTS[event.id];
    if (velocityCount === undefined) {
      console.log(`  -> reject-case event (${event.id}), no enrichment fixtures needed.`);
      continue;
    }

    console.log(`  -> running full pipeline to author enrichment fixtures for ${event.id}...`);
    const output = await processEvent(event, watchlist, nodes, {
      velocityCount,
      fieldRequestDryRun: false,
    });
    console.log(`     account=${output.account} score=${output.buyer_intent.confidence.toFixed(3)} action=${output.action_taken.type}`);
  }
  console.log("\nDone. Fixtures written under /fixtures. These are PLACEHOLDER Mireye/Exa/LLM");
  console.log("responses pending a real RECORD=1 pass once Mireye/Exa/LLM keys are in .env.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
