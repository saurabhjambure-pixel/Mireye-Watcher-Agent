import { test } from "node:test";
import assert from "node:assert/strict";
import { CassetteMissError, withCassette } from "./cassette.js";

test("versioned LLM cassettes keep v1 fixtures but reject future versions", async () => {
  const legacy = await withCassette(
    { provider: "llm", op: "extract", version: "v1", key: { event_id: "chi-3445485" } },
    async () => "live fallback should not run",
  );
  assert.equal(typeof legacy, "object");

  await assert.rejects(
    withCassette(
      { provider: "llm", op: "extract", version: "v2", key: { event_id: "chi-3445485" } },
      async () => "live fallback should not run",
    ),
    CassetteMissError,
  );
});
