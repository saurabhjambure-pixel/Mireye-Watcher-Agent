// /v1/fetch — tier 1, ~1 credit/field. Site facts: building footprint,
// Overture building class, parcel zoning/area. Every field carries its own
// status (ok/absent/failed) — absent is normal and is the real trigger for
// a field-request evidence gap, not an error to swallow.
//
// A field can also come back `status: "failed", retryable: true` inside an
// otherwise-200 response (e.g. an upstream timeout on one source) — this is
// NOT the same as `withRetry` in client.ts, which only catches HTTP-level
// errors. Verified live: primary_building_footprint_sqm timed out this way
// for a real address, and the pipeline's parcel-area fallback silently
// substituted a value 31x too large into customer-facing outreach copy as
// if it were the building footprint. Retry the whole call when any field
// is retryable, since Mireye only offers whole-request retry, not per-field.

import { withCassette } from "../cassette.js";
import { mireyeRequest, withRetry } from "./client.js";
import type { MireyeFetchResponse } from "../schemas/index.js";

/** Fields pulled at tier 1 — kept minimal since /v1/fetch is billed per field. */
export const SITE_FACT_FIELDS = [
  "primary_building_footprint_sqm",
  "primary_building_overture_class",
  "parcel_zoning",
  "parcel_area_m2",
  "political_locality",
] as const;

export interface FetchFactsLocation {
  address?: string;
  lat?: number;
  lng?: number;
}

/** Additional attempts beyond the first when a field comes back retryable. */
const MAX_FIELD_RETRY_ATTEMPTS = 2;
const FIELD_RETRY_DELAY_MS = 1500;

function hasRetryableFieldFailure(response: MireyeFetchResponse): boolean {
  return Object.values(response.fields).some((f) => f.status === "failed" && f.retryable !== false);
}

export async function fetchFacts(
  location: FetchFactsLocation,
  fields: readonly string[] = SITE_FACT_FIELDS,
): Promise<MireyeFetchResponse> {
  return withCassette({ provider: "mireye", op: "fetch", key: { location, fields } }, async () => {
    let response = await withRetry(() =>
      mireyeRequest<MireyeFetchResponse>("/v1/fetch", { body: { ...location, fields } }),
    );

    for (let attempt = 1; attempt <= MAX_FIELD_RETRY_ATTEMPTS && hasRetryableFieldFailure(response); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, FIELD_RETRY_DELAY_MS));
      response = await withRetry(() =>
        mireyeRequest<MireyeFetchResponse>("/v1/fetch", { body: { ...location, fields } }),
      );
    }

    return response;
  });
}
