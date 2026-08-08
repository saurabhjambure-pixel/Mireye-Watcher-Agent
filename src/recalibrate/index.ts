// LLM call #2: one-line synthesis, only for events whose deterministic
// score already crossed NOTABLE_THRESHOLD. Never reached below it — the
// pipeline enforces that by construction (see src/pipeline.ts), not by
// convention here.

import { complete, LLM_CASSETTE_VERSION, type LlmUsage } from "../llm/client.js";
import { withCassette } from "../cassette.js";
import type { ExtractedEvent, ScoreBreakdown } from "../schemas/index.js";

const RECALIBRATE_PROMPT = (event: ExtractedEvent, factsSummary: string, breakdown: ScoreBreakdown) => `Given \
this expansion event and these cited facts, write ONE sentence explaining why this account matters right now.
Reference at least one specific fact (size, distance, velocity, or county market momentum). Do not invent facts \
not provided.

EVENT: ${event.company_name} — ${event.event_type} on ${event.event_date}
FACTS: ${factsSummary}
SCORE_BREAKDOWN: velocity=${breakdown.velocity_component.toFixed(2)} proximity=${breakdown.proximity_component.toFixed(2)} size=${breakdown.size_component.toFixed(2)} market=${breakdown.market_component.toFixed(2)} overall=${breakdown.buyer_intent_score.toFixed(2)}`;

export async function recalibrate(
  event: ExtractedEvent,
  factsSummary: string,
  breakdown: ScoreBreakdown,
): Promise<{ text: string; usage: LlmUsage | null }> {
  // See extract/index.ts's identical comment: usage is only populated on an
  // actual live call, never fabricated for a replayed fixture.
  let usage: LlmUsage | null = null;
  const text = await withCassette(
    { provider: "llm", op: "recalibrate", version: LLM_CASSETTE_VERSION, key: { event_id: event.event_id } },
    async () => {
      const completion = await complete(RECALIBRATE_PROMPT(event, factsSummary, breakdown), { maxTokens: 120 });
      usage = completion.usage;
      return completion.text;
    },
  );
  return { text, usage };
}
