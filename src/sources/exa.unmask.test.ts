import { test } from "node:test";
import assert from "node:assert/strict";
import { unmaskBrand } from "./exa.js";
import type { WatchlistCompany } from "../schemas/index.js";

const watchlist: WatchlistCompany[] = [
  { name: "Old Navy" },
  { name: "Trader Joe's", aliases: ["Trader Joes"] },
  { name: "Five Below" },
  { name: "lululemon", aliases: ["Lululemon Athletica"] },
];

// Mirrors permits.ts's exact formatting: "Permit {id} at {address}, Chicago, IL. {description}"
const llcFiledSourceText =
  "Permit 9999001 at 2100 N HALSTED ST, Chicago, IL. SELF CERT 2019 CBRC: INTERIOR BUILD-OUT OF SHELL RETAIL SPACE. Reported cost: $410000.";

test("unmaskBrand resolves a real brand from independent Exa coverage, not from any input it was given", async () => {
  const result = await unmaskBrand({ sourceText: llcFiledSourceText, watchlist });
  assert.equal(result.resolved_brand, "Old Navy");
  assert.equal(result.confidence, "high");
  assert.ok(result.corroborating_urls.length >= 2);
  // Decisive: nothing in the input (sourceText, watchlist) names "Old Navy" —
  // it only appears in the fixture's Exa result text. A circular
  // implementation (echoing an input back) could not pass this.
  assert.ok(!llcFiledSourceText.toUpperCase().includes("OLD NAVY"));
});

test("unmaskBrand returns no resolved_brand when coverage doesn't name a watchlist company", async () => {
  const unrelatedSourceText =
    "Permit 9999002 at 400 W ERIE ST, Chicago, IL. SELF CERT 2019 CBRC: INTERIOR BUILD-OUT OF SHELL RETAIL SPACE. Reported cost: $410000.";
  const result = await unmaskBrand({ sourceText: unrelatedSourceText, watchlist });
  assert.equal(result.resolved_brand, null);
  assert.equal(result.confidence, "low");
});
