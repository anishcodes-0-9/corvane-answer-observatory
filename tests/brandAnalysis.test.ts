import { describe, expect, it } from "vitest";
import { analyzeResponse, analyzeResponses } from "../src/lib/brandAnalysis";
import type { ResponseBrandAnalysis } from "../src/lib/brandTypes";
import { parseResponseFiles } from "../src/lib/load";
import { shippedCatalog } from "./helpers/brandFixtures";

const catalog = shippedCatalog();
const record = (overrides: Record<string, unknown> = {}) => ({
  response_id: "r_1",
  week: 1,
  engine: "chatgpt",
  prompt_id: "P01",
  run: 1,
  collected_at: "2026-08-18T14:18:00Z",
  response_text: "Nothing here.",
  citations: [],
  ...overrides,
});
const load = (...records: Record<string, unknown>[]) =>
  parseResponseFiles([{ name: "responses.jsonl", content: records.map((r) => JSON.stringify(r)).join("\n") + "\n" }]).responses;
const analyzed = (r: ResponseBrandAnalysis) => {
  if (r.status !== "analyzed") throw new Error(`expected analyzed, got ${r.status}`);
  return r;
};
const positions = (text: string) =>
  Object.fromEntries(
    analyzed(analyzeResponse(load(record({ response_text: text }))[0]!, catalog))
      .brands.filter((b) => b.mentioned)
      .map((b) => [b.brand, b.position]),
  );

describe("positions", () => {
  it("numbers brands by their first mention, ignoring repeats", () => {
    expect(positions("Trakvia is good. Corvane Fleet is better. Trakvia again. Then Novahaul.")).toEqual({
      trakvia: 1,
      corvane: 2,
      novahaul: 3,
    });
  });

  it("uses text order across a markdown table and the prose after it", () => {
    const text = "| Provider | Best for |\n|---|---|\n| Routelyne | Tight budgets |\n| Gridwell Systems | Large |\n\nI'd pick gridwell.io or Fleetora.";
    expect(positions(text)).toEqual({ routelyne: 1, gridwell: 2, fleetora: 3 });
  });

  it("gives a decoy no position", () => {
    expect(positions("Corvane Logistics ships freight. Trakvia tracks it.")).toEqual({ trakvia: 1 });
  });

  it("returns one result per brand in catalog order, with null positions for absent brands", () => {
    const r = analyzed(analyzeResponse(load(record({ response_text: "Fleetora only." }))[0]!, catalog));
    expect(r.brands.map((b) => [b.brand, b.mentioned, b.position])).toEqual([
      ["corvane", false, null],
      ["trakvia", false, null],
      ["routelyne", false, null],
      ["gridwell", false, null],
      ["fleetora", true, 1],
      ["novahaul", false, null],
    ]);
  });
});

describe("what is scanned", () => {
  it("ignores brands that appear only in citations", () => {
    const [r] = load(
      record({
        response_text: "Fleet tracking costs vary.",
        citations: ["https://corvanefleet.com/pricing", "https://www.trakvia.com/blog"],
      }),
    );
    expect(analyzed(analyzeResponse(r!, catalog)).brands.every((b) => !b.mentioned)).toBe(true);
  });

  it("scans entity-decoded text and reports offsets into it", () => {
    const [r] = load(record({ response_text: "Price &amp; features: Novahaul." }));
    const match = analyzed(analyzeResponse(r!, catalog)).brands.find((b) => b.brand === "novahaul")!.matches[0]!;
    expect(r!.text.slice(match.start, match.end)).toBe("Novahaul");
    expect(match.start).toBe(r!.text.indexOf("Novahaul"));
  });
});

describe("error, timeout and empty responses", () => {
  it("marks them not analysed with no brand results, never as 'not mentioned'", () => {
    const responses = load(
      record({ response_id: "r_timeout", response_text: "", citations: null, error: "timeout" }),
      record({ response_id: "r_error_text", response_text: "Corvane Fleet", error: "rate_limited" }),
      record({ response_id: "r_empty", response_text: "   " }),
    );
    const results = responses.map((r) => analyzeResponse(r, catalog));
    expect(results.map((r) => [r.responseId, r.status, "reason" in r ? r.reason : null, "error" in r ? r.error : null])).toEqual([
      ["r_timeout", "not_analyzed", "error", "timeout"],
      ["r_error_text", "not_analyzed", "error", "rate_limited"],
      ["r_empty", "not_analyzed", "empty", null],
    ]);
    for (const r of results) expect(r).not.toHaveProperty("brands");
  });
});

describe("duplicates and provenance", () => {
  it("analyses a response once even when the input repeats it", () => {
    const dup = record({ response_text: "Trakvia." });
    const result = analyzeResponses(load(dup, dup, record({ response_id: "r_2", run: 2, response_text: "Routelyne." })), catalog);
    expect(result.responses.map((r) => r.responseId)).toEqual(["r_1", "r_2"]);
    expect(result.summary.responses).toBe(2);
  });

  it("carries enough provenance to trace each result to its source record", () => {
    const [r] = load(record({ engine: "AI Overview", prompt_id: "p07", run: 2, week: 4, response_text: "Gridwell." }));
    expect(analyzeResponse(r!, catalog)).toMatchObject({
      responseId: "r_1",
      week: 4,
      engine: "google_ai_overview",
      promptId: "P07",
      run: 2,
      source: { file: "responses.jsonl", recordIndex: 0, line: 1 },
    });
  });
});

describe("summary and determinism", () => {
  const responses = load(
    record({ response_id: "a", response_text: "Corvane Fleet and corvanefleet.com and Corvain." }),
    record({ response_id: "b", run: 2, response_text: "Unrelated note: Corvane Logistics moves freight." }),
    record({ response_id: "c", prompt_id: "P02", response_text: "", error: "timeout" }),
  );

  it("counts analysed responses, mentions and match types", () => {
    const { summary } = analyzeResponses(responses, catalog);
    expect(summary).toMatchObject({ responses: 3, analyzed: 2, notAnalyzed: { error: 1, empty: 0 }, decoyResponses: 1, fuzzyMatches: 1 });
    expect(summary.byBrand.find((b) => b.brand === "corvane")).toEqual({
      brand: "corvane",
      tier: "client",
      responsesMentioning: 1,
      matches: { website: 1, name: 1, alias: 0, fuzzy: 1 },
    });
  });

  it("produces byte-identical output for identical input", () => {
    const a = JSON.stringify(analyzeResponses(responses, shippedCatalog()));
    const b = JSON.stringify(analyzeResponses(load(...[
      record({ response_id: "a", response_text: "Corvane Fleet and corvanefleet.com and Corvain." }),
      record({ response_id: "b", run: 2, response_text: "Unrelated note: Corvane Logistics moves freight." }),
      record({ response_id: "c", prompt_id: "P02", response_text: "", error: "timeout" }),
    ]), shippedCatalog()));
    expect(b).toBe(a);
  });
});
