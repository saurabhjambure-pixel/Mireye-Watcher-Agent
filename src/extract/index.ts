// LLM call #1: structured extraction from a messy permit description.
//
// Company identity is NOT re-guessed here — the gate already determined it
// deterministically (see src/gate/index.ts) and Exa already corroborated it.
// This call's actual job is the part that needs judgment: parsing an address
// out of loose permit prose, classifying the event type, and normalizing the
// date. Re-asking the LLM "who is this" would be decorative, since we
// already know the answer with higher confidence than an LLM guess.

import { complete, LLM_CASSETTE_VERSION, type LlmUsage } from "../llm/client.js";
import { withCassette } from "../cassette.js";
import type { ExtractedEvent, RawEvent } from "../schemas/index.js";

const EXTRACT_PROMPT = (sourceText: string) => `You are extracting structured data from a short business \
permit/filing snippet. Return ONLY valid JSON matching this shape:
{ "address": string | null, "needs_geocode": boolean, "event_type": string, "event_date": string | null }

Do not infer or guess an address if it is not clearly stated in the text. If the text gives a street
address but no city/state, set needs_geocode to true rather than guessing the rest.

TEXT:
${sourceText}`;

interface RawExtraction {
  address: string | null;
  needs_geocode: boolean;
  event_type: string;
  event_date: string | null;
}

function parseJsonResponse(raw: string): RawExtraction {
  // Models sometimes wrap JSON in a code fence despite instructions; strip it.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(cleaned) as RawExtraction;
  if (typeof parsed.needs_geocode !== "boolean" || typeof parsed.event_type !== "string") {
    throw new Error(`Extraction response did not match expected shape: ${raw}`);
  }
  return parsed;
}

export async function extractEvent(
  rawEvent: RawEvent,
  gateMatchedCompany: string,
): Promise<{ extracted: ExtractedEvent; usage: LlmUsage | null }> {
  // Captured only when the cassette actually makes a live call — stays null
  // on a cache hit, since a replayed fixture's original usage was never
  // recorded and reporting it would be fabricated, not measured. See
  // Ledger.recordLlmCall in src/ledger.ts.
  let usage: LlmUsage | null = null;

  const raw = await withCassette(
    { provider: "llm", op: "extract", version: LLM_CASSETTE_VERSION, key: { event_id: rawEvent.id } },
    async () => {
      const completion = await complete(EXTRACT_PROMPT(rawEvent.source_text), { maxTokens: 200 });
      usage = completion.usage;
      return parseJsonResponse(completion.text);
    },
  );

  return {
    extracted: {
      event_id: rawEvent.id,
      company_name: gateMatchedCompany,
      address: raw.address,
      needs_geocode: raw.needs_geocode,
      event_type: raw.event_type,
      event_date: raw.event_date ?? rawEvent.issue_date ?? "unknown",
    },
    usage,
  };
}
