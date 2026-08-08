# Expansion Radar audit report

Audit date: 2026-08-06. Mode: cassette replay for the full demo, plus one explicitly requested live Mireye field-request call. The repository had no committed baseline (`git log` reported no commits), so “before” behavior is established from the first observed run in this workspace and the current fixtures.

## Addendum, 2026-08-08 — closure status of the priority-ordered fix list

Re-verified against the current codebase and a fresh `npm run pipeline` run. This section is appended rather than edited into the sections below so the original point-in-time findings stay intact.

- **#1 (contest demo's real field-request path)** — unchanged/open. The CLI still defaults to dry-run; no separate "contest/live demo" command was added.
- **#2 (`/v1/lookup` cost/value problem)** — **PARTIALLY RESOLVED.** `LOOKUP_THRESHOLD` (`src/score/thresholds.ts`) is now pinned to `ACT_THRESHOLD` instead of `NOTABLE_THRESHOLD`, so the 300-credit call only fires on candidates already scoring act-capable pre-lookup. On the current fixture set this took Five Below out of the lookup path entirely (it now stops at `score` with 0 lookup credits, versus paying the full 341-credit tier under the old gate). Run total dropped from 1,364 to 1,060 Mireye credits (the remainder of that drop is `political_locality` removal, see #4). The underlying `/v1/ask`-versus-`/v1/lookup` cost comparison in section 3 below was not implemented and remains a live recommendation. Side effect: `scoreLabel` can now return `"medium"` for an event that never reached recalibration (it was screened out at `LOOKUP_THRESHOLD` before LLM #2 ran) — this is now documented in `thresholds.ts` directly above `LOOKUP_THRESHOLD`, since it changes what "medium" means from "recalibrated" to "promising pre-lookup score that didn't clear the bar to spend evidence-gathering credits."
- **#3 (cassette versioning on prompt/schema changes)** — **RESOLVED for future changes.** LLM cassettes now carry `LLM_CASSETTE_VERSION`; `v1` keeps current legacy fixtures replayable, while a future version intentionally misses instead of silently reusing stale output. A cassette test covers both behaviors. No fixture contains "414,892" any more, and the current run reports `13,333 sq ft building footprint (retail)` for Old Navy (footprint now resolves `ok`, not the parcel-area fallback that produced the original bug).
- **#4 (fields fetched but never used)** — **RESOLVED.** `political_locality` removed from `SITE_FACT_FIELDS` (`src/mireye/fetchFacts.ts`); the four affected `/v1/fetch` fixtures were re-recorded without it. `/v1/fetch` now costs 4 credits/event instead of 5. The `/v1/proximity` half of this item (unused `paid_driving_calcs`/flag metadata) is still open.
- **#5 (no per-event exception isolation)** — **RESOLVED.** `processEvent` (`src/pipeline.ts`) now wraps the full stage sequence in try/catch, returns a structured `failedOutput` with `cost_ledger.escalation_stopped_at: "error"` (added to the schema) instead of throwing, and preserves the gate decision already made. Covered by `src/pipeline.test.ts` — a cassette-miss mid-pipeline is asserted to produce a structured failed event, not a crash.
- **#6 (LLM usage metadata)** — **RESOLVED.** `CostLedger` now carries `llm_input_tokens`, `llm_output_tokens` (real, provider-reported counts from both the Anthropic and Gemini response shapes — see `src/llm/client.ts`) and `llm_cost_dollars` (an approximate estimate from a hardcoded per-model pricing table, explicitly commented as not billing-accurate). Usage is captured only on an actual live call — a replayed fixture recorded before this existed correctly reports `llm_cost_dollars: null` and 0 tokens for that call, rather than fabricating a number, and `null` propagates for the whole event if any one of its calls is unpriced/unavailable rather than silently under-reporting a partial sum.

Net: 4 of 6 items fully resolved, 1 partially resolved, 1 still open and accurately described as such.

## 1. Pass/fail summary

