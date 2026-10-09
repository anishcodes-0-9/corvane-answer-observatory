import { describe, expect, it } from "vitest";
import { findBrandMatches } from "../src/lib/brandMatch";
import { buildBrandCatalog, parseBrandConfig, parseBrandsJson } from "../src/lib/brands";
import type { BrandCatalog } from "../src/lib/brandTypes";
import { shippedCatalog } from "./helpers/brandFixtures";

const catalog = shippedCatalog();
const find = (text: string, cat: BrandCatalog = catalog) => findBrandMatches(text, cat);
/** [brand, surface, matchType] for each accepted match. */
const summary = (text: string, cat: BrandCatalog = catalog) =>
  find(text, cat).matches.map((m) => [m.brand, m.surface, m.matchType]);

describe("name forms", () => {
  it.each([
    ["Corvane Fleet is a strong pick.", "corvane", "Corvane Fleet", "name"],
    ["Try CorvaneFleet today.", "corvane", "CorvaneFleet", "name"],
    ["CORVANE FLEET leads.", "corvane", "CORVANE FLEET", "name"],
    ["corvane fleet leads.", "corvane", "corvane fleet", "name"],
    ["Corvane offers ELD.", "corvane", "Corvane", "alias"],
    ["Route Lyne is cheap.", "routelyne", "Route Lyne", "name"],
    ["Route-Lyne is cheap.", "routelyne", "Route-Lyne", "name"],
    ["RouteLyne is cheap.", "routelyne", "RouteLyne", "name"],
    ["Gridwell Systems scales.", "gridwell", "Gridwell Systems", "name"],
    ["GridWell scales.", "gridwell", "GridWell", "alias"],
    ["Nova Haul dispatches.", "novahaul", "Nova Haul", "name"],
    ["Trakvia's dashcams.", "trakvia", "Trakvia", "name"],
    ["1. **Novahaul**: scheduling", "novahaul", "Novahaul", "name"],
    ["| Fleetora | Fuel control | Top pick |", "fleetora", "Fleetora", "name"],
  ])("%j → %s", (text, brand, surface, type) => {
    expect(summary(text)).toEqual([[brand, surface, type]]);
  });
});

describe("websites", () => {
  it.each([
    ["Start with trakvia.com.", "trakvia.com"],
    ["See www.trakvia.com for plans", "www.trakvia.com"],
    ["Pricing: https://trakvia.com/pricing.", "https://trakvia.com/pricing"],
    ["(TRAKVIA.COM)", "TRAKVIA.COM"],
  ])("%j matches the website %j", (text, surface) => {
    expect(summary(text)).toEqual([["trakvia", surface, "website"]]);
  });

  it("prefers the website over the name inside it", () => {
    expect(summary("Visit corvanefleet.com now")).toEqual([["corvane", "corvanefleet.com", "website"]]);
  });

  it.each([["notgridwell.io"], ["gridwell.io.example.com"]])("does not treat %j as the brand website", (text) => {
    expect(find(text).matches.filter((m) => m.matchType === "website")).toEqual([]);
  });

  it("counts an email address at the brand's domain as a website mention", () => {
    expect(summary("Email sales@trakvia.com today")).toEqual([["trakvia", "trakvia.com", "website"]]);
  });

  it("does not match a brand name embedded in a longer word of a host", () => {
    expect(find("visit notgridwell.io").matches).toEqual([]);
  });
});

describe("negatives and word boundaries", () => {
  it.each([
    ["Gridwellness programs"],
    ["MegaTrakvia corp"],
    ["Trivia night"],
    ["A Corvette is a car"],
    ["Routine maintenance"],
    ["Gridiron football"],
    ["Fleetwood Mac"],
    ["A Novella"],
    ["Routers and switches"],
    ["Fleet tracking for a fleet of trucks"],
    ["Route\nLyne"], // a line break ends a name
  ])("%j mentions no brand", (text) => {
    expect(find(text).matches).toEqual([]);
  });

  it("does not fuzzy-match lower-case words", () => {
    expect(find("the corvain incident").matches).toEqual([]);
  });

  it("does not join a brand to a word across punctuation", () => {
    expect(summary("Route, Lyne, and Trakvia")).toEqual([["trakvia", "Trakvia", "name"]]);
  });
});

