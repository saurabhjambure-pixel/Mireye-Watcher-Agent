import { test } from "node:test";
import assert from "node:assert/strict";
import { processEvent } from "./pipeline.js";

test("external cassette failure is isolated to one structured event result", async () => {
  const output = await processEvent(
    {
      id: "pipeline-error-test",
      source_text: "OLD NAVY expansion signal",
      source_url: "https://audit.invalid/pipeline-error-test",
      lat: null,
      lng: null,
      issue_date: null,
      reported_cost: null,
      contacts: [],
    },
    [{ name: "Old Navy" }],
    [],
    { velocityCount: 1 },
  );

  assert.equal(output.gate_status, "matched");
  assert.equal(output.action_taken.type, "none");
  assert.equal(output.cost_ledger.escalation_stopped_at, "error");
  assert.match(output.action_taken.detail, /Pipeline failed safely/);
});
