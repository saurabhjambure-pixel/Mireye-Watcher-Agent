// Act path (b): file a Mireye field request to close a genuine evidence
// gap. Triggered only when scoring actually hit evidence_gap (a required
// field came back status: absent/failed) — never staged per demo event.
//
// idempotency_key is derived deterministically from the event id and the
// missing field, so re-running the same event (replay, or a second demo
// take) reuses the same key: Mireye replays an identical-body request as a
// 200 without spending a second one of the 3 monthly field-request units.

import { buildFieldRequestPayload, fileFieldRequest } from "../mireye/fieldRequest.js";
import type { ActionResult, ExtractedEvent } from "../schemas/index.js";

/** Collapse a gap-field label (which may contain "/", "(", spaces, etc.) into a clean idempotency-key segment. */
function sanitizeForKey(gapField: string): string {
  return gapField
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function fieldRequestIdempotencyKey(eventId: string, gapField: string): string {
  return `expansion-radar-${eventId}-${sanitizeForKey(gapField)}`;
}

export async function requestFieldForGap(
  event: ExtractedEvent,
  gapField: string,
  address: string,
  options: { dryRun?: boolean } = {},
): Promise<ActionResult> {
  const idempotencyKey = fieldRequestIdempotencyKey(event.event_id, gapField);

  const payload = buildFieldRequestPayload({
    description:
      `Missing evidence for a buyer-intent scoring decision on ${event.company_name}'s ${event.event_type} ` +
      `on ${event.event_date}: ${gapField} could not be resolved for this parcel. We need this (or an ` +
      `equivalent signal) to finalize confidence before acting on this account.`,
    address,
    useCase: "expansion_radar_buyer_intent_scoring",
    idempotencyKey,
  });

  const result = await fileFieldRequest(payload, options);

  if ("dry_run" in result) {
    return {
      type: "field_request",
      detail: `[DRY RUN — not filed] payload validated: ${JSON.stringify(result.payload)}`,
    };
  }

  return {
    type: "field_request",
    detail: `request_id=${result.request_id} status=${result.status}`,
  };
}
