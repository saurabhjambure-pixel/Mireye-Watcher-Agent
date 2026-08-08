# Expansion Radar

Standalone demo agent for the Mireye Build Challenge. New, isolated repo — no
dependency on any other codebase.

## What this is

Watches real commercial building-permit records for expansion signals from a
small hardcoded watchlist of DTC/retail brands, enriches matched signals with
cited physical-world facts from Mireye, scores buyer intent deterministically,
and — above a threshold — acts: drafts outreach copy or files a Mireye field
request to close an evidence gap.

Pipeline: `permits → gate → [unmask(Exa), only on plausible gate-misses] →
resolve(Exa) → extract(LLM#1) → mireye enrich (tiered) → score →
recalibrate(LLM#2) → act`.

## External APIs (only three, all thin-wrapped)

1. **Mireye** (`src/mireye/`) — `/v1/fetch`, `/v1/proximity` (`op:"distance"`),
   `/v1/lookup` (tier-3 only, 300 credits — used sparingly), `/v1/field-requests`.
   Base `https://api.mireye.com`, bearer auth. Every field in a `/v1/fetch`
   response carries its own `status: ok|absent|failed` — absent data is
   normal, not an error, and drives the field-request action path.
2. **Exa** (`src/sources/exa.ts`) — resolves the retail brand behind a permit
   filed under a contractor/property-LLC name. Resolution layer only; it must
   never become the primary signal source (that would turn "physical
   execution" into "press coverage," undoing the whole positioning).
3. **LLM provider** (`src/llm/client.ts`) — one thin wrapper, swappable. Used
   for exactly two mandatory calls (`extract`, `recalibrate`) plus one
   optional templated call (`draftOutreach`). No other LLM calls, ever.

Permit data itself (`src/sources/permits.ts`) comes from municipal open-data
portals (Socrata, Chicago/Austin) — public, no auth required.

## Fixed output schema

Every processed event produces one `PipelineOutput` (see `src/schemas/index.ts`).
Do not change this shape without updating this file.

```ts
interface PipelineOutput {
  account: string;
  signal: string;
  synthesis: string;
  mireye_facts_summary: string;
  buyer_intent: { label: "high" | "medium" | "low"; confidence: number };
  action_taken: { type: "outreach_draft" | "field_request" | "none"; detail: string };
  sources: string[];
  gate_status: "matched" | "rejected";
  llm_calls_made: number;
  cost_ledger: {
    llm_calls: number;
    mireye_credits: number;
    mireye_endpoints_used: string[];
    exa_cost_dollars: number;
    escalation_stopped_at: "gate" | "unmask" | "screen" | "score" | "completed" | "error";
    llm_input_tokens: number;
    llm_output_tokens: number;
    llm_cost_dollars: number | null; // null when any call this event made replayed pre-usage-tracking
  };
}
```

## Discipline

- Deterministic before LLM, always. The gate (`src/gate/`) and the scorer
  (`src/score/`) are pure functions — zero network, zero LLM calls.
- Tiered escalation: cheap Mireye calls run on every matched event; expensive
  ones (`/v1/lookup`, LLM #2, act) only run on act-capable survivors of the
  previous threshold. Stage-skips and per-event failures must be visible in
  `cost_ledger.escalation_stopped_at`.
- Thresholds and weights live only in `src/score/thresholds.ts`. No inline
  magic numbers anywhere else.
- All external calls go through `src/cassette.ts`. Default mode replays
  recorded fixtures from `/fixtures` (deterministic, no live spend); set
  `RECORD=1` to hit live APIs and record new fixtures.
- Mireye field requests are quota-limited (3/month on GROWTH). Always
  `--dry-run` a field-request payload before firing it for real, and reuse
  the same `idempotency_key` for repeat/demo runs rather than filing twice.

## Non-goals — do not build these

No live web scraping beyond the two documented, public/no-auth-or-key-based
APIs above. No database, no persistence layer beyond `/fixtures` cassettes,
no auth, no multi-user support. No UI framework — CLI output only. No
generalization beyond this one vertical (DTC retail expansion → fulfillment
network buyer). No dependency on any other repo or codebase.

If asked to build any of the above: stop and flag it instead.
