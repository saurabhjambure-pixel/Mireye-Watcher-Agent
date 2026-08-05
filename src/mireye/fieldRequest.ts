// /v1/field-requests — 0 credits, but quota-limited (3/month on GROWTH).
// Filed only when scoring hits a genuine evidence gap (a required field
// came back status: absent/failed), never staged per-demo-event.
//
// Quota guard: validate with dryRun first. Fire for real exactly once, then
// reuse the same idempotencyKey for repeat/demo runs — Mireye replays an
// identical-body request as a 200 without consuming a second quota unit.
// Reusing the key with a *different* body is a 409 (idempotency_key_reused).

import { withCassette } from "../cassette.js";
import { mireyeRequest } from "./client.js";
import type { FieldRequestPayload, FieldRequestResponse } from "../schemas/index.js";

export interface FileFieldRequestOptions {
  dryRun?: boolean;
}

export function buildFieldRequestPayload(args: {
  description: string;
  address: string;
  useCase: string;
  idempotencyKey: string;
}): FieldRequestPayload {
  return {
    description: args.description,
    example_locations: [{ address: args.address }],
    use_case: args.useCase,
    idempotency_key: args.idempotencyKey,
  };
}

export async function fileFieldRequest(
  payload: FieldRequestPayload,
  options: FileFieldRequestOptions = {},
): Promise<FieldRequestResponse | { dry_run: true; payload: FieldRequestPayload }> {
  if (options.dryRun) {
    // Validation-only: print/return the payload shape without POSTing,
    // so the request can be reviewed before it burns one of 3 monthly units.
    return { dry_run: true, payload };
  }

  return withCassette(
    { provider: "mireye", op: "field-request", key: { idempotency_key: payload.idempotency_key } },
    () =>
      mireyeRequest<FieldRequestResponse>("/v1/field-requests", {
        body: payload,
      }),
  );
}
