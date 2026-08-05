// /v1/proximity — tier 2, 12 credits/driving calculation. Uses op:"distance"
// deliberately: op:"nearest" only accepts six curated POI sets, not custom
// fulfillment-node addresses, so it cannot answer "how far from OUR nodes."

import { withCassette } from "../cassette.js";
import { mireyeRequest, withRetry } from "./client.js";
import type { MireyeProximityResponse } from "../schemas/index.js";

/**
 * Compute drive time/distance from one origin (the event's resolved
 * location) to every reference node, and return the nearest.
 */
export async function proximityToNodes(
  origin: string, // "lat,lng" or a US street address
  destinations: string[], // one per ReferenceNode.address
): Promise<{ raw: MireyeProximityResponse; nearestIndex: number | null; nearestMinutes: number | null }> {
  const raw = await withCassette(
    { provider: "mireye", op: "proximity", key: { origin, destinations } },
    () =>
      withRetry(() =>
        mireyeRequest<MireyeProximityResponse>("/v1/proximity", {
          body: {
            op: "distance",
            origins: [origin],
            destinations,
            mode: "driving",
          },
        }),
      ),
  );

  if (raw.legs.length === 0) {
    throw new Error("Mireye /v1/proximity returned zero legs for a distance query.");
  }

  // A leg with duration_minutes: null means that destination is genuinely
  // unreachable by the requested mode (flag: "unreachable_or_snapped") —
  // exclude it from the "nearest" comparison rather than let it win by
  // default (an unreachable node isn't the closest one, it's not a
  // candidate at all).
  let nearest: (typeof raw.legs)[number] | null = null;
  for (const leg of raw.legs) {
    if (leg.duration_minutes === null) continue;
    if (nearest === null || leg.duration_minutes < nearest.duration_minutes!) nearest = leg;
  }

  if (nearest === null) {
    return { raw, nearestIndex: null, nearestMinutes: null };
  }
  return { raw, nearestIndex: nearest.destination_index, nearestMinutes: nearest.duration_minutes };
}
