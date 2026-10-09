/**
 * mentions.csv, exactly as the brief specifies:
 *   response_id, brand, mentioned, position, tone
 * "one row for every answer and every company, so six rows per answer,
 * including when a company isn't mentioned."
 *
 * Responses that could not be analysed (collector errors such as timeouts, or
 * empty text) still get their six rows, with mentioned=false and blank
 * position/tone (approved decision G1; documented in the README). The analysis
 * artifact and coverage report keep them as "not_analyzed", so an error is
 * never presented elsewhere as a verified "not mentioned".
 */
import type { ResponseBrandAnalysis } from "./brandTypes";
import type { Tone } from "./tone";

export const MENTIONS_HEADER = ["response_id", "brand", "mentioned", "position", "tone"] as const;
const TONES: ReadonlySet<string> = new Set<Tone>(["recommended", "neutral", "negative", "not_recommended"]);

export interface MentionRow {
  response_id: string;
  brand: string;
  mentioned: boolean;
  position: number | null;
  tone: Tone | null;
}

export function buildMentionRows(analyses: readonly ResponseBrandAnalysis[], brandIds: readonly string[]): MentionRow[] {
  const rows: MentionRow[] = [];
  for (const a of analyses) {
    if (a.status === "not_analyzed") {
      for (const brand of brandIds) rows.push({ response_id: a.responseId, brand, mentioned: false, position: null, tone: null });
      continue;
    }
    const byBrand = new Map(a.brands.map((b) => [b.brand, b]));
    for (const brand of brandIds) {
      const b = byBrand.get(brand);
      rows.push({
        response_id: a.responseId,
        brand,
        mentioned: b?.mentioned ?? false,
        position: b?.mentioned ? b.position : null,
        tone: b?.mentioned ? b.tone : null,
      });
    }
  }
  return rows;
}

/** Checks every rule of the brief's schema; returns human-readable problems (empty = valid). */
export function validateMentionRows(rows: readonly MentionRow[], responseIds: readonly string[], brandIds: readonly string[]): string[] {
  const problems: string[] = [];
  if (rows.length !== responseIds.length * brandIds.length) {
    problems.push(`${rows.length} rows; expected ${responseIds.length} responses × ${brandIds.length} brands = ${responseIds.length * brandIds.length}`);
  }
  const byResponse = new Map<string, MentionRow[]>();
  for (const r of rows) byResponse.set(r.response_id, [...(byResponse.get(r.response_id) ?? []), r]);
  for (const id of responseIds) {
    const own = byResponse.get(id) ?? [];
    const brands = own.map((r) => r.brand);
    if (own.length !== brandIds.length || brandIds.some((b) => !brands.includes(b))) {
      problems.push(`${id}: expected one row for each of ${brandIds.join(", ")}`);
    }
    const positions = own.filter((r) => r.mentioned).map((r) => r.position).sort((x, y) => (x ?? 0) - (y ?? 0));
    if (positions.some((p, i) => p !== i + 1)) problems.push(`${id}: positions ${positions.join(",")} are not 1..n`);
  }
  for (const r of rows) {
    if (r.mentioned && (r.position === null || r.tone === null || !TONES.has(r.tone))) {
      problems.push(`${r.response_id}/${r.brand}: mentioned rows need a position and one of the four tones`);
    }
    if (!r.mentioned && (r.position !== null || r.tone !== null)) {
      problems.push(`${r.response_id}/${r.brand}: position and tone must be blank when not mentioned`);
    }
  }
  return problems;
}

/** RFC 4180: quote a field only when it contains a comma, quote or line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

export function mentionsCsv(rows: readonly MentionRow[]): string {
  return toCsv(
    MENTIONS_HEADER,
    rows.map((r) => [r.response_id, r.brand, r.mentioned ? "true" : "false", r.position === null ? "" : String(r.position), r.tone ?? ""]),
  );
}
