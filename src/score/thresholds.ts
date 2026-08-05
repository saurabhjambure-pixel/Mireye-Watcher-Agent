// Every scoring constant lives here, and only here. Referenced directly (by
// name, not value) in the one-pager and demo narration — do not add inline
// magic numbers to score/index.ts or anywhere else.

/** Weighted contribution of each scoring input. Must sum to 1. */
export const WEIGHTS = {
  velocity: 0.4,
  proximity: 0.35,
  size: 0.25,
} as const;

/** Score at/above this triggers LLM #2 (recalibrate) — one-line synthesis. */
export const NOTABLE_THRESHOLD = 0.5;

/** Score at/above this triggers the act stage (outreach draft or field request). */
export const ACT_THRESHOLD = 0.7;

// scoreLabel's "medium"/"low" boundary deliberately reuses NOTABLE_THRESHOLD
// rather than a fourth independent constant: a "medium" label should always
// mean "this event got recalibrated," so the label can never contradict the
// action_taken.detail text (e.g. "medium" confidence next to "below
// NOTABLE_THRESHOLD — no recalibration").

// --- Velocity: watchlist-brand permits for this company within the window ---
export const VELOCITY_WINDOW_DAYS = 180;
/** Permit count at/above this within the window scores a full 1.0 on velocity. */
export const VELOCITY_MAX_EVENTS_FOR_FULL_SCORE = 4;

// --- Proximity: drive time (minutes) to the nearest reference node ---
/** At/below this drive time, proximity scores a full 1.0 (easily serviceable). */
export const PROXIMITY_MIN_MINUTES = 5;
/** At/above this drive time, proximity scores 0 (not economically serviceable). */
export const PROXIMITY_MAX_MINUTES = 60;

// --- Size: building footprint, from Mireye's primary_building_footprint_sqm ---
export const SQM_TO_SQFT = 10.7639;
/** At/below this footprint (sq ft), size scores 0 (kiosk-scale). */
export const SIZE_MIN_SQFT = 800;
/** At/above this footprint (sq ft), size scores a full 1.0 (flagship-scale). */
export const SIZE_MAX_SQFT = 5000;

// --- Market momentum: county-level growth signal from /v1/lookup (tier 3) ---
// This data only exists after the 300-credit lookup call, so it can only
// ever REFINE an already-notable candidate's score (a bounded nudge, not a
// reweighted component) — it never gates the cheap NOTABLE_THRESHOLD
// screening decision, which stays velocity/proximity/size only.
/** Max additive adjustment (+/-) applied once real county_market data is in hand. */
export const MARKET_BONUS_WEIGHT = 0.1;
/** building_permits_yoy_pct (permit-activity trend) range mapped to 0-1. */
export const MARKET_PERMITS_YOY_MIN_PCT = -20;
export const MARKET_PERMITS_YOY_MAX_PCT = 20;
/** hpi_yoy_pct (home-price appreciation) range mapped to 0-1. */
export const MARKET_HPI_YOY_MIN_PCT = 0;
export const MARKET_HPI_YOY_MAX_PCT = 10;
/** population_growth_1yr_pct range mapped to 0-1. */
export const MARKET_POP_GROWTH_MIN_PCT = -1;
export const MARKET_POP_GROWTH_MAX_PCT = 2;

// --- Mireye credit costs, per docs.mireye.ai (GROWTH plan) — used by the ledger ---
export const MIREYE_CREDIT_COSTS = {
  geocode: 1, // per address
  fetch_field: 1, // per field per location
  ask: 10, // per query
  proximity_driving_calc: 12, // per origin-destination pair
  lookup: 300, // per call
} as const;
