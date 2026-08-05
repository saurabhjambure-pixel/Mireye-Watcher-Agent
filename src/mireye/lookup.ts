// /v1/lookup — tier 3, 300 credits. ~50x the cost of the tier-1 /v1/fetch
// fields, so it is only called for events that already survived the score
// threshold (see src/score/thresholds.ts NOTABLE_THRESHOLD). Bundles parcel
// detail + enrichment (elevation, flood risk, opportunity-zone status) in
// one call for the recalibration step's richer synthesis.

import { withCassette } from "../cassette.js";
import { mireyeRequest, withRetry } from "./client.js";
import type { MireyeLookupResponse } from "../schemas/index.js";

export async function lookup(input: string): Promise<MireyeLookupResponse> {
  return withCassette({ provider: "mireye", op: "lookup", key: { input } }, () =>
    withRetry(() =>
      mireyeRequest<MireyeLookupResponse>("/v1/lookup", {
        body: { input, include_parcel: true, kind: null },
      }),
    ),
  );
}
