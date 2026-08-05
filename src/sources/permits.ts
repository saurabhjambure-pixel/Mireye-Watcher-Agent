// Municipal building-permit source (Socrata open-data portals).
//
// This is the "execution signal" half of the pipeline per CLAUDE.md: real
// commercial build-out / signage / low-voltage permits, not a hand-written
// simulation of one. Chicago's permit dataset is public and requires no
// auth or API key. All calls go through src/cassette.ts, so replay mode
// never touches the network.
//
// Deliberately NOT built as a generic multi-source crawler — one Socrata
// dataset, one query shape, per CLAUDE.md's non-goals.

import { withCassette } from "../cassette.js";
import type { RawEvent } from "../schemas/index.js";

const CHICAGO_PERMITS_ENDPOINT = "https://data.cityofchicago.org/resource/ydr8-5enu.json";

interface SocrataPermitRecord {
  id: string;
  permit_?: string;
  permit_type?: string;
  issue_date?: string;
  reported_cost?: string;
  work_description?: string;
  street_number?: string;
  street_direction?: string;
  street_name?: string;
  latitude?: string;
  longitude?: string;
  [key: `contact_${number}_name`]: string | undefined;
}

function extractContacts(record: SocrataPermitRecord): string[] {
  const contacts: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const name = record[`contact_${i}_name` as const];
    if (name) contacts.push(name);
  }
  return contacts;
}

function toRawEvent(record: SocrataPermitRecord): RawEvent {
  const addressParts = [record.street_number, record.street_direction, record.street_name]
    .filter(Boolean)
    .join(" ");
  const sourceText = [
    addressParts && `Permit ${record.permit_ ?? record.id} at ${addressParts}, Chicago, IL.`,
    record.work_description,
    record.reported_cost && `Reported cost: $${record.reported_cost}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `chi-${record.id}`,
    source_text: sourceText,
    source_url: `https://webapps1.chicago.gov/buildingpermits/?permit=${record.permit_ ?? ""}`,
    lat: record.latitude ? Number(record.latitude) : null,
    lng: record.longitude ? Number(record.longitude) : null,
    issue_date: record.issue_date ? record.issue_date.slice(0, 10) : null,
    reported_cost: record.reported_cost ? Number(record.reported_cost) : null,
    contacts: extractContacts(record),
  };
}

/**
 * Fetch recent commercial permits (renovation/alteration, signs, express
 * permits) likely to reflect a retail build-out, restricted to a SoQL
 * `$where` fragment the caller supplies (e.g. an address or keyword filter).
 * Cassette-wrapped: replay mode reads from /fixtures/permits/*.json instead
 * of hitting Socrata live.
 */
export async function fetchPermits(where: string, limit = 5): Promise<RawEvent[]> {
  return withCassette(
    { provider: "permits", op: "search", key: { where, limit } },
    async () => {
      const url = new URL(CHICAGO_PERMITS_ENDPOINT);
      url.searchParams.set("$limit", String(limit));
      url.searchParams.set("$where", where);
      url.searchParams.set("$order", "issue_date DESC");

      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`Socrata permits query failed: HTTP ${res.status}`);
      }
      const records = (await res.json()) as SocrataPermitRecord[];
      return records.map(toRawEvent);
    },
  );
}

/**
 * Convenience helper for the demo: fetch a specific permit by its known
 * Socrata `id`, so the CLI can assemble a fixed, replayable 5-event demo
 * set from real records rather than a live free-text search each run.
 */
export async function fetchPermitById(id: string): Promise<RawEvent | null> {
  const results = await fetchPermits(`id='${id}'`, 1);
  return results[0] ?? null;
}
