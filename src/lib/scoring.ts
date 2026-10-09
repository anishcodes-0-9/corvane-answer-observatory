/**
 * Visibility score (see docs/scoring.md).
 *
 * Points per analysed answer (product-design choices, not validated weights):
 *   recommended 100, neutral 50, negative 25, not_recommended 0, not mentioned 0.
 * A slot is one question × engine × week. Its score is the mean of the points
 * from the runs that produced an analysable answer; a slot with none is
 * MISSING (no score), never zero. A week's score is the mean over its observed
 * slots, reported with observed/expected slot counts.
 *
 * Week-on-week change uses only slots observed in both weeks (matched slots).
 * The paired slot differences give a mean change and a 95% t-interval; with
 * fewer than MIN_MATCHED_SLOTS matched slots the result is "inconclusive".
 */
import type { BrandId, BrandTier, ResponseBrandAnalysis } from "./brandTypes";
import type { Tone } from "./tone";
import type { ExpectedDataset, NormalizedResponse } from "./types";

export const POINTS: Record<Tone | "not_mentioned", number> = {
  recommended: 100,
  neutral: 50,
  negative: 25,
  not_recommended: 0,
  not_mentioned: 0,
};
/** Below this many matched slots a week-on-week change is reported as inconclusive. */
export const MIN_MATCHED_SLOTS = 10;

export type Verdict = "up" | "down" | "no_clear_change" | "inconclusive";

export interface SlotScore {
  week: number;
  engine: string;
  promptId: string;
  /** Mean points over analysed runs. */
  score: number;
  runs: number;
  responseIds: string[];
}

export interface WeekScore {
  week: number;
  /** Mean over observed slots; null when no slot was observed. */
  score: number | null;
  observedSlots: number;
  expectedSlots: number;
  missingSlots: number;
  /** Expected engines with no analysable answer this week. */
  missingEngines: string[];
  partial: boolean;
  /** Mean |run 1 − run 2| over slots with two analysed runs: descriptive run-to-run variation. */
  runToRunSwing: number | null;
  runPairs: number;
}

export interface SlotChange {
  engine: string;
  promptId: string;
  from: number;
  to: number;
  change: number;
  fromResponses: string[];
  toResponses: string[];
}

export interface WeekChange {
  fromWeek: number;
  toWeek: number;
  matchedSlots: number;
  /** Mean paired change over matched slots (descriptive). */
  meanChange: number | null;
  /** 95% t-interval for the mean paired change; null when not computable. */
  interval: { low: number; high: number } | null;
  verdict: Verdict;
  /** Plain-English reason for the verdict. */
  reason: string;
  /** Matched slots with the largest absolute change, largest first. */
  topContributors: SlotChange[];
  /** In matched slots where this brand fell: other brands' mean change there, largest gain first. */
  gainersWhereThisFell: Array<{ brand: BrandId; meanChange: number; slots: number }>;
}

export interface BrandScores {
  brand: BrandId;
  tier: BrandTier;
  weeks: WeekScore[];
  changes: WeekChange[];
}

export interface ScoreReport {
  points: typeof POINTS;
  minMatchedSlots: number;
  weeks: number[];
  brands: BrandScores[];
}

