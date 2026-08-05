// Deterministic buyer-intent scoring. Pure function — no network, no LLM.
// Returns the full breakdown (not just the final number) so the demo can
// show exactly how each component contributed.

import type { ScoreBreakdown } from "../schemas/index.js";
import {
  ACT_THRESHOLD,
  MARKET_BONUS_WEIGHT,
  MARKET_HPI_YOY_MAX_PCT,
  MARKET_HPI_YOY_MIN_PCT,
  MARKET_PERMITS_YOY_MAX_PCT,
  MARKET_PERMITS_YOY_MIN_PCT,
  MARKET_POP_GROWTH_MAX_PCT,
  MARKET_POP_GROWTH_MIN_PCT,
  NOTABLE_THRESHOLD,
  PROXIMITY_MAX_MINUTES,
  PROXIMITY_MIN_MINUTES,
  SIZE_MAX_SQFT,
  SIZE_MIN_SQFT,
  SQM_TO_SQFT,
  VELOCITY_MAX_EVENTS_FOR_FULL_SCORE,
  WEIGHTS,
} from "./thresholds.js";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Linear normalize x from [lo, hi] to [0, 1], clamped at both ends. */
function normalize(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

export interface ScoreInputs {
  /** Count of watchlist-brand permits for this company within the rolling window. */
  velocityCount: number;
  /** Drive-time minutes to the nearest reference node, or null if proximity couldn't be computed. */
  proximityMinutes: number | null;
  /** Building footprint in square meters from Mireye, or null if the field came back absent/failed. */
  footprintSqm: number | null;
  /** Fallback parcel area in square meters, used only if footprintSqm is unavailable. */
  parcelAreaM2: number | null;
}

export function scoreEvent(inputs: ScoreInputs): ScoreBreakdown {
  const velocity_component = normalize(
    inputs.velocityCount,
    0,
    VELOCITY_MAX_EVENTS_FOR_FULL_SCORE,
  );

  const proximity_component =
    inputs.proximityMinutes === null
      ? 0
      : // closer = higher score, so invert the normalized minutes
        1 - normalize(inputs.proximityMinutes, PROXIMITY_MIN_MINUTES, PROXIMITY_MAX_MINUTES);

  const sizeSourceSqm = inputs.footprintSqm ?? inputs.parcelAreaM2;
  const evidence_gap = sizeSourceSqm === null;
  const size_component = evidence_gap
    ? 0
    : normalize(sizeSourceSqm * SQM_TO_SQFT, SIZE_MIN_SQFT, SIZE_MAX_SQFT);

  const buyer_intent_score =
    velocity_component * WEIGHTS.velocity +
    proximity_component * WEIGHTS.proximity +
    size_component * WEIGHTS.size;

  return {
    velocity_component,
    proximity_component,
    size_component,
    buyer_intent_score,
    evidence_gap,
    ...(evidence_gap ? { evidence_gap_field: "primary_building_footprint_sqm" } : {}),
    // Not evaluated yet — that data doesn't exist until /v1/lookup returns.
    market_component: 0,
    market_evidence_gap: false,
  };
}

export function scoreLabel(score: number): "high" | "medium" | "low" {
  if (score >= ACT_THRESHOLD) return "high";
  if (score >= NOTABLE_THRESHOLD) return "medium";
  return "low";
}

export interface MarketRefinementInputs {
  /** False if the /v1/lookup call itself failed or returned disposition !== "resolved". */
  lookupSucceeded: boolean;
  /** Real county_market fields from a successful lookup, or null if genuinely absent. */
  countyMarket: {
    building_permits_yoy_pct: number;
    hpi_yoy_pct: number;
    population_growth_1yr_pct: number;
  } | null;
  /** False when lookup resolved but returned no parcel (a real, observed outcome — see schemas/index.ts). */
  parcelAvailable: boolean;
}

/**
 * Refine an already-computed screening score with real county-level market
 * momentum from /v1/lookup (300 credits — the most expensive Mireye call in
 * the pipeline, so its data needs to actually earn its keep). This is a
 * BOUNDED ADDITIVE nudge on top of the velocity/proximity/size score, not a
 * reweighted fourth component: county_market only exists post-lookup, so it
 * can refine an already-notable candidate's confidence but never gate the
 * cheap NOTABLE_THRESHOLD screening decision that decided whether to spend
 * the 300 credits in the first place.
 *
 * A genuinely missing lookup result — the call failed, or resolved without
 * a parcel (real, observed: an interpolated/low-confidence address match
 * can resolve to a location with no parcel intersect) — is itself an
 * evidence gap, on the same footing as a missing footprint field.
 */
export function refineWithMarketData(
  base: ScoreBreakdown,
  inputs: MarketRefinementInputs,
): ScoreBreakdown {
  const market_evidence_gap = !inputs.lookupSucceeded || inputs.countyMarket === null || !inputs.parcelAvailable;

  const market_component = inputs.countyMarket
    ? (normalize(inputs.countyMarket.building_permits_yoy_pct, MARKET_PERMITS_YOY_MIN_PCT, MARKET_PERMITS_YOY_MAX_PCT) +
        normalize(inputs.countyMarket.hpi_yoy_pct, MARKET_HPI_YOY_MIN_PCT, MARKET_HPI_YOY_MAX_PCT) +
        normalize(
          inputs.countyMarket.population_growth_1yr_pct,
          MARKET_POP_GROWTH_MIN_PCT,
          MARKET_POP_GROWTH_MAX_PCT,
        )) /
      3
    : 0;

  // Momentum above the neutral midpoint (0.5) adds up to MARKET_BONUS_WEIGHT;
  // below it subtracts up to the same amount. No countyMarket at all -> no bonus.
  const marketBonus = inputs.countyMarket ? (market_component - 0.5) * 2 * MARKET_BONUS_WEIGHT : 0;

  const evidence_gap = base.evidence_gap || market_evidence_gap;
  const missingFields = [
    base.evidence_gap ? base.evidence_gap_field : null,
    market_evidence_gap ? "county market/parcel data (/v1/lookup)" : null,
  ].filter((f): f is string => !!f);

  return {
    ...base,
    buyer_intent_score: clamp01(base.buyer_intent_score + marketBonus),
    market_component,
    market_evidence_gap,
    evidence_gap,
    ...(missingFields.length > 0 ? { evidence_gap_field: missingFields.join(", ") } : {}),
  };
}