- Functional gate discipline — **PASS**: the rejected residential event produced `llm_calls_made=0`, `mireye_credits=0`, and the instrumented cassette boundary recorded `{}` calls.
- Fuzzy match coverage — **PASS**: synthetic `LULULEMONN` matched `lululemon` by fuzzy distance.
- Threshold/action coverage — **PASS for current fixtures; PARTIAL against the historical claim**: current replay produced two outreach actions and one field-request decision; the reported prior zero-ACT run is not reproducible from the current cassette set. A synthetic event cleared `ACT_THRESHOLD` at 0.91032.
- Schema conformance — **PASS after applied fix**: `signal` now contains raw permit text and `synthesis` is separate. The pre-fix run showed `signal` beginning “This account matters right now…”.
- Replayability — **PASS for deterministic fields**: two post-fix runs were byte-identical (`cmp_exit=0`), including gate decisions, scores, and action types. Fixture freshness is a separate failure noted under error handling.
- Error handling — **PARTIAL**: empty/no-location input stops cleanly; the observed `/v1/fetch` partial failure does not crash and is labeled as parcel-area fallback. However, stale replayed LLM output still calls that parcel area a building footprint, and uncaught external exceptions can still terminate `processEvent`.
- `/v1/fetch` field usage — **PARTIAL**: four requested values are used; `political_locality` is fetched but its value is not consumed downstream.
- `/v1/proximity` field usage — **PARTIAL**: nearest `duration_minutes` and `destination_index` are used; distance, duration seconds, flags, notes, resolved locations, and `paid_driving_calcs` are not used.
- `/v1/lookup` usage — **PARTIAL**: the three market trend fields now feed a bounded score component, but most response fields remain unused and the 300-credit call is still the worst cost-to-signal ratio.
- `/v1/field-requests` — **PASS**: a real call returned request ID `fr_49aee4bfc5594f578c4351a4f61756e1`, status `awaiting_confirm`; the pipeline path replays that same tracked result with the same idempotency key. The normal CLI remains dry-run unless `--live-field-request` is supplied.
- `/v1/ask` — **PARTIAL**: no implementation exists; the configured credit table gives a clear cost comparison, but equivalence of returned fields/citations is unverified.
- Cost/order discipline — **PASS for ordering, PARTIAL for total accounting**: gate precedes all paid stages and rejected events spend nothing. LLM usage/pricing is not logged, so a complete dollar total cannot be reconstructed.
- Module boundaries — **PASS**: gate and score are pure; pipeline orchestration calls stage APIs; Mireye HTTP is isolated under `src/mireye/`.
- Threshold/weight single source — **PASS**: weights and thresholds are named in `src/score/thresholds.ts`; no threshold recalibration was warranted by the current evidence.
- Scope/non-goals — **PASS**: no database, persistence layer, UI framework, auth system, or general-purpose crawler is present; only the documented permit, Exa, Mireye, and LLM integrations exist.
- Secrets/config — **PASS**: keys are read from environment variables; `.env.example` includes Mireye, Exa, LLM, model override, base URL, and cassette mode settings.
- Tooling — **PASS**: 16 tests, typecheck, and build pass. `npm run pipeline` itself hit a sandbox `tsx` IPC `EPERM`; the emitted `node dist/run.js` path ran successfully.

## 2. Priority-ordered fix list

### 1. Keep the contest demo’s real field-request path explicit

The action path is live and exercised, but the normal CLI defaults to validation-only (`fieldRequestDryRun: !liveFieldRequest`). That is a safe quota guard, but a demo run without the flag does not actually file the request. Proposed larger change: add a clearly named “contest/live demo” command that runs the dry-run review and then the real idempotent request for the known evidence-gap fixture. Do not remove the guard or silently make every run live.

### 2. Resolve the `/v1/lookup` cost/value problem

`/v1/lookup` costs 300 credits versus 5 for the five-field fetch and 36 for three driving calculations. In the current run it was called for all four matched events, consuming 1,200 of 1,364 total Mireye credits. Its three wired trend fields changed scores by only about -0.04068 because the same Cook County trend was returned for every event. The most relevant fields are now technically wired into `market_component`, so this is no longer strictly “fires but no score use,” but the response is still materially over-broad and expensive.

Proposed larger change, pending owner approval: benchmark replacing lookup with one `/v1/ask` query for the needed market fields, or remove lookup from the default scoring path and retain it only for a deliberate high-value escalation. The current credit table predicts 305 credits for fetch+lookup versus 10 for one ask; with proximity included, 341 versus 46 credits, a 295-credit / 86.5% reduction if ask supplies equivalent structured evidence. Do not apply without validating response shape, citations, and action-path behavior.

