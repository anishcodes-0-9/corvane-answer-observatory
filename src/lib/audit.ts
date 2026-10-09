/**
 * Manual accuracy audit (core requirement 6): "Pick 15 answers at random,
 * check them by hand, and report how often your tool is right on mentions
 * and tone, and where it goes wrong."
 *
 * - sampleForAudit: a reproducible random sample of analysable answers.
 * - reviewSheet / predictionSheet: the blind labelling sheet and the tool's
 *   predictions, kept in separate files.
 * - compareAudit: scores the tool against completed human labels.
 */
import type { ResponseBrandAnalysis } from "./brandTypes";
import { toCsv } from "./mentionsCsv";
import type { NormalizedResponse } from "./types";

export const AUDIT_SEED = "corvane-manual-audit-v1";
export const AUDIT_SIZE = 15;
const TONES = ["recommended", "neutral", "negative", "not_recommended"] as const;

/** FNV-1a string hash → 32-bit seed. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks `size` analysable answers uniformly at random, reproducibly for a given seed. */
export function sampleForAudit(responses: readonly NormalizedResponse[], seed = AUDIT_SEED, size = AUDIT_SIZE): NormalizedResponse[] {
  const pool = responses.filter((r) => r.status === "ok").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = rng(hashSeed(seed));
  const a = [...pool];
  const n = Math.min(size, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(next() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n).sort((x, y) => x.week - y.week || (x.engine < y.engine ? -1 : x.engine > y.engine ? 1 : 0) || (x.promptId < y.promptId ? -1 : 1) || (x.run ?? 0) - (y.run ?? 0));
}

const labelColumns = (brands: readonly string[]) => brands.flatMap((b) => [`${b}_mentioned`, `${b}_position`, `${b}_tone`]);

/** Blind sheet: answer text and empty label columns; no predictions. */
export function reviewSheet(sample: readonly NormalizedResponse[], questions: Record<string, string>, brands: readonly string[]): string {
  const header = ["response_id", "week", "engine", "prompt_id", "question", "answer_text", ...labelColumns(brands), "ambiguous", "notes"];
  return toCsv(
    header,
    sample.map((r) => [r.id, String(r.week), r.engine, r.promptId, questions[r.promptId] ?? "", r.text, ...labelColumns(brands).map(() => ""), "", ""]),
  );
}

/** The tool's predictions for the same answers, in the same columns. */
export function predictionSheet(sample: readonly NormalizedResponse[], analyses: readonly ResponseBrandAnalysis[], brands: readonly string[]): string {
  const byId = new Map(analyses.map((a) => [a.responseId, a]));
  const header = ["response_id", ...labelColumns(brands)];
  return toCsv(
    header,
    sample.map((r) => {
      const a = byId.get(r.id);
      if (!a || a.status !== "analyzed") throw new Error(`${r.id} was not analysed`);
      return [
        r.id,
        ...brands.flatMap((b) => {
          const x = a.brands.find((y) => y.brand === b)!;
          return x.mentioned ? ["true", String(x.position), x.tone ?? ""] : ["false", "", ""];
        }),
      ];
    }),
  );
}

export interface AuditLabel {
  mentioned: boolean;
  position: number | null;
  tone: string | null;
}
export interface AuditRow {
  responseId: string;
  ambiguous: boolean;
  notes: string;
  brands: Record<string, AuditLabel>;
}

/** Parses a filled sheet (human or predictions). Returns problems for blank or invalid cells. */
export function parseAuditSheet(rows: string[][], brands: readonly string[], requireLabels: boolean): { rows: AuditRow[]; problems: string[] } {
  const [header, ...body] = rows;
  const problems: string[] = [];
  if (!header) return { rows: [], problems: ["empty sheet"] };
  const col = (name: string) => header.indexOf(name);
  const out: AuditRow[] = [];
  for (const cells of body) {
    const id = (cells[col("response_id")] ?? "").trim();
    if (!id) continue;
    const row: AuditRow = {
      responseId: id,
      ambiguous: /^(y|yes|true|1|x)$/i.test((cells[col("ambiguous")] ?? "").trim()),
      notes: (cells[col("notes")] ?? "").trim(),
      brands: {},
    };
    for (const b of brands) {
      const m = (cells[col(`${b}_mentioned`)] ?? "").trim().toLowerCase();
      const p = (cells[col(`${b}_position`)] ?? "").trim();
      const t = (cells[col(`${b}_tone`)] ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (m === "") {
        if (requireLabels) problems.push(`${id}: ${b}_mentioned is blank (use true or false)`);
        row.brands[b] = { mentioned: false, position: null, tone: null };
        continue;
      }
      const mentioned = /^(true|yes|y|1)$/.test(m);
      if (!mentioned && !/^(false|no|n|0)$/.test(m)) problems.push(`${id}: ${b}_mentioned must be true or false, got "${m}"`);
      if (mentioned && !/^\d+$/.test(p)) problems.push(`${id}: ${b}_position must be a number when mentioned`);
      if (mentioned && !(TONES as readonly string[]).includes(t)) problems.push(`${id}: ${b}_tone must be one of ${TONES.join(", ")}`);
      row.brands[b] = { mentioned, position: mentioned && /^\d+$/.test(p) ? Number(p) : null, tone: mentioned ? t : null };
    }
    out.push(row);
  }
  return { rows: out, problems };
}

export interface AuditDisagreement {
  responseId: string;
  brand: string;
  field: "mentioned" | "position" | "tone";
  human: string;
  tool: string;
  ambiguous: boolean;
}

export interface AuditResult {
  answers: number;
  ambiguousAnswers: number;
  /** Over every answer × brand cell. */
  mention: { agree: number; total: number; truePositive: number; falsePositive: number; falseNegative: number; precision: number | null; recall: number | null };
  /** Over cells both human and tool marked as mentioned. */
  position: { agree: number; total: number };
  tone: { agree: number; total: number; confusion: Record<string, Record<string, number>> };
  disagreements: AuditDisagreement[];
}

export function compareAudit(human: readonly AuditRow[], tool: readonly AuditRow[], brands: readonly string[], options: { excludeAmbiguous?: boolean } = {}): AuditResult {
  const toolById = new Map(tool.map((t) => [t.responseId, t]));
  const rows = human.filter((h) => toolById.has(h.responseId) && !(options.excludeAmbiguous && h.ambiguous));
  const r: AuditResult = {
    answers: rows.length,
    ambiguousAnswers: rows.filter((h) => h.ambiguous).length,
    mention: { agree: 0, total: 0, truePositive: 0, falsePositive: 0, falseNegative: 0, precision: null, recall: null },
    position: { agree: 0, total: 0 },
    tone: { agree: 0, total: 0, confusion: {} },
    disagreements: [],
  };
  for (const h of rows) {
    const t = toolById.get(h.responseId)!;
    for (const b of brands) {
      const hl = h.brands[b]!;
      const tl = t.brands[b]!;
      const add = (field: AuditDisagreement["field"], hv: unknown, tv: unknown) =>
        r.disagreements.push({ responseId: h.responseId, brand: b, field, human: String(hv ?? ""), tool: String(tv ?? ""), ambiguous: h.ambiguous });
      r.mention.total += 1;
      if (hl.mentioned === tl.mentioned) r.mention.agree += 1;
      else add("mentioned", hl.mentioned, tl.mentioned);
      if (hl.mentioned && tl.mentioned) r.mention.truePositive += 1;
      if (!hl.mentioned && tl.mentioned) r.mention.falsePositive += 1;
      if (hl.mentioned && !tl.mentioned) r.mention.falseNegative += 1;
      if (hl.mentioned && tl.mentioned) {
        r.position.total += 1;
        if (hl.position === tl.position) r.position.agree += 1;
        else add("position", hl.position, tl.position);
        r.tone.total += 1;
        const conf = (r.tone.confusion[hl.tone ?? "?"] ??= {});
        conf[tl.tone ?? "?"] = (conf[tl.tone ?? "?"] ?? 0) + 1;
        if (hl.tone === tl.tone) r.tone.agree += 1;
        else add("tone", hl.tone, tl.tone);
      }
    }
  }
  const m = r.mention;
  m.precision = m.truePositive + m.falsePositive ? m.truePositive / (m.truePositive + m.falsePositive) : null;
  m.recall = m.truePositive + m.falseNegative ? m.truePositive / (m.truePositive + m.falseNegative) : null;
  return r;
}
