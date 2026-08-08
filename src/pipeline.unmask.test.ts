import { test } from "node:test";
import assert from "node:assert/strict";
import { processEvent } from "./pipeline.js";
import type { RawEvent, WatchlistCompany } from "./schemas/index.js";
import { UNMASK_MIN_REPORTED_COST } from "./score/thresholds.js";

const watchlist: WatchlistCompany[] = [{ name: "Old Navy" }];

function llcEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "unmask-test-1",
    source_text:
      "Permit 9999001 at 2100 N HALSTED ST, Chicago, IL. SELF CERT 2019 CBRC: INTERIOR BUILD-OUT OF SHELL RETAIL SPACE. Reported cost: $410000.",
    source_url: "https://example.com/permit/9999001",
    lat: null,
    lng: null,
    issue_date: "2026-05-01",
    reported_cost: 410_000,
    contacts: ["2100 HALSTED PROPERTY HOLDINGS LLC"],
    ...overrides,
  };
}

test("a cheap gate-miss never attempts unmask — no Exa cassette lookup happens at all", async () => {
  // reported_cost is far below UNMASK_MIN_REPORTED_COST, and no fixture
  // exists for this event's query — if the pipeline attempted unmask
  // anyway, this would throw CassetteMissError instead of returning a plain
  // free rejection. This is the cost-discipline claim for the new tier: a
  // "rejected" event is free unless it looked commercially plausible.
  const output = await processEvent(
    llcEvent({
      id: "unmask-test-cheap",
      source_text: "Permit 9999003 at 1 W CHEAP ST, Chicago, IL. TEMP BANNER SIGN. Reported cost: $800.",
      reported_cost: 800,
    }),
    watchlist,
    [],
    { velocityCount: 0 },
  );

  assert.equal(output.gate_status, "rejected");
  assert.equal(output.cost_ledger.exa_cost_dollars, 0);
  assert.equal(output.cost_ledger.escalation_stopped_at, "gate");
});

test("a commercially plausible gate-miss attempts unmask; cost is visible even when it still fails", async () => {
  const output = await processEvent(
    llcEvent({
      id: "unmask-test-fail",
      source_text:
        "Permit 9999002 at 400 W ERIE ST, Chicago, IL. SELF CERT 2019 CBRC: INTERIOR BUILD-OUT OF SHELL RETAIL SPACE. Reported cost: $410000.",
    }),
    watchlist,
    [],
    { velocityCount: 0 },
  );

  assert.ok(410_000 >= UNMASK_MIN_REPORTED_COST, "fixture assumption: this event must clear the unmask threshold");
  assert.equal(output.gate_status, "rejected");
  assert.equal(output.account, "unknown");
  assert.ok(output.cost_ledger.exa_cost_dollars > 0, "the unmask attempt must cost something even though it failed");
  assert.equal(output.cost_ledger.escalation_stopped_at, "unmask");
  assert.match(output.action_taken.detail, /Exa could not identify/);
});

test("unmask success promotes a gate-miss to matched, with the real resolved brand as account", async () => {
  const output = await processEvent(llcEvent(), watchlist, [], { velocityCount: 0 });

  assert.equal(output.gate_status, "matched");
  assert.equal(output.account, "Old Navy");
  assert.ok(output.cost_ledger.exa_cost_dollars > 0);
  // Stops right after promotion (this fixture's extraction reports no
  // usable address), which also proves Stage 2's corroboration call was
  // NOT paid for a second time — only one Exa spend total for this event.
  assert.equal(output.cost_ledger.escalation_stopped_at, "screen");
});
