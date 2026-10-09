import { describe, expect, it } from "vitest";
import { compareAudit, parseAuditSheet, predictionSheet, reviewSheet, sampleForAudit } from "../src/lib/audit";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { parseCsv, parseResponseFiles } from "../src/lib/load";
import { shippedCatalog } from "./helpers/brandFixtures";

const BRANDS = ["corvane", "trakvia"];
const records = Array.from({ length: 40 }, (_, i) => ({
  response_id: `r${String(i).padStart(2, "0")}`, week: 1 + (i % 3), engine: "chatgpt", prompt_id: `P${String(1 + (i % 15)).padStart(2, "0")}`, run: 1 + (i % 2),
  response_text: i % 2 ? "For small fleets, Corvane is a strong pick. Trakvia also exists." : "Avoid Trakvia if you run fewer than 100 vehicles.",
  ...(i === 3 ? { response_text: "", error: "timeout" } : {}),
}));
const responses = parseResponseFiles([{ name: "responses.jsonl", content: records.map((r) => JSON.stringify(r)).join("\n") }]).responses;

describe("sampleForAudit", () => {
  it("is reproducible, draws only analysable answers, and changes with the seed", () => {
    const a = sampleForAudit(responses);
    expect(a).toHaveLength(15);
    expect(sampleForAudit(responses).map((r) => r.id)).toEqual(a.map((r) => r.id));
    expect(a.every((r) => r.status === "ok")).toBe(true);
    expect(a.map((r) => r.id)).not.toContain("r03");
    expect(sampleForAudit(responses, "another-seed").map((r) => r.id)).not.toEqual(a.map((r) => r.id));
    expect(new Set(a.map((r) => r.id)).size).toBe(15);
  });
});

describe("sheets", () => {
  const sample = sampleForAudit(responses).slice(0, 2);
  const analysis = analyzeResponses(responses, shippedCatalog()).responses;

  it("keeps the blind sheet free of predictions", () => {
    const [header, ...rows] = parseCsv(reviewSheet(sample, { P01: "Q" }, BRANDS));
    expect(header).toEqual(["response_id", "week", "engine", "prompt_id", "question", "answer_text", "corvane_mentioned", "corvane_position", "corvane_tone", "trakvia_mentioned", "trakvia_position", "trakvia_tone", "ambiguous", "notes"]);
    for (const r of rows) {
      expect(r.slice(6)).toEqual(Array(8).fill(""));
      expect(r[5]).toBe(sample.find((s) => s.id === r[0])!.text);
    }
  });

  it("writes the tool's predictions separately", () => {
    const parsed = parseAuditSheet(parseCsv(predictionSheet(sample, analysis, BRANDS)), BRANDS, true);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
  });
});

describe("parseAuditSheet and compareAudit", () => {
  const csv = (rows: string[][]) =>
    [["response_id", "corvane_mentioned", "corvane_position", "corvane_tone", "trakvia_mentioned", "trakvia_position", "trakvia_tone", "ambiguous", "notes"], ...rows];

  it("refuses incomplete or invalid labels", () => {
    const { problems } = parseAuditSheet(csv([["a", "", "", "", "true", "x", "great", "", ""]]), BRANDS, true);
    expect(problems).toEqual([
      expect.stringContaining("corvane_mentioned is blank"),
      expect.stringContaining("trakvia_position must be a number"),
      expect.stringContaining("trakvia_tone must be one of"),
    ]);
  });

  it("scores mentions, positions and tone, and lists disagreements", () => {
    const human = parseAuditSheet(csv([
      ["a", "true", "1", "recommended", "true", "2", "neutral", "", ""],
      ["b", "false", "", "", "true", "1", "not_recommended", "yes", "unclear verdict"],
    ]), BRANDS, true).rows;
    const tool = parseAuditSheet(csv([
      ["a", "true", "1", "recommended", "true", "2", "negative", "", ""],
      ["b", "true", "1", "neutral", "true", "2", "not_recommended", "", ""],
    ]), BRANDS, true).rows;
    const r = compareAudit(human, tool, BRANDS);
    expect(r.mention).toMatchObject({ agree: 3, total: 4, truePositive: 3, falsePositive: 1, falseNegative: 0 });
    expect(r.mention.precision).toBeCloseTo(0.75);
    expect(r.position).toEqual({ agree: 2, total: 3 });
    expect(r.tone).toMatchObject({ agree: 2, total: 3 });
    expect(r.disagreements.map((d) => `${d.responseId}/${d.brand}/${d.field}`)).toEqual(["a/trakvia/tone", "b/corvane/mentioned", "b/trakvia/position"]);
    expect(compareAudit(human, tool, BRANDS, { excludeAmbiguous: true })).toMatchObject({ answers: 1, mention: { agree: 2, total: 2 } });
  });
});