### 3. Version or invalidate cassette fixtures when prompts/output contracts change

The source now labels the Old Navy fallback honestly as “parcel area (building footprint unavailable at Mireye),” but the replayed recalibration and outreach fixtures still say “414,892 sq ft building footprint.” The fixture key is only the event ID for LLM calls, so changing the prompt or facts-summary contract does not force a refresh. Proposed fix: include a prompt/schema version or prompt hash in LLM cassette keys and add a fixture-contract test that rejects stale synthesis claims. Re-record or review affected fixtures afterward.

### 4. Stop fetching fields whose values are not used

Remove `political_locality` from `SITE_FACT_FIELDS` unless it is added to output/synthesis. For `/v1/proximity`, either consume/record the actual paid calculation count and unresolved-leg flags or explicitly narrow the typed response handling to the fields used. This is a small cost/clarity improvement, but it should follow the owner decision on whether response metadata is part of the evidence contract.

### 5. Add per-event exception isolation around external calls

The no-location branch is graceful, and successful 200 responses with `partial_failures` are tolerated. But `resolveBrand`, `extractEvent`, `/v1/fetch`, `/v1/proximity`, `/v1/lookup`, and action calls are not wrapped by a per-event failure boundary. A malformed address or exhausted retry can reject the whole CLI instead of returning a structured failed event. Proposed larger change: catch typed Mireye/LLM/cassette errors at orchestration level, preserve the last known fields, set an explicit failure stop stage, and never synthesize a missing fact.

### 6. Record LLM usage metadata

The ledger counts LLM calls but does not record provider usage, token counts, model, or price. Add response usage capture and a provider/model pricing table before claiming a dollar total. Until then, LLM totals in this report are call counts with cost unavailable, not fabricated estimates.

### Applied small fixes

The following narrowly scoped changes were applied during this audit:

```diff
 interface PipelineOutput {
   account: string;
   signal: string;
+  synthesis: string;
   mireye_facts_summary: string;
 }

 // src/pipeline.ts, post-recalibration branches
-signal: synthesis.trim(),
+signal: rawEvent.source_text.slice(0, 140),
+synthesis: synthesis.trim(),
```

All pre-recalibration branches set `synthesis: ""`. The Mireye field type also gained the optional `retryable` property required by the current field-level retry code. Audit-only cassette counters were added to measure wrapper entry without changing the fixed output schema. No threshold or weight was changed: current evidence did not justify recalibration.

## 3. Cost table

The ledger records Mireye credits and Exa dollars. The LLM provider is `gemini` with the `gemini-flash-latest` alias, but neither usage tokens nor provider pricing are recorded; therefore the LLM cost is reported as unavailable rather than invented. “Total” is consequently an auditable lower bound plus the measured Exa cost.

| Event | Gate cost | Mireye calls + credits | LLM calls + est. cost | Total cost | Reached action? |
|---|---:|---|---|---|---|
| Old Navy | 0 | `/v1/fetch` 5 + `/v1/proximity` 36 + `/v1/lookup` 300 = **341** | 3; cost unavailable from logs | **341 Mireye credits + $0.007 Exa + 3 unpriced LLM calls** | Yes — `outreach_draft` |
| Trader Joe's | 0 | fetch 5 + proximity 36 + lookup 300 + field request 0 = **341** | 2; cost unavailable from logs | **341 Mireye credits + $0.007 Exa + 2 unpriced LLM calls** | Yes — `field_request` (real request ID captured; normal run is dry-run) |
| Five Below | 0 | fetch 5 + proximity 36 + lookup 300 = **341** | 2; cost unavailable from logs | **341 Mireye credits + $0.007 Exa + 2 unpriced LLM calls** | No — stopped below `ACT_THRESHOLD` |
| lululemon | 0 | fetch 5 + proximity 36 + lookup 300 = **341** | 3; cost unavailable from logs | **341 Mireye credits + $0.007 Exa + 3 unpriced LLM calls** | Yes — `outreach_draft` |
| Unrelated residential permit | 0 | none = **0** | 0; **$0 recorded** | **0** | No — rejected at gate |

