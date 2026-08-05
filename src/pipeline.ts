// Orchestrates one event through the full tiered-escalation pipeline:
//   gate -> resolve(Exa) -> extract(LLM#1) -> fetch(T1) -> [screen]
//   -> proximity(T2) -> score -> [NOTABLE?] -> lookup(T3) -> recalibrate(LLM#2)
//   -> [ACT?] -> outreach_draft | field_request
//
// Cheap calls run on every matched event; expensive ones only run on
// survivors of the previous threshold. Every early exit is recorded in
// cost_ledger.escalation_stopped_at so the cost-discipline claim is visible
// in the output, not just asserted.

import { matchWatchlist } from "./gate/index.js";
import { resolveBrand } from "./sources/exa.js";
import { extractEvent } from "./extract/index.js";
import { fetchFacts, SITE_FACT_FIELDS } from "./mireye/fetchFacts.js";
import { proximityToNodes } from "./mireye/proximity.js";
import { lookup } from "./mireye/lookup.js";
import { scoreEvent, scoreLabel, refineWithMarketData } from "./score/index.js";
import { NOTABLE_THRESHOLD, ACT_THRESHOLD, SQM_TO_SQFT } from "./score/thresholds.js";
import { recalibrate } from "./recalibrate/index.js";
import { draftOutreach } from "./act/draftOutreach.js";
import { requestFieldForGap } from "./act/requestField.js";
import { Ledger } from "./ledger.js";
import type {
  PipelineOutput,
  RawEvent,
  ReferenceNode,
  WatchlistCompany,
} from "./schemas/index.js";

/** Overture building classes that indicate a genuine commercial/retail site. */
const COMMERCIAL_CLASSES = new Set(["commercial", "retail", "civic", "industrial"]);

/** Chicago's residential-only zoning district prefixes (RS-, RT-, RM-). */
const RESIDENTIAL_ONLY_ZONING = /^R/i;

/**
 * `primary_building_overture_class` reflects the DOMINANT use across the
 * whole building, so a mixed-use building (ground-floor retail, apartments
 * above — very common in Chicago) can come back "apartments" even for a
 * genuine retail buildout permit at that address. Confirmed against a live
 * response: Trader Joe's 804 W Montrose buildout (real $700K permit) came
 * back overture_class "apartments" but zoning "PD-138" (Planned
 * Development — commonly mixed-use, not residential-only). Fall back to
 * zoning rather than trust the building-level class alone.
 */
function isCommercialCapable(overtureClass: string | null, zoning: string | null): boolean {
  if (overtureClass && COMMERCIAL_CLASSES.has(overtureClass.toLowerCase())) return true;
  if (zoning && !RESIDENTIAL_ONLY_ZONING.test(zoning)) return true;
  return false;
}

function formatFactsSummary(
  sizeSqft: number | null,
  // Parcel area (the legal lot — can include parking, adjacent land, an
  // entire shopping center) is NOT the same fact as building footprint, and
  // must never be presented as if it were. Verified live: Old Navy's real
  // footprint field timed out, the fallback substituted parcel_area_m2
  // (38,545 sqm — a Federal Realty shopping-center parcel), and without this
  // distinction the output claimed a "massive 414,892 sq ft footprint" for
  // what's actually a normal-sized retail buildout.
  sizeSource: "footprint" | "parcel_area",
  overtureClass: string | null,
  nearestNode: string,
  nearestMinutes: number | null,
): string {
  const sizePart =
    sizeSqft !== null
      ? sizeSource === "footprint"
        ? `${Math.round(sizeSqft).toLocaleString()} sq ft building footprint${overtureClass ? ` (${overtureClass})` : ""}`
        : `${Math.round(sizeSqft).toLocaleString()} sq ft parcel area (building footprint unavailable at Mireye — this is the lot, not the store)`
      : "building footprint unavailable at Mireye";
  const proximityPart =
    nearestMinutes !== null ? `${Math.round(nearestMinutes)} min from ${nearestNode}` : "distance unresolved";
  return `${sizePart}, ${proximityPart}`;
}

/** Appends /v1/lookup's county-market signal to the base facts summary, once available (tier 3 only). */
function appendMarketSummary(
  base: string,
  countyMarket: { building_permits_yoy_pct: number; hpi_yoy_pct: number } | null,
): string {
  if (!countyMarket) return `${base}, county market data unavailable at Mireye`;
  const permitsTrend = countyMarket.building_permits_yoy_pct >= 0 ? "up" : "down";
  return (
    `${base}, county building permits ${permitsTrend} ${Math.abs(countyMarket.building_permits_yoy_pct).toFixed(1)}% YoY, ` +
    `home prices up ${countyMarket.hpi_yoy_pct.toFixed(1)}% YoY`
  );
}

