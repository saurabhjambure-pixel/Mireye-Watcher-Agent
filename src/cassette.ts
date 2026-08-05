// Record/replay wrapper for every external call (permits, Exa, Mireye, LLM).
//
// Default mode (RECORD unset or "0"): replay from /fixtures. No network
// calls to paid or rate-limited APIs happen. This is what makes FR9
// ("running the pipeline twice produces the same result") actually true,
// rather than merely asserted — and it means a live 503/429 from Mireye's
// shared-budget gates can never take down a demo recording.
//
// RECORD=1: call the real function and write its result to /fixtures,
// keyed by a hash of {provider, op, key}. Re-running with the same inputs
// in record mode overwrites the fixture (useful when re-recording after an
// API change); running in replay mode never touches the network.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIXTURES_DIR = path.resolve(process.cwd(), "fixtures");
const cassetteCallCounts = new Map<string, number>();

/** Audit instrumentation: count every external-call wrapper entered, including replayed calls. */
export function resetCassetteCallCounters(): void {
  cassetteCallCounts.clear();
}

export function getCassetteCallCounters(): Record<string, number> {
  return Object.fromEntries(cassetteCallCounts.entries());
}

function isRecordMode(): boolean {
  return process.env.RECORD === "1";
}

export interface CassetteKey {
  provider: string; // "permits" | "mireye" | "exa" | "llm"
  op: string; // e.g. "fetch", "proximity", "search", "extract"
  key: unknown; // JSON-serializable request identity (address, fields, prompt hash, etc.)
}

function fixturePath({ provider, op, key }: CassetteKey): string {
  const digest = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
  return path.join(FIXTURES_DIR, provider, `${op}-${digest}.json`);
}

export class CassetteMissError extends Error {
  constructor(public readonly filePath: string, public readonly cassetteKey: CassetteKey) {
    super(
      `No recorded fixture at ${filePath} for ${cassetteKey.provider}/${cassetteKey.op}. ` +
        `Run with RECORD=1 and real API keys set to record it, or add a fixture by hand.`,
    );
    this.name = "CassetteMissError";
  }
}

/**
 * Wrap an external call so it replays from a recorded fixture by default,
 * or records a fresh one when RECORD=1. `label` should uniquely identify
 * the call (provider + operation + request identity) so different inputs
 * don't collide on the same fixture file.
 */
export async function withCassette<T>(cassetteKey: CassetteKey, live: () => Promise<T>): Promise<T> {
  const counterKey = `${cassetteKey.provider}/${cassetteKey.op}`;
  cassetteCallCounts.set(counterKey, (cassetteCallCounts.get(counterKey) ?? 0) + 1);
  const filePath = fixturePath(cassetteKey);

  if (isRecordMode()) {
    const result = await live();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ recorded_at: new Date().toISOString(), cassetteKey, result }, null, 2),
      "utf-8",
    );
    return result;
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { result: T };
    return parsed.result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CassetteMissError(filePath, cassetteKey);
    }
    throw err;
  }
}