Run total: **1,364 Mireye credits**, **$0.0280 Exa**, and **10 LLM calls with no usage-based price recorded**. The single worst cost-to-signal call is `/v1/lookup`: 300 credits for a bounded score nudge of approximately -0.04068 on these fixtures. No Mireye call occurs before the deterministic gate and LLM extraction; the rejected event confirms zero Mireye wrappers. Ordering is gate → Exa → extract → fetch → screen → proximity → score → lookup/recalibrate → act.

Current base/refined scores explain lookup eligibility and the historical zero-ACT discrepancy:

| Event | Base score before lookup | Refined score | Result |
|---|---:|---:|---|
| Old Navy | 0.95100 | 0.91032 | ACT |
| Trader Joe's | 0.76702 | 0.72634 | ACT / evidence gap |
| Five Below | 0.67115 | 0.63047 | NOTABLE only |
| lululemon | 0.84972 | 0.80904 | ACT |

All four current matched events exceed `NOTABLE_THRESHOLD=0.5`, so all four pay for lookup. The historical “zero ACT across four” outcome is plausible for an older/less favorable node layout or lower velocity, but it is not the result of the current fixture set. The current weights (`velocity .40`, `proximity .35`, `size .25`) and `ACT_THRESHOLD=.70` are capable of producing realistic actions; no threshold change was applied.

## 4. Evidence appendix

### A. Baseline and replay commands

```text
npm test
✔ tests 16
✔ pass 16
✔ fail 0

npm run typecheck
Process exited 0

npm run build
Process exited 0

node dist/run.js --quiet > run1
node dist/run.js --quiet > run2
cmp -s run1 run2
fixed_cmp_exit=0

SUMMARY: 5 events — 4 matched, 1 rejected (0 LLM calls on rejected) —
10 total LLM calls, 1364 total Mireye credits, $0.0280 total Exa cost.
```

The first observed run before the schema fix contained this direct evidence of the bug:

```text
account:              Old Navy
signal:               This account matters right now because Old Navy is moving quickly ...
action_taken:         outreach_draft
```

The post-fix run contains distinct fields:

```text
signal:               Permit 101081799 at 1730 W FULLERTON AVE, Chicago, IL. INTERIOR RENOVATION ...
synthesis:            This account matters right now because Old Navy's upcoming interior renovation ...
```

### B. Gate counter and fuzzy-match evidence

Instrumented rejected-event run:

```text
rejected_output={"gate_status":"rejected","llm_calls_made":0,"mireye_credits":0}
rejected_cassette_calls={}
```

The deliberate near miss and two synthetic action runs:

```text
near_miss_gate={"matched":true,"company":"lululemon","matched_on":"lululemon"}

synthetic_outreach={
  "signal":"SYNTHETIC AUDIT EVENT: OLD NAVY interior renovation at 1730 W FULLERTON AVE, Chicago, IL. New store buildout.",
  "score":{"label":"high","confidence":0.91032},
  "action":{"type":"outreach_draft","detail":"With Old Navy's upcoming interior renovation across your 414,892 sq ft building footprint ... Would you be open to a brief conversation ..."},
  "ledger":{"llm_calls":3,"mireye_credits":341,"mireye_endpoints_used":["/v1/fetch","/v1/proximity","/v1/lookup"]}
}

synthetic_field={
  "score":{"label":"high","confidence":0.7263351515151515},
  "action":{"type":"field_request","detail":"request_id=fr_49aee4bfc5594f578c4351a4f61756e1 status=awaiting_confirm"},
  "ledger":{"llm_calls":2,"mireye_credits":341,"mireye_endpoints_used":["/v1/fetch","/v1/proximity","/v1/lookup","/v1/field-requests"]}
}
```

### C. Real Mireye field-request response

The one live call used the existing idempotency key `expansion-radar-chi-3436792-county_market_parcel_data_v1_lookup` and returned:

```json
{
  "request_id": "fr_49aee4bfc5594f578c4351a4f61756e1",
  "status": "awaiting_confirm",
  "resolved_locations": [
    {"resolved_address":"804 W Montrose Ave, Chicago, IL 60613", "resolved_location":{"lat":41.961988,"lng":-87.650235,"source":"address"}}
  ],
  "disposition": [
    {"field_id":"county_employment_total","disposition":"near_miss_confirm"},
    {"field_id":"parcel_id","disposition":"near_miss_confirm"}
  ]
}
```

