import { describe, expect, it } from "vitest";
import { findBrandMatches } from "../src/lib/brandMatch";
import { classifyTones, sentenceVerdict } from "../src/lib/tone";
import { shippedCatalog } from "./helpers/brandFixtures";

const catalog = shippedCatalog();
const tones = (text: string) =>
  Object.fromEntries([...classifyTones(text, findBrandMatches(text, catalog).matches)].map(([b, t]) => [b, t.tone]));

describe("the brief's own examples", () => {
  it.each([
    ["For small fleets, Corvane is a strong pick.", { corvane: "recommended" }],
    ["Other options include Corvane and Fleetora.", { corvane: "neutral", fleetora: "neutral" }],
    ["Routelyne is cheap, but users report slow support.", { routelyne: "negative" }],
    ["Avoid Gridwell if you run fewer than 100 vehicles.", { gridwell: "not_recommended" }],
  ])("%j", (text, expected) => {
    expect(tones(text)).toEqual(expected);
  });
});

describe("mixed answers use the final verdict", () => {
  it.each([
    ["Trakvia gets plenty of praise, but buyers mention outages, so proceed with caution.", "trakvia", "negative"],
    ["Novahaul draws some invoice complaints, but overall it is one of the better options for field crews.", "novahaul", "recommended"],
    ["Fleetora can feel expensive. Even so, for a small team it's the one I'd pick.", "fleetora", "recommended"],
    ["Gridwell looks slick. That said, for a dozen vans I'd skip it.", "gridwell", "not_recommended"],
    ["Routelyne demos nicely, but for a tiny depot it isn't the right fit.", "routelyne", "not_recommended"],
    ["Plenty of buyers like Trakvia's cameras, although renewals have drawn complaints.", "trakvia", "negative"],
    ["Corvane is a strong pick. Later in this answer: Corvane does the job, though its app feels clunky.", "corvane", "negative"],
  ])("%j → %s %s", (text, brand, tone) => {
    expect(tones(text)[brand]).toBe(tone);
  });

  it("lets a later bottom line override an earlier neutral or negative mention", () => {
    const text = "Trakvia's reports are limited compared with rivals.\n\nFinal answer: I'd start with Trakvia.";
    expect(tones(text)).toEqual({ trakvia: "recommended" });
  });
});

describe("tables and lists", () => {
  it("reads the verdict column of a markdown table row", () => {
    const text = [
      "| Vendor | Ideal for | Verdict |",
      "|---|---|---|",
      "| Corvane Fleet | Small fleets | Top pick |",
      "| Trakvia | Video safety | Worth comparing |",
      "| Routelyne | Tight budgets | Some complaints |",
      "| Gridwell Systems | Large enterprises | Not for small teams |",
    ].join("\n");
    expect(tones(text)).toEqual({ corvane: "recommended", trakvia: "neutral", routelyne: "negative", gridwell: "not_recommended" });
  });

  it("keeps each bullet's verdict with its own brand", () => {
    const text = "- Trakvia is the best overall option here.\n- Novahaul offers job scheduling.\n- I wouldn't choose Gridwell Systems for a two-van business.";
    expect(tones(text)).toEqual({ trakvia: "recommended", novahaul: "neutral", gridwell: "not_recommended" });
  });

  it.each([
    ["1. **Trakvia**: Avoid TrakVia for tiny fleets.", "trakvia"],
    ["- **If budget matters:** Avoid Gridwell Systems for small teams.", "gridwell"],
  ])("reads 'Avoid' after a list label: %j", (text, brand) => {
    expect(tones(text)[brand]).toBe("not_recommended");
  });

  it("does not carry a verdict across lines to the previous line's brand", () => {
    expect(tones("Corvane offers ELD compliance.\nMost guides recommend a short trial; I'd pick two providers.")).toEqual({ corvane: "neutral" });
  });
});

describe("does not overreach", () => {
  it.each([
    ["Corvane helps you avoid fines.", "corvane", "neutral"],
    ["With Trakvia you can start with one truck.", "trakvia", "neutral"],
    ["Gridwell Systems focuses on driver safety for big operations.", "gridwell", "neutral"],
    ["Routelyne is often recommended.", "routelyne", "neutral"],
  ])("%j → %s %s", (text, brand, tone) => {
    expect(tones(text)[brand]).toBe(tone);
  });

  it("returns no verdict for neutral sentences", () => {
    expect(sentenceVerdict("Fleetora also operates in this space, with fuel management.")).toBeNull();
  });
});
