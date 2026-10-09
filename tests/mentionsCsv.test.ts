import { describe, expect, it } from "vitest";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { parseResponseFiles } from "../src/lib/load";
import { buildMentionRows, mentionsCsv, validateMentionRows } from "../src/lib/mentionsCsv";
import { shippedCatalog } from "./helpers/brandFixtures";

const catalog = shippedCatalog();
const brandIds = catalog.brands.map((b) => b.id);
const record = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  response_id: id, week: 1, engine: "chatgpt", prompt_id: "P01", run: 1, response_text: text, citations: ["https://fleetora.com"], ...extra,
});
const responses = parseResponseFiles([
  {
    name: "responses.jsonl",
    content: [
      record("r_a", "Trakvia is a strong pick. Avoid Gridwell if you run fewer than 100 vehicles. Other options include Corvane."),
      record("r_b", "", { error: "timeout", citations: null }),
      record("r_c", "Fleet tracking pays for itself."),
      record("r_a", "Trakvia is a strong pick. Avoid Gridwell if you run fewer than 100 vehicles. Other options include Corvane."),
    ].map((r) => JSON.stringify(r)).join("\n"),
  },
]).responses;
const rows = buildMentionRows(analyzeResponses(responses, catalog).responses, brandIds);

describe("mentions.csv", () => {
  it("has the exact header and six rows per unique response, in brief brand order", () => {
    const csv = mentionsCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("response_id,brand,mentioned,position,tone");
    expect(lines).toHaveLength(1 + 3 * 6);
    expect(lines.slice(1, 7)).toEqual([
      "r_a,corvane,true,3,neutral",
      "r_a,trakvia,true,1,recommended",
      "r_a,routelyne,false,,",
      "r_a,gridwell,true,2,not_recommended",
      "r_a,fleetora,false,,", // only in citations
      "r_a,novahaul,false,,",
    ]);
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("exports a timeout as six mentioned=false rows with blank position and tone", () => {
    expect(mentionsCsv(rows).split("\n").filter((l) => l.startsWith("r_b,"))).toEqual(brandIds.map((b) => `r_b,${b},false,,`));
  });

  it("passes schema validation, and validation catches each kind of violation", () => {
    const ids = responses.map((r) => r.id);
    expect(validateMentionRows(rows, ids, brandIds)).toEqual([]);
    expect(validateMentionRows(rows.slice(1), ids, brandIds).length).toBeGreaterThan(0);
    const badTone = rows.map((r, i) => (i === 0 ? { ...r, tone: null } : r));
    expect(validateMentionRows(badTone, ids, brandIds)).toEqual([expect.stringContaining("one of the four tones")]);
    const strayPosition = rows.map((r, i) => (i === 2 ? { ...r, position: 4 } : r));
    expect(validateMentionRows(strayPosition, ids, brandIds)).toEqual([expect.stringContaining("must be blank")]);
    const gap = rows.map((r, i) => (i === 0 ? { ...r, position: 5 } : r));
    expect(validateMentionRows(gap, ids, brandIds)).toEqual([expect.stringContaining("not 1..n")]);
  });
});