describe("misspellings (fuzzy)", () => {
  it.each([
    ["Corvain Fleet is good", "Corvain Fleet", "corvane", 2],
    ["Corvain is good", "Corvain", "corvane", 2],
    ["Trackvia is good", "Trackvia", "trakvia", 1],
    ["Routeline is good", "Routeline", "routelyne", 1],
    ["Gridwel is good", "Gridwel", "gridwell", 1],
    ["Novahual is good", "Novahual", "novahaul", 1],
  ])("%j → fuzzy %s (%s, distance %i)", (text, surface, brand, distance) => {
    const [m] = find(text).matches;
    expect(m).toMatchObject({ brand, surface, matchType: "fuzzy", distance });
    expect(find(text).matches).toHaveLength(1);
  });

  it.each([["Gridwel is good", "Gridwel"], ["Gridwe is good", "Gridwe"], ["Trackvia offers dashcams", "Trackvia"]])(
    "does not swallow the next word into a one-word name's misspelling (%j)",
    (text, surface) => {
      expect(find(text).matches.map((m) => m.surface)).toEqual([surface]);
    },
  );

  it("prefers the closer spelling when two fuzzy spans start at the same word", () => {
    // "Corvan" is distance 1 from "Corvane"; "Corvan Flet" is distance 2 from "Corvane Fleet".
    expect(find("Corvan Flet works").matches).toEqual([
      expect.objectContaining({ brand: "corvane", surface: "Corvan", matchType: "fuzzy", distance: 1 }),
    ]);
  });

  it("never lets a fuzzy span that starts earlier hide an exact mention inside it", () => {
    const cfg = parseBrandConfig({
      brands: [
        { id: "orion", website: "orionhub.com" },
        { id: "hub", website: "hub.io" },
      ],
    }).config!;
    const entries = parseBrandsJson({
      client: { name: "Orion Hub", website: "orionhub.com" },
      other_companies: [{ name: "Hub", website: "hub.io" }],
    }).entries;
    const cat = buildBrandCatalog(entries, cfg).catalog!;
    // "Orian Hub" is a fuzzy Orion Hub, but "Hub" is an exact brand: exact evidence wins.
    expect(summary("Try Orian Hub today", cat)).toEqual([["hub", "Hub", "name"]]);
  });

  it("prefers an exact alias over a longer fuzzy span starting at the same word", () => {
    expect(summary("Gridwell System works")).toEqual([["gridwell", "Gridwell", "alias"]]);
  });

  it.each([["A Corvina grape"], ["Corvina is a fish"], ["CORVINA wine"], ["Trivia and a Novella"]])(
    "rejects a real dictionary word as a misspelling (%j)",
    (text) => {
      expect(find(text).matches).toEqual([]);
    },
  );

  it("accepts a real-word typo when the rest of the multi-word name follows exactly", () => {
    expect(find("Corvina Fleet is a strong pick").matches).toEqual([
      expect.objectContaining({ brand: "corvane", surface: "Corvina Fleet", matchType: "fuzzy", distance: 2 }),
    ]);
  });

  it("still detects non-word typos of the same distance", () => {
    expect(find("Corvain is a strong pick").matches).toEqual([
      expect.objectContaining({ brand: "corvane", surface: "Corvain", matchType: "fuzzy", distance: 2 }),
    ]);
  });

  it("can turn the dictionary rule off, which restores the false positive", () => {
    const noDict: BrandCatalog = { ...catalog, wordList: null };
    expect(find("A Corvina grape", noDict).matches).toEqual([expect.objectContaining({ brand: "corvane", matchType: "fuzzy" })]);
  });

  it("can be switched off in config", () => {
    const off: BrandCatalog = { ...catalog, fuzzy: { ...catalog.fuzzy, enabled: false } };
    expect(find("Corvain Fleet", off).matches).toEqual([]);
  });

  it("records a fuzzy span equally close to two brands as ambiguous, not a mention", () => {
    const cfg = parseBrandConfig({
      brands: [
        { id: "alpha", website: "alphanet.com" },
        { id: "beta", website: "alphanex.com" },
      ],
    }).config!;
    const entries = parseBrandsJson({
      client: { name: "Alphanet", website: "alphanet.com" },
      other_companies: [{ name: "Alphanex", website: "alphanex.com" }],
    }).entries;
    const cat = buildBrandCatalog(entries, cfg).catalog!;
    const result = find("Try Alphanez now", cat);
    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual([{ start: 4, end: 12, surface: "Alphanez", brands: ["alpha", "beta"], distance: 1 }]);
  });
});

