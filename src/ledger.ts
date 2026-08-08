// Credit + LLM-call accounting for one event's pipeline run. This is what
// makes the cost-discipline claim ("cheap calls on everything, expensive
// calls only on survivors") visibly true in the output rather than merely
// asserted — see cost_ledger in PipelineOutput.

import type { CostLedger } from "./schemas/index.js";
import { MIREYE_CREDIT_COSTS } from "./score/thresholds.js";
import { estimateCostDollars, type LlmUsage } from "./llm/client.js";

export class Ledger {
  private llmCalls = 0;
  private mireyeCredits = 0;
  private mireyeEndpoints = new Set<string>();
  private exaCostDollars = 0;
  private stoppedAt: CostLedger["escalation_stopped_at"] = "gate";
  private llmInputTokens = 0;
  private llmOutputTokens = 0;
  private llmCostDollars = 0;
  // True once any counted LLM call has no usage data (a replayed fixture
  // recorded before usage tracking existed) — makes the running dollar/token
  // totals for this event honestly "unavailable" rather than a silently
  // incomplete partial sum. See extract/recalibrate/draftOutreach's
  // identical "usage is null on a cache hit" comment.
  private llmUsageIncomplete = false;

  /** `usage` is null on a replayed (cache-hit) call — see the call sites in extract/recalibrate/draftOutreach. */
  recordLlmCall(usage?: LlmUsage | null): void {
    this.llmCalls += 1;
    if (!usage) {
      this.llmUsageIncomplete = true;
      return;
    }
    this.llmInputTokens += usage.inputTokens;
    this.llmOutputTokens += usage.outputTokens;
    const cost = estimateCostDollars(usage);
    if (cost === null) {
      this.llmUsageIncomplete = true;
    } else {
      this.llmCostDollars += cost;
    }
  }

  recordFetch(fieldCount: number): void {
    this.mireyeCredits += fieldCount * MIREYE_CREDIT_COSTS.fetch_field;
    this.mireyeEndpoints.add("/v1/fetch");
  }

  recordProximity(pairCount: number): void {
    this.mireyeCredits += pairCount * MIREYE_CREDIT_COSTS.proximity_driving_calc;
    this.mireyeEndpoints.add("/v1/proximity");
  }

  recordLookup(): void {
    this.mireyeCredits += MIREYE_CREDIT_COSTS.lookup;
    this.mireyeEndpoints.add("/v1/lookup");
  }

  recordFieldRequest(): void {
    // 0 credits, but track that the endpoint was used.
    this.mireyeEndpoints.add("/v1/field-requests");
  }

  recordExaCost(dollars: number): void {
    this.exaCostDollars += dollars;
  }

  setStoppedAt(stage: CostLedger["escalation_stopped_at"]): void {
    this.stoppedAt = stage;
  }

  toJSON(): CostLedger {
    return {
      llm_calls: this.llmCalls,
      mireye_credits: this.mireyeCredits,
      mireye_endpoints_used: Array.from(this.mireyeEndpoints),
      exa_cost_dollars: this.exaCostDollars,
      escalation_stopped_at: this.stoppedAt,
      llm_input_tokens: this.llmInputTokens,
      llm_output_tokens: this.llmOutputTokens,
      // null (not 0, not a partial sum) whenever any call this event made
      // was replayed from a pre-usage-tracking fixture or an unpriced
      // model — see the class-level comment on llmUsageIncomplete.
      llm_cost_dollars: this.llmUsageIncomplete ? null : this.llmCostDollars,
    };
  }
}
