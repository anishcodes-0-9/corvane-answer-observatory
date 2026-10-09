import { describe, expect, it } from "vitest";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { findBrandMatches } from "../src/lib/brandMatch";
import { findWrongFacts, parseFacts } from "../src/lib/facts";
import { parseResponseFiles } from "../src/lib/load";
import { sortWrongFacts, validateWrongFacts, wrongFactsCsv } from "../src/lib/wrongFactsCsv";
import { shippedCatalog } from "./helpers/brandFixtures";

// Synthetic facts with the same shape as the data pack's facts.json.
const FACTS_JSON = {
  _note: "test fixture",
  corvane: {
    starting_price_usd: 29,
    price_unit: "per vehicle per month",
    hq: "Columbus, Ohio",
    founded: 2014,
    features: { gps_tracking: true, eld_compliance: true, fuel_card_integration: true, maintenance_alerts: true, driver_app: true, dashcams: false, payroll: false },
    integrations: ["QuickBooks", "WEX", "Comdata"],
  },
  trakvia: { starting_price_usd: 39, hq: "Austin, Texas", founded: 2016, features: { dashcams: true }, integrations: ["Salesforce"] },
};
const { facts } = parseFacts(FACTS_JSON);
const catalog = shippedCatalog();

/** fact_key list for claims about Corvane in `text`. */
const wrong = (text: string, brands = ["corvane"]) => {
  const m = findBrandMatches(text, catalog);
  return findWrongFacts("r", text, m.matches, m.decoys, facts, brands).map((w) => w.factKey);
};

describe("parseFacts", () => {
  it("reads the facts.json shape and skips comment keys", () => {
    const f = facts.get("corvane")!;
    expect(f).toMatchObject({ startingPriceUsd: 29, hq: { city: "Columbus", state: "Ohio" }, founded: 2014, integrations: ["QuickBooks", "WEX", "Comdata"] });
    expect(f.features.dashcams).toBe(false);
    expect([...facts.keys()]).toEqual(["corvane", "trakvia"]);
    expect(parseFacts([]).issues).toEqual(["facts.json must be a JSON object"]);
  });
});

describe("hq", () => {
  it.each([
    ["Corvane Fleet is solid. It is based in Columbus, Georgia.", ["hq"]],
    ["Corvane Fleet is headquartered in Chicago.", ["hq"]],
    ["Corvane is based in Texas.", ["hq"]],
    ["Corvane is based in Columbus, GA.", ["hq"]],
    ["Corvane Fleet is solid. It is based in Columbus, Ohio, and it has been around since 2014.", []],
    ["Corvane is based in Columbus, OH.", []],
    ["Corvane is based in Columbus.", []],
    ["Corvane is based in Ohio.", []],
    ["Corvane is based in the Midwest.", []], // too vague to contradict
  ])("%j → %j", (text, expected) => {
    expect(wrong(text)).toEqual(expected);
  });
});

describe("founded", () => {
  it.each([
    ["Corvane Fleet was founded in 2009.", ["founded"]],
    ["Corvane was established in 2011.", ["founded"]],
    ["Corvane has been around since 2016.", ["founded"]],
    ["Corvane was founded in 2014.", []],
    ["Corvane has been around since 2014.", []],
    ["Corvane has served fleets since 2009.", []], // not a founding claim
  ])("%j → %j", (text, expected) => {
    expect(wrong(text)).toEqual(expected);
  });
});

describe("starting_price_usd", () => {
  it.each([
    ["Corvane: pricing starts at around $45 per vehicle per month.", ["starting_price_usd"]],
    ["Corvane Fleet is good. Buyers should expect to pay from $49 per vehicle per month.", ["starting_price_usd"]],
    ["Corvane plans start at $19 per vehicle.", ["starting_price_usd"]],
    ["Corvane: pricing starts at $29 per vehicle per month.", []],
    ["Corvane: pricing starts at about $30 per vehicle per month.", []], // approximate and within tolerance
    ["Corvane costs between $25 and $40 per vehicle per month.", []], // a range is not a starting price
    ["Corvane plans start at $300 per year.", []], // different unit: unverified
    ["Fleet GPS tracking usually costs from $15 per vehicle. Corvane is popular.", []], // generic price, not Corvane's
  ])("%j → %j", (text, expected) => {
    expect(wrong(text)).toEqual(expected);
  });
});

describe("features", () => {
  it.each([
    ["Corvane is fine. Be aware it doesn't support ELD compliance, so plan for another product.", ["features.eld_compliance"]],
    ["Corvane Fleet is fine. It now includes built-in video dashcams.", ["features.dashcams"]],
    ["Corvane offers payroll for drivers.", ["features.payroll"]],
    ["Corvane has no driver app.", ["features.driver_app"]],
    ["Corvane is fine. ELD compliance is included in every plan.", []],
    ["Corvane offers ELD compliance and straightforward GPS tracking.", []],
    ["Corvane has no dashcams.", []], // true negative claim
    ["For carriers that need ELD compliance, Corvane is the safest choice.", []], // audience, not a claim
    ["Corvane has a 4.6-star average and phone support around the clock.", []], // not covered by facts.json
  ])("%j → %j", (text, expected) => {
    expect(wrong(text)).toEqual(expected);
  });
});

