import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreEvent, scoreLabel, refineWithMarketData } from "./index.js";
import { ACT_THRESHOLD, MARKET_BONUS_WEIGHT, NOTABLE_THRESHOLD, SQM_TO_SQFT } from "./thresholds.js";

test("high-velocity, close, large flagship scores above ACT_THRESHOLD", () => {
  const result = scoreEvent({
    velocityCount: 4,
    proximityMinutes: 5,
    footprintSqm: 5000 / SQM_TO_SQFT, // ~5000 sqft
    parcelAreaM2: null,
  });
  assert.equal(result.evidence_gap, false);
  assert.ok(result.buyer_intent_score >= ACT_THRESHOLD, `expected >= ${ACT_THRESHOLD}, got ${result.buyer_intent_score}`);
});

test("single low-cost sign permit, far from any node, scores below NOTABLE_THRESHOLD", () => {
  const result = scoreEvent({
    velocityCount: 1,
    proximityMinutes: 60,
    footprintSqm: 800 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  assert.ok(
    result.buyer_intent_score < NOTABLE_THRESHOLD,
    `expected < ${NOTABLE_THRESHOLD}, got ${result.buyer_intent_score}`,
  );
});

test("mid-velocity, mid-distance event lands between NOTABLE and ACT thresholds", () => {
  const result = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 25,
    footprintSqm: 2500 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  assert.ok(result.buyer_intent_score >= NOTABLE_THRESHOLD);
  assert.ok(result.buyer_intent_score < ACT_THRESHOLD);
});

test("missing footprint field falls back to parcel area, not silently zero", () => {
  const withFootprint = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 20,
    footprintSqm: 3000 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  const withParcelFallback = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 20,
    footprintSqm: null,
    parcelAreaM2: 3000 / SQM_TO_SQFT,
  });
  assert.equal(withFootprint.evidence_gap, false);
  assert.equal(withParcelFallback.evidence_gap, false);
  assert.equal(withFootprint.size_component, withParcelFallback.size_component);
});

test("both size fields absent sets evidence_gap — the real field-request trigger", () => {
  const result = scoreEvent({
    velocityCount: 3,
    proximityMinutes: 15,
    footprintSqm: null,
    parcelAreaM2: null,
  });
  assert.equal(result.evidence_gap, true);
  assert.equal(result.evidence_gap_field, "primary_building_footprint_sqm");
  assert.equal(result.size_component, 0);
});

test("scoreLabel boundaries", () => {
  assert.equal(scoreLabel(0.75), "high");
  assert.equal(scoreLabel(0.5), "medium");
  assert.equal(scoreLabel(0.2), "low");
});

test("refineWithMarketData: strong positive momentum nudges score up, bounded by MARKET_BONUS_WEIGHT", () => {
  const base = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 20,
    footprintSqm: 3000 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  const refined = refineWithMarketData(base, {
    lookupSucceeded: true,
    countyMarket: { building_permits_yoy_pct: 20, hpi_yoy_pct: 10, population_growth_1yr_pct: 2 },
    parcelAvailable: true,
  });
  assert.equal(refined.market_evidence_gap, false);
  assert.ok(refined.buyer_intent_score > base.buyer_intent_score);
  assert.ok(refined.buyer_intent_score - base.buyer_intent_score <= MARKET_BONUS_WEIGHT + 1e-9);
});

test("refineWithMarketData: weak/negative momentum nudges score down", () => {
  const base = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 20,
    footprintSqm: 3000 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  const refined = refineWithMarketData(base, {
    lookupSucceeded: true,
    countyMarket: { building_permits_yoy_pct: -20, hpi_yoy_pct: 0, population_growth_1yr_pct: -1 },
    parcelAvailable: true,
  });
  assert.ok(refined.buyer_intent_score < base.buyer_intent_score);
});

test("refineWithMarketData: missing parcel is a genuine evidence gap — the real field-request trigger", () => {
  const base = scoreEvent({
    velocityCount: 4,
    proximityMinutes: 5,
    footprintSqm: 5000 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  assert.equal(base.evidence_gap, false); // size data was fine — the gap here is lookup-specific
  const refined = refineWithMarketData(base, {
    lookupSucceeded: true,
    countyMarket: { building_permits_yoy_pct: 5, hpi_yoy_pct: 5, population_growth_1yr_pct: 0.5 },
    parcelAvailable: false, // real, observed Mireye outcome — see MireyeLookupResponse doc comment
  });
  assert.equal(refined.market_evidence_gap, true);
  assert.equal(refined.evidence_gap, true);
  assert.match(refined.evidence_gap_field ?? "", /lookup/);
});

test("refineWithMarketData: failed lookup call is also an evidence gap, with no score nudge", () => {
  const base = scoreEvent({
    velocityCount: 2,
    proximityMinutes: 20,
    footprintSqm: 3000 / SQM_TO_SQFT,
    parcelAreaM2: null,
  });
  const refined = refineWithMarketData(base, {
    lookupSucceeded: false,
    countyMarket: null,
    parcelAvailable: false,
  });
  assert.equal(refined.market_evidence_gap, true);
  assert.equal(refined.buyer_intent_score, base.buyer_intent_score);
});

test("refineWithMarketData: pre-existing size gap and a new market gap both surface in evidence_gap_field", () => {
  const base = scoreEvent({
    velocityCount: 3,
    proximityMinutes: 15,
    footprintSqm: null,
    parcelAreaM2: null,
  });
  assert.equal(base.evidence_gap, true);
  const refined = refineWithMarketData(base, {
    lookupSucceeded: true,
    countyMarket: null,
    parcelAvailable: false,
  });
  assert.match(refined.evidence_gap_field ?? "", /primary_building_footprint_sqm/);
  assert.match(refined.evidence_gap_field ?? "", /lookup/);
});
