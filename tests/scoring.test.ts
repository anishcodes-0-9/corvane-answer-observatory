import { describe, expect, it } from "vitest";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { parseResponseFiles } from "../src/lib/load";
import { computeScores, MIN_MATCHED_SLOTS, pairedVerdict, POINTS, tCritical95 } from "../src/lib/scoring";
import type { ExpectedDataset } from "../src/lib/types";
import { shippedCatalog } from "./helpers/brandFixtures";

const catalog = shippedCatalog();
const brands = catalog.brands.map((b) => ({ id: b.id, tier: b.tier }));
const ENGINES = ["chatgpt", "perplexity", "google_ai_overview"];
const PROMPTS = Array.from({ length: 12 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
const plan = (weeks: number[]): ExpectedDataset => ({ weeks, engines: ENGINES, promptIds: PROMPTS, runs: [1, 2] });

// Synthetic answers whose Corvane tone is unambiguous.
const TEXT = {
  recommended: "For small fleets, Corvane is a strong pick.", // 100
  neutral: "Other options include Corvane and Fleetora.", // 50
  negative: "Corvane is cheap, but users report slow support.", // 25
  not_recommended: "Avoid Corvane if you run fewer than 100 vehicles.", // 0
  absent: "For small fleets, Trakvia is a strong pick.", // Corvane 0, Trakvia 100
};

type Rec = Record<string, unknown>;
let seq = 0;
const rec = (week: number, engine: string, prompt: string, run: number, text: string, extra: Rec = {}): Rec => ({
  response_id: `r${seq++}`, week, engine, prompt_id: prompt, run, response_text: text, ...extra,
});
/** Records for one week: `textFor(engine, prompt, run)` returns the answer text, or null to omit the record. */
const week = (w: number, textFor: (engine: string, prompt: string, run: number) => string | null, engines = ENGINES, prompts = PROMPTS) =>
  engines.flatMap((e) => prompts.flatMap((p) => [1, 2].map((r) => ({ e, p, r, t: textFor(e, p, r) })))).filter((x) => x.t !== null).map((x) => rec(w, x.e, x.p, x.r, x.t!));

function score(records: Rec[], weeks: number[]) {
  const responses = parseResponseFiles([{ name: "responses.jsonl", content: records.map((r) => JSON.stringify(r)).join("\n") }]).responses;
  const analysis = analyzeResponses(responses, catalog);
  return computeScores(responses, analysis.responses, brands, plan(weeks));
}
const corvane = (report: ReturnType<typeof score>) => report.brands.find((b) => b.brand === "corvane")!;

describe("points and slot scores", () => {
  it("uses the documented points and averages runs within a slot", () => {
    expect(POINTS).toEqual({ recommended: 100, neutral: 50, negative: 25, not_recommended: 0, not_mentioned: 0 });
    const r = score(week(1, (_e, _p, run) => (run === 1 ? TEXT.recommended : TEXT.neutral)), [1]);
    expect(corvane(r).weeks[0]).toMatchObject({ score: 75, observedSlots: 36, expectedSlots: 36, partial: false, runToRunSwing: 50, runPairs: 36 });
    const t = r.brands.find((b) => b.brand === "trakvia")!;
    expect(t.weeks[0]!.score).toBe(0);
  });

  it.each([
    ["negative", 25],
    ["not_recommended", 0],
    ["absent", 0],
  ] as const)("scores a %s answer as %i", (kind, points) => {
    expect(corvane(score(week(1, () => TEXT[kind]), [1])).weeks[0]!.score).toBe(points);
  });
});

describe("timeouts and missing data", () => {
  it("excludes a timed-out run instead of scoring it as zero", () => {
    const records = week(1, (_e, _p, run) => (run === 1 ? "" : TEXT.recommended)).map((r) =>
      r.response_text === "" ? { ...r, error: "timeout" } : r,
    );
    expect(corvane(score(records, [1])).weeks[0]).toMatchObject({ score: 100, observedSlots: 36, runPairs: 0 });
  });

  it("marks a slot with only timeouts as missing, not zero", () => {
    const records = week(1, () => TEXT.recommended).map((r) =>
      r.engine === "chatgpt" && r.prompt_id === "P01" ? { ...r, response_text: "", error: "timeout" } : r,
    );
    expect(corvane(score(records, [1])).weeks[0]).toMatchObject({ score: 100, observedSlots: 35, missingSlots: 1, partial: true, missingEngines: [] });
  });

  it("does not turn a missing engine into a false decline", () => {
    // Week 1: Perplexity recommends Corvane (100), others are neutral (50) → 66.67.
    // Week 2: identical answers, but Perplexity was not collected.
    const w1 = week(1, (e) => (e === "perplexity" ? TEXT.recommended : TEXT.neutral));
    const w2 = week(2, (e) => (e === "perplexity" ? null : TEXT.neutral));
    const c = corvane(score([...w1, ...w2], [1, 2]));
    expect(c.weeks.map((w) => w.score)).toEqual([66.67, 50]); // the naive week averages differ...
    expect(c.weeks[1]).toMatchObject({ partial: true, missingEngines: ["perplexity"], observedSlots: 24, missingSlots: 12 });
    expect(c.changes[0]).toMatchObject({ matchedSlots: 24, meanChange: 0, verdict: "no_clear_change" }); // ...but matched slots did not change
  });

  it("reports a week with no data as missing, with inconclusive changes either side", () => {
    const c = corvane(score([...week(1, () => TEXT.neutral), ...week(3, () => TEXT.neutral)], [1, 2, 3]));
    expect(c.weeks[1]).toMatchObject({ week: 2, score: null, observedSlots: 0, partial: true, missingEngines: ENGINES });
    expect(c.changes.map((x) => [x.fromWeek, x.toWeek, x.matchedSlots, x.verdict])).toEqual([
      [1, 2, 0, "inconclusive"],
      [2, 3, 0, "inconclusive"],
    ]);
  });

  it("counts an exact duplicate record once", () => {
    const records = week(1, () => TEXT.recommended);
    const c = corvane(score([...records, records[0]!], [1]));
    expect(c.weeks[0]).toMatchObject({ score: 100, runPairs: 36 });
  });
});

describe("week-on-week change", () => {
  it("reports no change for identical weeks", () => {
    const c = corvane(score([...week(1, () => TEXT.neutral), ...week(2, () => TEXT.neutral)], [1, 2]));
    expect(c.changes[0]).toMatchObject({ matchedSlots: 36, meanChange: 0, verdict: "no_clear_change", topContributors: [] });
  });

  it("reports a consistent rise as up, with contributing slots linked to their answers", () => {
    const w1 = week(1, () => TEXT.neutral);
    const w2 = week(2, (_e, p) => (Number(p.slice(1)) % 3 === 0 ? TEXT.neutral : TEXT.recommended));
    const c = corvane(score([...w1, ...w2], [1, 2]));
    expect(c.changes[0]!.verdict).toBe("up");
    expect(c.changes[0]!.interval!.low).toBeGreaterThan(0);
    const top = c.changes[0]!.topContributors[0]!;
    expect(top).toMatchObject({ from: 50, to: 100, change: 50 });
    expect(top.fromResponses).toHaveLength(2);
    expect(top.toResponses).toHaveLength(2);
  });

  it("calls a large change on too few matched slots inconclusive", () => {
    const few = ["P01", "P02", "P03"];
    const w1 = week(1, () => TEXT.not_recommended, ["chatgpt"], few);
    const w2 = week(2, () => TEXT.recommended, ["chatgpt"], few);
    const c = corvane(score([...w1, ...w2], [1, 2]));
    expect(c.changes[0]).toMatchObject({ matchedSlots: 3, meanChange: 100, verdict: "inconclusive", interval: null });
  });

  it("names the competitors that gained where Corvane fell", () => {
    const w1 = week(1, () => TEXT.recommended);
    const w2 = week(2, () => TEXT.absent); // Trakvia recommended instead of Corvane
    const c = corvane(score([...w1, ...w2], [1, 2]));
    expect(c.changes[0]!.verdict).toBe("down");
    expect(c.changes[0]!.gainersWhereThisFell).toEqual([{ brand: "trakvia", meanChange: 100, slots: 36 }]);
  });

  it("is deterministic", () => {
    const records = [...week(1, (e) => (e === "chatgpt" ? TEXT.negative : TEXT.neutral)), ...week(2, () => TEXT.recommended)];
    expect(JSON.stringify(score(records, [1, 2]))).toBe(JSON.stringify(score(records, [1, 2])));
  });
});

describe("uncertainty method", () => {
  it("uses Student-t critical values, conservatively between table entries", () => {
    expect(tCritical95(1)).toBe(12.706);
    expect(tCritical95(29)).toBe(2.045);
    expect(tCritical95(35)).toBe(2.042); // uses df 30: slightly wider
    expect(tCritical95(500)).toBe(1.96);
  });

  it("returns inconclusive below the minimum and an interval above it", () => {
    expect(pairedVerdict([])).toMatchObject({ matchedSlots: 0, verdict: "inconclusive" });
    expect(pairedVerdict(Array(MIN_MATCHED_SLOTS - 1).fill(50)).verdict).toBe("inconclusive");
    const mixed = pairedVerdict([50, -50, 25, -25, 0, 50, -50, 25, -25, 0]);
    expect(mixed).toMatchObject({ meanChange: 0, verdict: "no_clear_change" });
    expect(pairedVerdict(Array(MIN_MATCHED_SLOTS).fill(-25))).toMatchObject({ verdict: "down", interval: { low: -25, high: -25 } });
  });
});