describe("integrations", () => {
  it.each([
    ["Corvane is fine. It does not integrate with QuickBooks yet.", ["integrations"]],
    ["Corvane integrates with QuickBooks and WEX fuel cards.", []],
    ["Corvane integrates with Salesforce.", []], // facts.json lists known integrations; an unlisted one is unverified
  ])("%j → %j", (text, expected) => {
    expect(wrong(text)).toEqual(expected);
  });
});

describe("attribution", () => {
  it("attributes a follow-up sentence to the brand named before it on the same line", () => {
    expect(wrong("Trakvia is solid. It was founded in 2009. Corvane Fleet is good.")).toEqual([]);
    expect(wrong("Trakvia is solid. It was founded in 2009.", ["corvane", "trakvia"])).toEqual(["founded"]);
  });

  it("never attributes a decoy's details to Corvane", () => {
    expect(wrong("Corvane Fleet is good.\nIt is unrelated to Corvane Logistics, a haulage firm based in Texas.")).toEqual([]);
    expect(wrong("Corvane Fleet is good. Unrelated: Corvane Logistics. It was founded in 1990.")).toEqual([]);
  });

  it("does not attribute a claim in a sentence that names two companies", () => {
    expect(wrong("Corvane and Trakvia were both founded in 2009.")).toEqual([]);
  });

  it("does not carry a claim across lines", () => {
    expect(wrong("Corvane Fleet is good.\nIt was founded in 2009.")).toEqual([]);
  });
});

describe("wrong_facts.csv", () => {
  const record = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    response_id: id, week: 1, engine: "chatgpt", prompt_id: "P01", run: 1, response_text: text, ...extra,
  });
  const responses = parseResponseFiles([
    {
      name: "responses.jsonl",
      content: [
        record("r_1", 'Corvane Fleet is solid. It is based in Columbus, Georgia. It was founded in 2009, "per reviews".'),
        record("r_2", "", { error: "timeout" }),
        record("r_3", "Corvane Fleet is solid. It's based in Columbus, Ohio."),
        record("r_1", 'Corvane Fleet is solid. It is based in Columbus, Georgia. It was founded in 2009, "per reviews".'),
      ].map((r) => JSON.stringify(r)).join("\n"),
    },
  ]).responses;
  const analysis = analyzeResponses(responses, catalog);
  const build = () =>
    sortWrongFacts(
      responses
        .filter((r) => r.status === "ok")
        .flatMap((r) => {
          const a = analysis.responses.find((x) => x.responseId === r.id)!;
          return a.status === "analyzed" ? findWrongFacts(r.id, r.text, a.brands.flatMap((b) => b.matches), a.decoys, facts, ["corvane"]) : [];
        }),
      responses.map((r) => r.id),
    );

  it("has the exact header, quotes claims when needed, and skips timeouts and correct answers", () => {
    const csv = wrongFactsCsv(build());
    expect(csv).toBe(
      'response_id,brand,fact_key,claim_text\n' +
        "r_1,corvane,hq,It is based in Columbus, Georgia.\n".replace("It is based in Columbus, Georgia.", '"It is based in Columbus, Georgia."') +
        'r_1,corvane,founded,"It was founded in 2009, ""per reviews""."\n',
    );
  });

  it("passes validation, is deterministic, and validation catches bad rows", () => {
    const rows = build();
    const text = new Map(responses.filter((r) => r.status === "ok").map((r) => [r.id, r.text]));
    expect(validateWrongFacts(rows, text, facts, ["corvane"])).toEqual([]);
    expect(wrongFactsCsv(build())).toBe(wrongFactsCsv(rows));
    expect(validateWrongFacts([...rows, rows[0]!], text, facts, ["corvane"])).toEqual([expect.stringContaining("duplicate row")]);
    expect(validateWrongFacts([{ ...rows[0]!, factKey: "features.teleport" }], text, facts, ["corvane"])).toEqual([
      expect.stringContaining("not an entry in facts.json"),
    ]);
    expect(validateWrongFacts([{ ...rows[0]!, responseId: "r_2" }], text, facts, ["corvane"])).toEqual([
      expect.stringContaining("not analysed"),
    ]);
    expect(validateWrongFacts([{ ...rows[0]!, brand: "trakvia" }], text, facts, ["corvane"])).toEqual([
      expect.stringContaining("brand is outside"),
    ]);
  });
});
