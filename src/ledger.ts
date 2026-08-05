// Credit + LLM-call accounting for one event's pipeline run. This is what
// makes the cost-discipline claim ("cheap calls on everything, expensive
// calls only on survivors") visibly true in the output rather than merely
// asserted — see cost_ledger in PipelineOutput.

import type { CostLedger } from "./schemas/index.js";
import { MIREYE_CREDIT_COSTS } from "./score/thresholds.js";

export class Ledger {
  private llmCalls = 0;
  private mireyeCredits = 0;
  private mireyeEndpoints = new Set<string>();
  private exaCostDollars = 0;
  private stoppedAt: CostLedger["escalation_stopped_at"] = "gate";

  recordLlmCall(): void {
    this.llmCalls += 1;
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
    };
  }
}
