// Act path (a): draft a ready-to-send outreach message, citing specific
// Mireye facts by their source_url and fetched_at so the citation is
// checkable, not just asserted.

import { complete } from "../llm/client.js";
import { withCassette } from "../cassette.js";
import type { ExtractedEvent } from "../schemas/index.js";

const OUTREACH_PROMPT = (companyName: string, signal: string, factsSummary: string) => `Write a short (3-4 \
sentence) outreach message from a fulfillment network's partnerships lead to ${companyName}, referencing \
their recent expansion (${signal}) and specifically citing ${factsSummary}. Tone: direct, not salesy. No \
greeting/signature boilerplate needed.

Note: any "Node - X" text is an internal facility label, not something a recipient would recognize —
refer to it naturally instead, e.g. "our X-area facility" or just "X" (the place name after "Node - ").
Don't quote the "Node - " prefix verbatim.`;

export async function draftOutreach(
  event: ExtractedEvent,
  signal: string,
  factsSummary: string,
): Promise<string> {
  return withCassette(
    { provider: "llm", op: "draft-outreach", key: { event_id: event.event_id } },
    () => complete(OUTREACH_PROMPT(event.company_name, signal, factsSummary), { maxTokens: 200 }),
  );
}
