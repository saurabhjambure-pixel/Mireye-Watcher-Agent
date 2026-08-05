// All shared types for Expansion Radar.
//
// The Mireye-shaped types here (MireyeField, MireyeFetchResponse,
// MireyeProximityResponse, FieldRequestResponse) are transcribed from the
// verified live contract at docs.mireye.ai — NOT guessed from marketing copy.
// If a live response ever disagrees with these shapes, surface the mismatch
// (see src/mireye/client.ts) rather than silently coercing it.

// ---------------------------------------------------------------------------
// Watchlist / demo data
// ---------------------------------------------------------------------------

export interface WatchlistCompany {
  name: string;
  aliases?: string[]; // for fuzzy matching, e.g. permit contact names / DBAs
}

export interface ReferenceNode {
  label: string; // e.g. "Node - Chicago"
  address: string;
}

export interface DemoData {
  watchlist: WatchlistCompany[];
  reference_nodes: ReferenceNode[];
}

// ---------------------------------------------------------------------------
// Raw signal (permit record, normalized)
// ---------------------------------------------------------------------------

export interface RawEvent {
  id: string;
  source_text: string; // semi-structured permit description, not clean JSON
  source_url: string; // permit lookup URL or dataset reference, for citation
  lat: number | null;
  lng: number | null;
  issue_date: string | null; // ISO date, as reported by the permit source
  reported_cost: number | null;
  contacts: string[]; // raw contact/contractor/owner names from the permit record
}

// ---------------------------------------------------------------------------
// Gate (deterministic, zero network/LLM)
// ---------------------------------------------------------------------------

export interface GateResult {
  matched: boolean;
  company?: string;
  matched_on?: string; // the literal string that matched (name, alias, or contact)
}

// ---------------------------------------------------------------------------
// Exa brand resolution (resolution layer only — see CLAUDE.md)
// ---------------------------------------------------------------------------

export interface ExaResolution {
  resolved_brand: string | null;
  confidence: "high" | "medium" | "low";
  corroborating_urls: string[];
  cost_dollars: number;
}

// ---------------------------------------------------------------------------
// Extract (LLM call #1)
// ---------------------------------------------------------------------------

export interface ExtractedEvent {
  event_id: string;
  company_name: string;
  address: string | null;
  needs_geocode: boolean;
  event_type: string; // e.g. "new_store_opening"
  event_date: string; // ISO date, best-effort from source text
}

// ---------------------------------------------------------------------------
// Mireye — /v1/fetch
// ---------------------------------------------------------------------------

export interface MireyeField {
  value: unknown;
  unit: string | null;
  source: string;
  source_url: string;
  confidence: "high" | "medium" | "low" | "unknown";
  fetched_at: string; // ISO 8601
  dataset_vintage: string | null;
  ttl_seconds: number;
  notes: string | null;
  status: "ok" | "absent" | "failed"; // absent/failed is normal, not an error
  retryable?: boolean; // present on field-level failures when Mireye can retry the source
}

export interface MireyePartialFailure {
  field: string;
  source: string;
  error: string;
  retryable: boolean;
}

export interface MireyeFetchResponse {
  lat: number;
  lng: number;
  fetched_at: string;
  fields: Record<string, MireyeField>;
  partial_failures: MireyePartialFailure[];
  resolved_location: { lat: number; lng: number; source: "coordinate" | "address" };
  geocode?: unknown; // present only for address-based requests
}

// ---------------------------------------------------------------------------
// Mireye — /v1/proximity (op: "distance")
// ---------------------------------------------------------------------------

export interface MireyeProximityLeg {
  origin_index: number;
  destination_index: number;
  distance_miles: number;
  distance_km: number;
  // Null when the destination is genuinely unreachable by the requested
  // mode (flag: "unreachable_or_snapped") — a real, documented outcome,
  // not a missing-data bug. Verified against a live response where Mireye
  // returned this for one of three reference nodes.
  duration_seconds: number | null;
  duration_minutes: number | null;
  flag: string | null;
}