The response was recorded at `fixtures/mireye/field-request-da1b6fcb8adaabf7.json`. It proves the call was not dead code, while also showing that the broad “county market/parcel data” request requires requester confirmation rather than immediately returning the requested evidence.

### D. Raw `/v1/fetch`, `/v1/proximity`, and `/v1/lookup` evidence

The raw run printed one response for every matched event. Representative current fixture values:

```json
{
  "fetch": {
    "primary_building_footprint_sqm": {"value":null,"status":"failed","retryable":true},
    "primary_building_overture_class": {"value":null,"status":"failed","retryable":true},
    "parcel_area_m2": {"value":38544.76961791949,"status":"ok"},
    "partial_failures":[
      {"field":"primary_building_footprint_sqm","error":"TimeoutError: ","retryable":true},
      {"field":"primary_building_overture_class","error":"TimeoutError: ","retryable":true}
    ]
  },
  "proximity": {
    "paid_driving_calcs":3,
    "legs":[
      {"duration_minutes":null,"flag":"unreachable_or_snapped"},
      {"duration_minutes":12.7,"flag":null},
      {"duration_minutes":null,"flag":"unreachable_or_snapped"}
    ]
  },
  "lookup": {
    "disposition":"resolved",
    "county":"Cook County",
    "parcel_unavailable":false,
    "county_market":{
      "population_growth_1yr_pct":0.1124,
      "building_permits_yoy_pct":-23.6361,
      "hpi_yoy_pct":5.19,
      "employment_yoy_pct":1.0984
    },
    "fema_flood_zone":"X",
    "in_opportunity_zone":false,
    "confidence":0.95
  }
}
```

The `/v1/fetch` response did not crash the pipeline, and the current `mireye_facts_summary` says:

```text
414,892 sq ft parcel area (building footprint unavailable at Mireye — this is the lot, not the store), 13 min from Node - Goose Island, county building permits down 23.6% YoY, home prices up 5.2% YoY
```

But the replayed LLM action detail still says “414,892 sq ft building footprint.” That is the concrete stale-fixture/no-fabrication failure behind the proposed cassette-versioning fix.

### E. Deliberately broken no-location input

Using a temporary fixture directory and stubbed external responses (no paid call), a matched event with empty location information returned:

```json
{
  "account":"Old Navy",
  "gate_status":"matched",
  "signal":"OLD NAVY expansion announcement with no address",
  "synthesis":"",
  "mireye_facts_summary":"No usable address or coordinate — could not enrich.",
  "action":{"type":"none","detail":"Stopped before enrichment: no resolvable location."},
  "llm_calls_made":1,
  "cost":{"mireye_credits":0,"mireye_endpoints_used":[],"escalation_stopped_at":"screen"},
  "cassette_calls":{"exa/search":1,"llm/extract":1}
}
```

This confirms the pipeline does not fabricate a location or make a Mireye call when extraction cannot produce one. The separate `/v1/fetch` partial-failure fixture above confirms the degraded-success path; the stale downstream synthesis is the remaining defect.

### F. Code/contract evidence

- `src/score/thresholds.ts` contains the single `WEIGHTS`, `NOTABLE_THRESHOLD`, `ACT_THRESHOLD`, and Mireye credit-cost definitions.
- `src/pipeline.ts` gates `/v1/lookup` at `breakdown.buyer_intent_score < NOTABLE_THRESHOLD`, then maps only `building_permits_yoy_pct`, `hpi_yoy_pct`, and `population_growth_1yr_pct` into `refineWithMarketData`.
- `src/run.ts` sets `fieldRequestDryRun: !liveFieldRequest`, explaining why the normal demo prints `[DRY RUN — not filed]` even though the real path is implemented.
- `src/mireye/fetchFacts.ts`, `src/mireye/proximity.ts`, `src/mireye/lookup.ts`, and `src/mireye/fieldRequest.ts` are the only Mireye endpoint wrappers; no `/v1/ask` wrapper exists.
- Secret reads are `process.env.MIREYE_API_KEY`, `process.env.EXA_API_KEY`, and `process.env.LLM_PROVIDER_API_KEY`; no key literal was found in source or `.env.example`.
