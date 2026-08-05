import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWatchlist } from "./index.js";
import type { RawEvent, WatchlistCompany } from "../schemas/index.js";

const watchlist: WatchlistCompany[] = [
  { name: "Old Navy" },
  { name: "Trader Joe's", aliases: ["Trader Joes"] },
  { name: "Five Below" },
  { name: "lululemon", aliases: ["Lululemon Athletica"] },
];

function event(source_text: string, contacts: string[] = []): RawEvent {
  return {
    id: "test-1",
    source_text,
    source_url: "https://example.com",
    lat: null,
    lng: null,
    issue_date: null,
    reported_cost: null,
    contacts,
  };
}

test("exact match on brand name in description", () => {
  const result = matchWatchlist(
    event("INTERIOR RENOVATION TO BUILD OUT AN OLD NAVY RETAIL CLOTHING STORE"),
    watchlist,
  );
  assert.equal(result.matched, true);
  assert.equal(result.company, "Old Navy");
});

test("fuzzy match: TRADER JOES (no apostrophe) matches Trader Joe's", () => {
  const result = matchWatchlist(
    event("SELF CERT: INT BUILDING OUT OF SHELL SPACE ON GROUND FLOOR - TRADER JOES"),
    watchlist,
  );
  assert.equal(result.matched, true);
  assert.equal(result.company, "Trader Joe's");
});

test("match via contact/owner name, not just description", () => {
  const result = matchWatchlist(
    event("LOW VOLTAGE ELECTRICAL WORK, 1ST FLOOR STOREFRONT SECURITY INSTALL", [
      "NORRIS MICHAEL",
      "TRADER JOES",
    ]),
    watchlist,
  );
  assert.equal(result.matched, true);
  assert.equal(result.company, "Trader Joe's");
});

test("unrelated residential permit is rejected — zero match", () => {
  const result = matchWatchlist(
    event("REMOVE AND REPLACE REAR WOOD PORCH FOR EXISTING SINGLE FAMILY RESIDENCE", [
      "ZAHABIYA BENSAHEB",
      "JPS CONSTRUCTION LLC",
    ]),
    watchlist,
  );
  assert.equal(result.matched, false);
  assert.equal(result.company, undefined);
});

test("does not over-match: unrelated short words don't trigger fuzzy fallback", () => {
  const result = matchWatchlist(event("NEW ELECTRICAL SERVICE FOR PARKING GARAGE LIGHTING"), watchlist);
  assert.equal(result.matched, false);
});