/** Two-sided 95% Student-t critical values; for df between entries the smaller df (wider interval) is used. */
const T95: Array<[number, number]> = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262],
  [10, 2.228], [11, 2.201], [12, 2.179], [13, 2.16], [14, 2.145], [15, 2.131], [16, 2.12], [17, 2.11], [18, 2.101],
  [19, 2.093], [20, 2.086], [21, 2.08], [22, 2.074], [23, 2.069], [24, 2.064], [25, 2.06], [26, 2.056], [27, 2.052],
  [28, 2.048], [29, 2.045], [30, 2.042], [40, 2.021], [50, 2.009], [60, 2.0], [80, 1.99], [100, 1.984], [120, 1.98],
];
export function tCritical95(df: number): number {
  if (df < 1) return Infinity;
  let value = 1.96;
  for (const [d, t] of T95) if (df >= d) value = t;
  return df > 120 ? 1.96 : value;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Summarises paired differences into a verdict. Exported for tests. */
export function pairedVerdict(diffs: readonly number[]): Pick<WeekChange, "matchedSlots" | "meanChange" | "interval" | "verdict" | "reason"> {
  const n = diffs.length;
  if (n === 0) return { matchedSlots: 0, meanChange: null, interval: null, verdict: "inconclusive", reason: "No question/engine slots were observed in both weeks." };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  if (n < MIN_MATCHED_SLOTS) {
    return {
      matchedSlots: n,
      meanChange: round(mean),
      interval: null,
      verdict: "inconclusive",
      reason: `Only ${n} matched slots (minimum ${MIN_MATCHED_SLOTS}); too few to separate a change from run-to-run variation.`,
    };
  }
  const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1));
  const half = tCritical95(n - 1) * (sd / Math.sqrt(n));
  const interval = { low: round(mean - half), high: round(mean + half) };
  if (interval.low > 0) return { matchedSlots: n, meanChange: round(mean), interval, verdict: "up", reason: `Across ${n} matched slots the 95% interval for the average change (${interval.low} to ${interval.high} points) is above zero.` };
  if (interval.high < 0) return { matchedSlots: n, meanChange: round(mean), interval, verdict: "down", reason: `Across ${n} matched slots the 95% interval for the average change (${interval.low} to ${interval.high} points) is below zero.` };
  return {
    matchedSlots: n,
    meanChange: round(mean),
    interval,
    verdict: "no_clear_change",
    reason: `Across ${n} matched slots the 95% interval for the average change (${interval.low} to ${interval.high} points) includes zero, so the movement is within run-to-run variation.`,
  };
}

/**
 * Scores every brand per week. `responses` and `analyses` must describe the
 * same retained responses; `expected` is the validated collection plan.
 */