describe("decoys (Corvane Logistics)", () => {
  it("never counts Corvane Logistics as Corvane", () => {
    const r = find("Corvane Logistics moves pallets between depots. Its drivers are friendly.");
    expect(r.matches).toEqual([]);
    expect(r.decoys).toEqual([{ decoy: "corvane_logistics", brand: "corvane", start: 0, end: 17, surface: "Corvane Logistics" }]);
  });

  it("keeps a real Corvane mention alongside the decoy", () => {
    const text = "Corvane Fleet is great; it is unrelated to Corvane Logistics, the haulage firm.";
    expect(summary(text)).toEqual([["corvane", "Corvane Fleet", "name"]]);
    expect(find(text).decoys.map((d) => d.surface)).toEqual(["Corvane Logistics"]);
  });

  it.each([["Corvain Logistics ships freight"], ["CorvaneLogistics ships freight"], ["CORVANE LOGISTICS ships freight"], ["Corvane-Logistics ships"]])(
    "treats %j as the decoy",
    (text) => {
      const r = find(text);
      expect(r.matches).toEqual([]);
      expect(r.decoys).toHaveLength(1);
    },
  );

  it.each([
    ["Corvane Logistic handles freight"],
    ["Corvane logistic handles freight"],
    ["CorvaneLogistic handles freight"],
    ["Corvane Logistics' dispatchers"],
    ["Corvane Logistics's dispatchers"],
    ["Corvane Logistics-style brokerage"],
    ["Corvain Logistic handles freight"],
  ])("treats the singular/possessive/adjacent variant %j as the decoy", (text) => {
    const r = find(text);
    expect(r.matches).toEqual([]);
    expect(r.decoys).toHaveLength(1);
  });

  it.each([
    ["Corvane Fleet Logistics module", "Corvane Fleet"], // the full client name is never the decoy
    ["Corvane Logisticsware platform", "Corvane"], // a different word, not the qualifier
    ["Corvane / Logistics", "Corvane"], // punctuation ends the name
    ["Corvane (not Corvane Logistics) wins", "Corvane"],
  ])("keeps a genuine Corvane mention in %j", (text, surface) => {
    expect(find(text).matches.map((m) => [m.brand, m.surface])).toEqual([["corvane", surface]]);
  });

  it("is not triggered when punctuation separates the qualifier", () => {
    expect(summary("We chose Corvane, logistics aside.")).toEqual([["corvane", "Corvane", "alias"]]);
  });
});

describe("overlaps and repeats", () => {
  it("reports Corvane Fleet once, not as name plus alias", () => {
    expect(summary("Corvane Fleet")).toEqual([["corvane", "Corvane Fleet", "name"]]);
  });

  it("finds adjacent different brands separately", () => {
    expect(summary("Trakvia Routelyne")).toEqual([
      ["trakvia", "Trakvia", "name"],
      ["routelyne", "Routelyne", "name"],
    ]);
  });

  it("returns every mention in text order", () => {
    expect(summary("Novahaul, then Trakvia, then Novahaul again").map(([b]) => b)).toEqual(["novahaul", "trakvia", "novahaul"]);
  });
});

describe("Unicode and offsets", () => {
  it("matches accented, non-breaking-space and zero-width variants with offsets into the original text", () => {
    const text = "Ask about Corvané Fleet or Grid​well or Corvané today";
    const r = find(text);
    expect(r.matches.map((m) => [m.brand, m.surface, m.matchType])).toEqual([
      ["corvane", "Corvané Fleet", "name"],
      ["gridwell", "Grid​well", "alias"],
      ["corvane", "Corvané", "alias"],
    ]);
    for (const m of r.matches) expect(text.slice(m.start, m.end)).toBe(m.surface);
  });
});
