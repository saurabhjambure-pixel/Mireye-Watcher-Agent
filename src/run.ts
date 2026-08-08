// CLI entrypoint. Two modes:
//
//   Fixed demo (default) — loads demo-data/watchlist.json, resolves each
//   entry's permit_id to a real (live-fetched, cassette-replayed) Chicago
//   building permit. Deterministic and replayable — this is the 5-event
//   proof set in the README.
//
//   --discover — the agent finds its own matches instead of being handed
//   permit_ids: queries recent Chicago permits live via fetchPermits() (the
//   same public, no-auth search that fixed-demo mode leaves unused — see
//   src/sources/permits.ts) and lets the gate/unmask stages decide what's
//   relevant. This is what makes it "an agent that reasons and decides,"
//   not a script replaying a hand-picked list. Requires RECORD=1, since the
//   query is date-relative and won't match any recorded fixture.
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
//   RECORD=1 npm run pipeline -- --discover                          # live discovery, last 30 days, up to 20 permits
//   RECORD=1 npm run pipeline -- --discover --discover-days=7 --discover-limit=50

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchPermitById, fetchPermits } from "./sources/permits.js";
import { matchWatchlist } from "./gate/index.js";
import { processEvent } from "./pipeline.js";
import type { PipelineOutput, RawEvent, ReferenceNode, WatchlistCompany } from "./schemas/index.js";

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
const discover = process.argv.includes("--discover");

function parseIntArg(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  const parsed = arg ? Number(arg.slice(flag.length + 1)) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const discoverDays = parseIntArg("--discover-days", 30);
const discoverLimit = parseIntArg("--discover-limit", 20);

interface LoadedEvent {
  rawEvent: RawEvent;
  velocityCount: number;
}

/**
 * Discovery mode: query recent permits live and let the pipeline's own
 * gate/unmask stages find matches — nothing is pre-selected. There's no
 * persistence layer (per CLAUDE.md's non-goals), so expansion velocity for
 * this run is estimated from a free gate pre-pass over the SAME discovered
 * batch (no unmask, no LLM, no Mireye spend) — an event the free gate can't
 * match defaults to velocityCount=1, so an unmask-resolved company's "first
 * known permit" is scored honestly rather than inflated by events it
 * wasn't yet known to belong to.
 */
async function loadDiscoveredEvents(watchlist: WatchlistCompany[]): Promise<LoadedEvent[]> {
  const cutoff = new Date(Date.now() - discoverDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`[discover] querying Chicago permits issued since ${cutoff}, limit ${discoverLimit}...`);
  const rawEvents = await fetchPermits(`issue_date > '${cutoff}'`, discoverLimit);
  console.log(`[discover] fetched ${rawEvents.length} permits; gate + unmask will decide relevance.`);

  const velocityByCompany = new Map<string, number>();
  for (const rawEvent of rawEvents) {
    const gate = matchWatchlist(rawEvent, watchlist);
    if (gate.matched && gate.company) {
      velocityByCompany.set(gate.company, (velocityByCompany.get(gate.company) ?? 0) + 1);
    }
  }

  return rawEvents.map((rawEvent) => {
    const gate = matchWatchlist(rawEvent, watchlist);
    const velocityCount = gate.matched && gate.company ? (velocityByCompany.get(gate.company) ?? 1) : 1;
    return { rawEvent, velocityCount };
  });
}

async function loadFixedDemoEvents(demoData: DemoDataFile): Promise<LoadedEvent[]> {
  const loaded: LoadedEvent[] = [];
  for (const entry of demoData.events) {
    const rawEvent = await fetchPermitById(entry.permit_id);
    if (!rawEvent) {
      console.error(`No permit found for id=${entry.permit_id}, skipping.`);
      continue;
    }
    loaded.push({ rawEvent, velocityCount: entry.historical_velocity + 1 });
  }
  return loaded;
}

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
  const llmCost =
    output.cost_ledger.llm_cost_dollars === null
      ? "unavailable (replayed from a pre-usage-tracking fixture)"
      : `$${output.cost_ledger.llm_cost_dollars.toFixed(5)} (approx — see PRICING_PER_MILLION_TOKENS in llm/client.ts)`;
  console.log(
    `  llm usage:          ${output.cost_ledger.llm_input_tokens} input / ` +
      `${output.cost_ledger.llm_output_tokens} output tokens, cost ${llmCost}`,
  );
}

async function main() {
  const demoDataPath = path.resolve(process.cwd(), "demo-data", "watchlist.json");
  const demoData = JSON.parse(await readFile(demoDataPath, "utf-8")) as DemoDataFile;

  const events = discover ? await loadDiscoveredEvents(demoData.watchlist) : await loadFixedDemoEvents(demoData);

  const outputs: PipelineOutput[] = [];
  let totalMireyeCredits = 0;
  let totalExaCost = 0;

  for (const { rawEvent, velocityCount } of events) {
    const output = await processEvent(rawEvent, demoData.watchlist, demoData.reference_nodes, {
      velocityCount,
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