export function computeScores(
  responses: readonly NormalizedResponse[],
  analyses: readonly ResponseBrandAnalysis[],
  brands: ReadonlyArray<{ id: BrandId; tier: BrandTier }>,
  expected: ExpectedDataset,
): ScoreReport {
  const analysisById = new Map(analyses.map((a) => [a.responseId, a]));
  const weeks = [...new Set([...expected.weeks, ...responses.map((r) => r.week)])].sort((a, b) => a - b);
  const slotKey = (week: number, engine: string, promptId: string) => `${week}|${engine}|${promptId}`;

  // Analysed runs per slot (errors and empty answers are excluded, not zeroed).
  const runsBySlot = new Map<string, Array<{ response: NormalizedResponse; analysis: ResponseBrandAnalysis & { status: "analyzed" } }>>();
  for (const r of responses) {
    const a = analysisById.get(r.id);
    if (!a || a.status !== "analyzed") continue;
    const key = slotKey(r.week, r.engine, r.promptId);
    runsBySlot.set(key, [...(runsBySlot.get(key) ?? []), { response: r, analysis: a }]);
  }
  for (const list of runsBySlot.values()) list.sort((x, y) => (x.response.run ?? 0) - (y.response.run ?? 0) || (x.response.id < y.response.id ? -1 : 1));

  const pointsFor = (a: ResponseBrandAnalysis & { status: "analyzed" }, brand: BrandId) => {
    const b = a.brands.find((x) => x.brand === brand);
    return b?.mentioned && b.tone ? POINTS[b.tone] : POINTS.not_mentioned;
  };

  const slotScores = (brand: BrandId, week: number): Map<string, SlotScore> => {
    const out = new Map<string, SlotScore>();
    for (const engine of expected.engines) {
      for (const promptId of expected.promptIds) {
        const runs = runsBySlot.get(slotKey(week, engine, promptId));
        if (!runs || runs.length === 0) continue;
        const pts = runs.map((x) => pointsFor(x.analysis, brand));
        out.set(`${engine}|${promptId}`, {
          week, engine, promptId,
          score: pts.reduce((a, b) => a + b, 0) / pts.length,
          runs: pts.length,
          responseIds: runs.map((x) => x.response.id),
        });
      }
    }
    return out;
  };

  const expectedSlots = expected.engines.length * expected.promptIds.length;
  const cache = new Map<string, Map<string, SlotScore>>();
  const slotsOf = (brand: BrandId, week: number) => {
    const k = `${brand}|${week}`;
    if (!cache.has(k)) cache.set(k, slotScores(brand, week));
    return cache.get(k)!;
  };

  const brandScores: BrandScores[] = brands.map(({ id: brand, tier }) => {
    const weekScores: WeekScore[] = weeks.map((week) => {
      const slots = slotsOf(brand, week);
      const values = [...slots.values()];
      const engineSeen = new Set(values.map((s) => s.engine));
      let swing = 0;
      let pairs = 0;
      for (const engine of expected.engines) {
        for (const promptId of expected.promptIds) {
          const runs = runsBySlot.get(slotKey(week, engine, promptId));
          if (runs && runs.length >= 2) {
            swing += Math.abs(pointsFor(runs[0]!.analysis, brand) - pointsFor(runs[1]!.analysis, brand));
            pairs += 1;
          }
        }
      }
      return {
        week,
        score: values.length ? round(values.reduce((a, s) => a + s.score, 0) / values.length) : null,
        observedSlots: values.length,
        expectedSlots,
        missingSlots: expectedSlots - values.length,
        missingEngines: expected.engines.filter((e) => !engineSeen.has(e)),
        partial: values.length < expectedSlots,
        runToRunSwing: pairs ? round(swing / pairs) : null,
        runPairs: pairs,
      };
    });

    const changes: WeekChange[] = [];
    for (let i = 1; i < weeks.length; i++) {
      const fromWeek = weeks[i - 1]!;
      const toWeek = weeks[i]!;
      const from = slotsOf(brand, fromWeek);
      const to = slotsOf(brand, toWeek);
      const matched: SlotChange[] = [];
      for (const [key, a] of from) {
        const b = to.get(key);
        if (!b) continue;
        matched.push({ engine: a.engine, promptId: a.promptId, from: a.score, to: b.score, change: b.score - a.score, fromResponses: a.responseIds, toResponses: b.responseIds });
      }
      matched.sort((x, y) => (x.engine < y.engine ? -1 : x.engine > y.engine ? 1 : x.promptId < y.promptId ? -1 : x.promptId > y.promptId ? 1 : 0));
      const verdict = pairedVerdict(matched.map((m) => m.change));
      const topContributors = [...matched]
        .filter((m) => m.change !== 0)
        .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || (x.engine + x.promptId < y.engine + y.promptId ? -1 : 1))
        .slice(0, 5);
      const fell = matched.filter((m) => m.change < 0);
      const gainers = brands
        .filter((b) => b.id !== brand)
        .map((other) => {
          const oFrom = slotsOf(other.id, fromWeek);
          const oTo = slotsOf(other.id, toWeek);
          const diffs = fell.map((m) => oTo.get(`${m.engine}|${m.promptId}`)!.score - oFrom.get(`${m.engine}|${m.promptId}`)!.score);
          return { brand: other.id, meanChange: diffs.length ? round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : 0, slots: diffs.length };
        })
        .filter((g) => g.slots > 0 && g.meanChange > 0)
        .sort((x, y) => y.meanChange - x.meanChange || (x.brand < y.brand ? -1 : 1));
      changes.push({ fromWeek, toWeek, ...verdict, topContributors, gainersWhereThisFell: gainers });
    }
    return { brand, tier, weeks: weekScores, changes };
  });

  return { points: POINTS, minMatchedSlots: MIN_MATCHED_SLOTS, weeks, brands: brandScores };
}
