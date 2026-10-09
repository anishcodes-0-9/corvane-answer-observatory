/**
 * Checks the implementation against the hand-labelled cases in
 * validation/brand-labels.json (expected labels, not another implementation).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeResponse } from "../src/lib/brandAnalysis";
import { parseResponseFiles } from "../src/lib/load";
import { shippedCatalog } from "./helpers/brandFixtures";

interface LabelCase {
  id: string;
  tags: string[];
  text: string;
  citations?: string[];
  mentions: Array<[string, string[]]>;
  decoys?: string[];
}
interface Unresolved {
  id: string;
  text: string;
  currentBehaviour: string;
}
const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../validation/brand-labels.json", import.meta.url)), "utf8")) as {
  cases: LabelCase[];
  unresolved: Unresolved[];
};
const catalog = shippedCatalog();

function run(text: string, citations: string[] = []) {
  const record = { response_id: "r", week: 1, engine: "chatgpt", prompt_id: "P01", run: 1, response_text: text, citations };
  const [response] = parseResponseFiles([{ name: "labels.jsonl", content: `${JSON.stringify(record)}\n` }]).responses;
  const analysis = analyzeResponse(response!, catalog);
  if (analysis.status !== "analyzed") throw new Error("label case was not analysed");
  return { response: response!, analysis };
}

describe("hand-labelled brand cases", () => {
  it("has unique IDs and covers every required category", () => {
    const ids = labels.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set(labels.cases.flatMap((c) => c.tags));
    for (const t of ["name", "alias", "website", "misspelling", "false-positive", "decoy", "overlap", "citations", "unicode", "offsets", "position", "boundary"]) {
      expect(tags, `missing category ${t}`).toContain(t);
    }
  });

  it.each(labels.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { response, analysis } = run(c.text, c.citations);
    const actual = analysis.brands
      .filter((b) => b.mentioned)
      .sort((a, b) => a.position! - b.position!)
      .map((b) => [b.brand, b.matches.map((m) => m.surface)]);
    expect(actual).toEqual(c.mentions);
    expect(analysis.decoys.map((d) => d.surface)).toEqual(c.decoys ?? []);
    // Offsets point at the exact source text, even where normalisation changes length.
    for (const b of analysis.brands) for (const m of b.matches) expect(response.text.slice(m.start, m.end)).toBe(m.surface);
    for (const d of analysis.decoys) expect(response.text.slice(d.start, d.end)).toBe(d.surface);
  });
});

describe("unresolved cases (current behaviour pinned until the contract decides)", () => {
  const behaviour = (text: string) => {
    const { analysis } = run(text);
    const matches = analysis.brands.flatMap((b) => b.matches);
    if (analysis.decoys.length > 0 && matches.length === 0) return "decoy (no mention)";
    if (matches.length === 0) return "no match";
    return matches.map((m) => (m.matchType === "fuzzy" ? `fuzzy match (distance ${m.distance})` : m.matchType)).join(", ");
  };
  it.each(labels.unresolved.map((u) => [u.id, u] as const))("%s", (_id, u) => {
    expect(behaviour(u.text)).toBe(u.currentBehaviour);
  });
});
