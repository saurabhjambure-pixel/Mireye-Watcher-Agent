// CLI entrypoint. Loads demo-data/watchlist.json, resolves each entry's
// permit_id to a real (live-fetched, cassette-replayed) Chicago building
// permit, runs it through the full pipeline, and prints one PipelineOutput
// per event plus a final summary line proving the cost-discipline claim.
//
// Usage:
//   npm run pipeline                              # replay mode (default) — no network calls
//                                                  # to Mireye/Exa/LLM, deterministic
//   RECORD=1 npm run pipeline                     # live mode — requires real API keys in .env.
//                                                  # Field requests default to --dry-run (validated,
//                                                  # not filed) so a live pass never spends one of
//                                                  # the 3 monthly units by accident.
//   RECORD=1 npm run pipeline -- --live-field-request   # also fire the real /v1/field-requests call
//   npm run pipeline -- --quiet                   # suppress raw Mireye JSON dump

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchPermitById } from "./sources/permits.js";
import { processEvent } from "./pipeline.js";
import type { PipelineOutput, ReferenceNode, WatchlistCompany } from "./schemas/index.js";

interface DemoEventEntry {
  permit_id: string;
  note: string;
  historical_velocity: number;
}

interface DemoDataFile {
  watchlist: WatchlistCompany[];
  reference_nodes: ReferenceNode[];
  events: DemoEventEntry[];
}

const quiet = process.argv.includes("--quiet");
const liveFieldRequest = process.argv.includes("--live-field-request");

function printOutput(output: PipelineOutput): void {
  console.log("─".repeat(72));
  console.log(`account:              ${output.account}`);
  console.log(`gate_status:          ${output.gate_status}`);
  console.log(`signal:               ${output.signal}`);
  if (output.synthesis) {
    console.log(`synthesis:            ${output.synthesis}`);
  }
  if (output.mireye_facts_summary) {
    console.log(`mireye_facts_summary: ${output.mireye_facts_summary}`);
  }
  console.log(
    `buyer_intent:         ${output.buyer_intent.label} (confidence ${output.buyer_intent.confidence.toFixed(3)})`,
  );
  console.log(`action_taken:         ${output.action_taken.type}`);
  if (output.action_taken.detail) {
    console.log(`  detail:             ${output.action_taken.detail}`);
  }
  console.log(`sources:              ${output.sources.join(", ") || "(none)"}`);
  console.log(`llm_calls_made:       ${output.llm_calls_made}`);
  console.log(
    `cost_ledger:          ${output.cost_ledger.mireye_credits} mireye credits ` +
      `[${output.cost_ledger.mireye_endpoints_used.join(", ") || "none"}], ` +
      `$${output.cost_ledger.exa_cost_dollars.toFixed(4)} exa, ` +
      `stopped_at=${output.cost_ledger.escalation_stopped_at}`,
  );
}

async function main() {
  const demoDataPath = path.resolve(process.cwd(), "demo-data", "watchlist.json");
  const demoData = JSON.parse(await readFile(demoDataPath, "utf-8")) as DemoDataFile;

  const outputs: PipelineOutput[] = [];
  let totalMireyeCredits = 0;
  let totalExaCost = 0;

  for (const entry of demoData.events) {
    const rawEvent = await fetchPermitById(entry.permit_id);
    if (!rawEvent) {
      console.error(`No permit found for id=${entry.permit_id}, skipping.`);
      continue;
    }

    const output = await processEvent(rawEvent, demoData.watchlist, demoData.reference_nodes, {
      velocityCount: entry.historical_velocity + 1,
      fieldRequestDryRun: !liveFieldRequest,
      onRawMireyeResponse: quiet
        ? undefined
        : (label, raw) => {
            console.log(`\n[raw Mireye response — ${label}]`);
            console.log(JSON.stringify(raw, null, 2));
          },
    });

    outputs.push(output);
    totalMireyeCredits += output.cost_ledger.mireye_credits;
    totalExaCost += output.cost_ledger.exa_cost_dollars;
    printOutput(output);
  }

  const matched = outputs.filter((o) => o.gate_status === "matched").length;
  const rejected = outputs.filter((o) => o.gate_status === "rejected").length;
  const totalLlmCalls = outputs.reduce((sum, o) => sum + o.llm_calls_made, 0);

  console.log("=".repeat(72));
  console.log(
    `SUMMARY: ${outputs.length} events — ${matched} matched, ${rejected} rejected ` +
      `(0 LLM calls on rejected) — ${totalLlmCalls} total LLM calls, ` +
      `${totalMireyeCredits} total Mireye credits, $${totalExaCost.toFixed(4)} total Exa cost.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