export interface MireyeProximityResponse {
  op: "distance";
  legs: MireyeProximityLeg[];
  resolved_origins: unknown[];
  resolved_destinations: unknown[];
  paid_driving_calcs: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Mireye — /v1/lookup (tier 3 only, 300 credits)
// ---------------------------------------------------------------------------

/**
 * Verified against a live response — this bears little resemblance to the
 * placeholder shape originally guessed from marketing copy (input/parcel/
 * context). The real response is county-anchored, not just parcel-anchored:
 * `county_market` carries regional growth signals, and `parcel` is genuinely
 * absent on some real responses (an interpolated/low-confidence address
 * match may resolve to a location without an exact parcel intersect) —
 * that absence is meaningful, not a bug, so it's optional here.
 */
export interface MireyeCountyMarket {
  population: number;
  population_growth_1yr_pct: number;
  net_domestic_migration: number;
  building_permits_total_annual: number;
  building_permits_sf_annual: number;
  building_permits_yoy_pct: number;
  hpi_yoy_pct: number;
  employment_total: number;
  employment_yoy_pct: number;
  median_household_income_usd: number;
}

export interface MireyeLookupParcel {
  parcel_id: string;
  apn: string;
  address: string;
  area_m2: number;
  geometry: string;
  geometry_wkt: string;
  owner: string;
  zoning: string;
  land_use: string;
  assessed_value_usd: number;
  last_sale_date: string | null;
  last_sale_price_usd: number | null;
  match_type: string;
  match_distance_m: number;
  match_radius_m: number;
  source: string;
}

export interface MireyeLookupResponse {
  disposition: string;
  lat: number;
  lng: number;
  resolved_address: string;
  resolved_location: { lat: number; lng: number; source: "coordinate" | "address" };
  county_fips: string;
  county: string;
  tract_geoid: string;
  state_fips: string;
  state: string;
  block_group_geoid: string;
  block_geoid: string;
  congressional_district: string;
  cbsa_name: string;
  cbsa_code: string;
  elevation_m: number;
  fema_flood_zone: string;
  within_floodplain: boolean;
  coastal_high_hazard: boolean;
  county_market: MireyeCountyMarket;
  in_opportunity_zone: boolean;
  timezone: string;
  // Genuinely absent on some real responses — see doc comment above.
  parcel?: MireyeLookupParcel;
  parcel_unavailable: boolean;
  match_method: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Mireye — /v1/field-requests
// ---------------------------------------------------------------------------

export interface FieldRequestLocation {
  address?: string;
  lat?: number;
  lng?: number;
  polygon?: unknown;
}

export interface FieldRequestPayload {
  description: string;
  example_locations: FieldRequestLocation[];
  use_case?: string;
  decision_threshold?: string;
  idempotency_key?: string;
}

export interface FieldRequestResponse {
  request_id: string; // "fr_..."
  status: "matched" | "queued" | "awaiting_confirm" | "rejected" | "clarify" | "received";
  disposition: unknown[];
  resolved_locations: unknown[];
  queue_position: number | null;
  estimated_ready_at: string | null;
  context_blob: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Mireye — typed error envelope
// ---------------------------------------------------------------------------

export interface MireyeErrorDetail {
  error: string;
  message: string;
  [key: string]: unknown;
}

export class MireyeApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly detail: MireyeErrorDetail,
    public readonly requestId: string | null,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(`Mireye API error ${httpStatus} (${detail.error}): ${detail.message}`);
    this.name = "MireyeApiError";
  }
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  velocity_component: number;
  proximity_component: number;
  size_component: number;
  buyer_intent_score: number; // 0-1, weighted sum of the three above, plus any market refinement
  evidence_gap: boolean; // true when size data (or, post-lookup, market data) was absent/failed at Mireye
  evidence_gap_field?: string; // which field(s) were missing, if evidence_gap
  // Present only after refineWithMarketData runs (tier 3, post-/v1/lookup).
  // 0/false beforehand — this data doesn't exist until the 300-credit
  // lookup call returns, so it can only refine an already-notable score,
  // never gate the initial NOTABLE_THRESHOLD screening decision.
  market_component: number;
  market_evidence_gap: boolean;
}

// ---------------------------------------------------------------------------
// Act
// ---------------------------------------------------------------------------

export type ActionType = "outreach_draft" | "field_request" | "none";

export interface ActionResult {
  type: ActionType;
  detail: string; // drafted message, or field-request id/payload summary
}

// ---------------------------------------------------------------------------
// Cost ledger — proves the cost-discipline claim
// ---------------------------------------------------------------------------

export interface CostLedger {
  llm_calls: number;
  mireye_credits: number;
  mireye_endpoints_used: string[];
  exa_cost_dollars: number;
  escalation_stopped_at: "gate" | "screen" | "score" | "completed";
}

// ---------------------------------------------------------------------------
// Fixed pipeline output
// ---------------------------------------------------------------------------

export interface PipelineOutput {
  account: string;
  signal: string;
  synthesis: string;
  mireye_facts_summary: string;
  buyer_intent: {
    label: "high" | "medium" | "low";
    confidence: number;
  };
  action_taken: ActionResult;
  sources: string[];
  gate_status: "matched" | "rejected";
  llm_calls_made: number;
  cost_ledger: CostLedger;
}