export interface ProcessEventOptions {
  /** Count of watchlist-brand permits for this company within the rolling velocity window (see run.ts). */
  velocityCount: number;
  /** Guard field-request calls behind validation-only mode; see src/act/requestField.ts. */
  fieldRequestDryRun?: boolean;
  /**
   * Called with each raw Mireye response as it's received (fetch, proximity,
   * lookup), with its source/fetched_at/confidence metadata still attached —
   * lets run.ts print at least one raw, cited response for the demo
   * recording without adding it to the fixed PipelineOutput schema.
   */
  onRawMireyeResponse?: (label: string, raw: unknown) => void;
}

export async function processEvent(
  rawEvent: RawEvent,
  watchlist: WatchlistCompany[],
  nodes: ReferenceNode[],
  options: ProcessEventOptions,
): Promise<PipelineOutput> {
  const ledger = new Ledger();

  // --- Stage 1: Gate (0 cost) ---
  const gate = matchWatchlist(rawEvent, watchlist);
  if (!gate.matched || !gate.company) {
    ledger.setStoppedAt("gate");
    return {
      account: "unknown",
      signal: rawEvent.source_text.slice(0, 140),
      synthesis: "",
      mireye_facts_summary: "",
      buyer_intent: { label: "low", confidence: 0 },
      action_taken: { type: "none", detail: "Rejected at gate — no watchlist match." },
      sources: [rawEvent.source_url],
      gate_status: "rejected",
      llm_calls_made: 0,
      cost_ledger: ledger.toJSON(),
    };
  }

  // --- Stage 2: Exa brand resolution (corroboration, not primary signal) ---
  const exa = await resolveBrand({
    gateMatchedCompany: gate.company,
    address: null,
    permitOwnerNames: rawEvent.contacts,
  });
  ledger.recordExaCost(exa.cost_dollars);

  // --- Stage 3: Extract (LLM #1) ---
  const extracted = await extractEvent(rawEvent, gate.company);
  ledger.recordLlmCall();

  // --- Stage 4: Tier 1 — /v1/fetch (site facts) ---
  type ResolvedLocation =
    | { kind: "address"; address: string }
    | { kind: "coordinate"; lat: number; lng: number };

  const extractedAddress = extracted.address;
  const location: ResolvedLocation | null =
    extractedAddress !== null && !extracted.needs_geocode
      ? { kind: "address", address: extractedAddress }
      : rawEvent.lat !== null && rawEvent.lng !== null
        ? { kind: "coordinate", lat: rawEvent.lat, lng: rawEvent.lng }
        : null;

  if (!location) {
    ledger.setStoppedAt("screen");
    return {
      account: gate.company,
      signal: rawEvent.source_text.slice(0, 140),
      synthesis: "",
      mireye_facts_summary: "No usable address or coordinate — could not enrich.",
      buyer_intent: { label: "low", confidence: 0 },
      action_taken: { type: "none", detail: "Stopped before enrichment: no resolvable location." },
      sources: [rawEvent.source_url],
      gate_status: "matched",
      llm_calls_made: ledger.toJSON().llm_calls,
      cost_ledger: ledger.toJSON(),
    };
  }

  const facts = await fetchFacts(
    location.kind === "address" ? { address: location.address } : { lat: location.lat, lng: location.lng },
  );
  ledger.recordFetch(SITE_FACT_FIELDS.length);
  options.onRawMireyeResponse?.("/v1/fetch", facts);

  const overtureClassField = facts.fields["primary_building_overture_class"];
  const overtureClass =
    overtureClassField?.status === "ok" ? String(overtureClassField.value) : null;
  const zoningField = facts.fields["parcel_zoning"];
  const zoning = zoningField?.status === "ok" ? String(zoningField.value) : null;

  // --- Screen: is this even a commercial site worth scoring? ---
  if (!isCommercialCapable(overtureClass, zoning)) {
    ledger.setStoppedAt("screen");
    return {
      account: gate.company,
      signal: rawEvent.source_text.slice(0, 140),
      synthesis: "",
      mireye_facts_summary: `Overture class "${overtureClass ?? "unknown"}", zoning "${zoning ?? "unknown"}" — not a commercial/retail-capable site.`,
      buyer_intent: { label: "low", confidence: 0 },
      action_taken: { type: "none", detail: "Screened out: site is not commercial/retail-capable." },
      sources: [
        rawEvent.source_url,
        facts.fields["primary_building_overture_class"]?.source_url,
        facts.fields["parcel_zoning"]?.source_url,
      ].filter((u): u is string => !!u),
      gate_status: "matched",
      llm_calls_made: ledger.toJSON().llm_calls,
      cost_ledger: ledger.toJSON(),
    };
  }

  // --- Stage 5: Tier 2 — /v1/proximity to reference nodes ---
  const origin: string = location.kind === "address" ? location.address : `${location.lat},${location.lng}`;
  const { raw: proximityRaw, nearestIndex, nearestMinutes } = await proximityToNodes(
    origin,
    nodes.map((n) => n.address),
  );
  ledger.recordProximity(nodes.length);
  options.onRawMireyeResponse?.("/v1/proximity", proximityRaw);
  const nearestNode = nearestIndex !== null ? (nodes[nearestIndex]?.label ?? "unknown node") : "no reachable node";

  // --- Stage 6: Score (pure function, no LLM) ---
  const footprintField = facts.fields["primary_building_footprint_sqm"];
  const parcelAreaField = facts.fields["parcel_area_m2"];
  const breakdown = scoreEvent({
    velocityCount: options.velocityCount,
    proximityMinutes: nearestMinutes,
    footprintSqm: footprintField?.status === "ok" ? Number(footprintField.value) : null,
    parcelAreaM2: parcelAreaField?.status === "ok" ? Number(parcelAreaField.value) : null,
  });

  const sizeSource: "footprint" | "parcel_area" = footprintField?.status === "ok" ? "footprint" : "parcel_area";
  const sizeSqft =
    footprintField?.status === "ok"
      ? Number(footprintField.value) * SQM_TO_SQFT
      : parcelAreaField?.status === "ok"
        ? Number(parcelAreaField.value) * SQM_TO_SQFT
        : null;
  const factsSummary = formatFactsSummary(sizeSqft, sizeSource, overtureClass, nearestNode, nearestMinutes);

  const sources = [
    rawEvent.source_url,
    ...Object.values(facts.fields)
      .filter((f) => f.status === "ok")
      .map((f) => f.source_url),
    ...exa.corroborating_urls,
  ];

  if (breakdown.buyer_intent_score < NOTABLE_THRESHOLD) {
    ledger.setStoppedAt("score");
    return {
      account: gate.company,
      signal: rawEvent.source_text.slice(0, 140),
      synthesis: "",
      mireye_facts_summary: factsSummary,
      buyer_intent: { label: scoreLabel(breakdown.buyer_intent_score), confidence: breakdown.buyer_intent_score },
      action_taken: { type: "none", detail: "Below NOTABLE_THRESHOLD — no recalibration, no action." },
      sources,
      gate_status: "matched",
      llm_calls_made: ledger.toJSON().llm_calls,
      cost_ledger: ledger.toJSON(),
    };
  }

  // --- Stage 7: Tier 3 — /v1/lookup (300 credits, survivors only) ---
  const lookupRaw = await lookup(origin);
  ledger.recordLookup();
  options.onRawMireyeResponse?.("/v1/lookup", lookupRaw);

  // Refine the screening score with lookup's real county-market data — a
  // bounded nudge, not a reweight (see refineWithMarketData doc comment).
  // A missing parcel (real, observed outcome — see MireyeLookupResponse) or
  // a call that didn't resolve is itself an evidence gap.
  const refined = refineWithMarketData(breakdown, {
    lookupSucceeded: lookupRaw.disposition === "resolved",
    countyMarket: lookupRaw.county_market
      ? {
          building_permits_yoy_pct: lookupRaw.county_market.building_permits_yoy_pct,
          hpi_yoy_pct: lookupRaw.county_market.hpi_yoy_pct,
          population_growth_1yr_pct: lookupRaw.county_market.population_growth_1yr_pct,
        }
      : null,
    parcelAvailable: !lookupRaw.parcel_unavailable && lookupRaw.parcel !== undefined,
  });
  const refinedFactsSummary = appendMarketSummary(factsSummary, lookupRaw.county_market ?? null);

  // --- Stage 8: Recalibrate (LLM #2) ---
  const synthesis = await recalibrate(extracted, refinedFactsSummary, refined);
  ledger.recordLlmCall();

  if (refined.buyer_intent_score < ACT_THRESHOLD) {
    ledger.setStoppedAt("score");
    return {
      account: gate.company,
      signal: rawEvent.source_text.slice(0, 140),
      synthesis: synthesis.trim(),
      mireye_facts_summary: refinedFactsSummary,
      buyer_intent: { label: scoreLabel(refined.buyer_intent_score), confidence: refined.buyer_intent_score },
      action_taken: { type: "none", detail: "Above NOTABLE_THRESHOLD but below ACT_THRESHOLD — no action taken." },
      sources,
      gate_status: "matched",
      llm_calls_made: ledger.toJSON().llm_calls,
      cost_ledger: ledger.toJSON(),
    };
  }

  // --- Stage 9: Act ---
  ledger.setStoppedAt("completed");
  let actionResult;
  if (refined.evidence_gap) {
    actionResult = await requestFieldForGap(
      extracted,
      refined.evidence_gap_field ?? "primary_building_footprint_sqm",
      origin,
      { dryRun: options.fieldRequestDryRun },
    );
    ledger.recordFieldRequest();
  } else {
    const draft = await draftOutreach(extracted, synthesis.trim(), refinedFactsSummary);
    ledger.recordLlmCall();
    actionResult = { type: "outreach_draft" as const, detail: draft };
  }

  return {
    account: gate.company,
    signal: rawEvent.source_text.slice(0, 140),
    synthesis: synthesis.trim(),
    mireye_facts_summary: refinedFactsSummary,
    buyer_intent: { label: scoreLabel(refined.buyer_intent_score), confidence: refined.buyer_intent_score },
    action_taken: actionResult,
    sources,
    gate_status: "matched",
    llm_calls_made: ledger.toJSON().llm_calls,
    cost_ledger: ledger.toJSON(),
  };
}
