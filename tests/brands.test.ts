import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrandCatalog, DEFAULT_FUZZY, loadBrandCatalog, normalizeWebsite, parseBrandConfig, parseBrandsJson } from "../src/lib/brands";
import { BRANDS_JSON, SHIPPED_CONFIG_PATH, shippedCatalog, shippedConfig } from "./helpers/brandFixtures";

type Config = NonNullable<ReturnType<typeof parseBrandConfig>["config"]>;
const config = (overrides: Record<string, unknown> = {}): Config => {
  const parsed = parseBrandConfig({ ...(shippedConfig() as object), ...overrides });
  if (!parsed.config) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config;
};
const errorsOf = (issues: { severity: string; message: string }[]) => issues.filter((i) => i.severity === "error").map((i) => i.message);

describe("shipped brand configuration", () => {
  it("builds the six brief brands in mentions.csv order with their tiers and forms", () => {
    const catalog = shippedCatalog();
    expect(catalog.brands.map((b) => [b.id, b.tier, b.forms.map((f) => `${f.kind}:${f.label}`)])).toEqual([
      ["corvane", "client", ["name:Corvane Fleet", "alias:Corvane"]],
      ["trakvia", "tracked_competitors", ["name:Trakvia"]],
      ["routelyne", "tracked_competitors", ["name:Routelyne"]],
      ["gridwell", "tracked_competitors", ["name:Gridwell Systems", "alias:Gridwell"]],
      ["fleetora", "other_companies", ["name:Fleetora"]],
      ["novahaul", "other_companies", ["name:Novahaul"]],
    ]);
    expect(catalog.decoys).toEqual([
      { id: "corvane_logistics", name: "Corvane Logistics", brand: "corvane", qualifiers: [["logistics"]], head: "corvane", compact: "corvanelogistics" },
    ]);
    expect(catalog.fuzzy).toEqual(DEFAULT_FUZZY);
    expect(catalog.wordList!.source).toMatch(/^word-list@4\.1\.0 \(sha256 [0-9a-f]{12}\)$/);
    expect(catalog.wordList!.size).toBeGreaterThan(200_000);
  });
});

describe("brands.json validation", () => {
  it.each([
    [[], "must be a JSON object"],
    [{ tracked_competitors: [] }, 'missing "client"'],
    [{ client: { name: "A" } }, 'non-empty "name" and "website"'],
    [{ client: { name: "A", website: "not a domain" } }, "invalid website"],
    [{ client: { name: "A", website: "a.com" }, tracked_competitors: { name: "B" } }, "must be a list"],
    [{ client: { name: "A", website: "a.com" }, other_companies: [{ name: "B", website: "https://www.A.com/" }] }, "appears more than once"],
  ])("rejects malformed brands.json %#", (value, message) => {
    expect(errorsOf(parseBrandsJson(value).issues)).toEqual([expect.stringContaining(message)]);
  });

  it("normalises websites", () => {
    expect(normalizeWebsite("HTTPS://www.Gridwell.io/")).toBe("gridwell.io");
    expect(normalizeWebsite("gridwell")).toBeNull();
  });
});

describe("brand config validation", () => {
  it.each([
    [{ brands: [] }, '"brands" must be a non-empty list'],
    [{ brands: [{ id: "Corvane", website: "corvanefleet.com" }] }, "lower-case slug"],
    [{ brands: [{ id: "corvane", website: "corvane fleet" }] }, "plain domain"],
    [{ brands: [{ id: "corvane", website: "corvanefleet.com", aliases: ["Corvane", 7] }] }, "aliases must be a list"],
    [{ decoys: [{ id: "x", name: "Corvane Logistics", brand: "corvane", qualifiers: [] }] }, "qualifiers must be a non-empty list"],
    [{ decoys: {} }, '"decoys" must be a list'],
    [{ fuzzy: { maxDistanceLong: 4 } }, "above 3"],
    [{ fuzzy: { minKeyLength: -1 } }, "non-negative integers"],
    [{ fuzzy: { enabled: "yes" } }, "true or false"],
    [{ fuzzy: { rejectDictionaryWords: 1 } }, "true or false"],
    [{ fuzzy: { minKeyLength: 2 } }, "must exceed the largest edit distance"],
  ])("rejects malformed config %#", (overrides, message) => {
    const parsed = parseBrandConfig({ ...(shippedConfig() as object), ...overrides });
    expect(parsed.config).toBeNull();
    expect(errorsOf(parsed.issues)).toEqual([expect.stringContaining(message)]);
  });

  it("uses default fuzzy settings when none are given", () => {
    const { fuzzy: _fuzzy, ...rest } = shippedConfig() as Record<string, unknown>;
    expect(parseBrandConfig(rest).config!.fuzzy).toEqual(DEFAULT_FUZZY);
  });
});

describe("catalog consistency", () => {
  const entries = parseBrandsJson(BRANDS_JSON).entries;
  const build = (cfg: Config, list = entries) => buildBrandCatalog(list, cfg);

  it("rejects a configured brand that is not in brands.json (unknown brand reference)", () => {
    const cfg = config();
    cfg.brands.push({ id: "fleetmax", website: "fleetmax.com", aliases: [] });
    const { catalog, issues } = build(cfg);
    expect(catalog).toBeNull();
    expect(errorsOf(issues)).toEqual([expect.stringContaining('unknown brand reference: "fleetmax"')]);
  });

  it("rejects a brands.json company with no config entry, so no brand is silently untracked", () => {
    const { catalog, issues } = build(config(), [...entries, { name: "Haulio", website: "haulio.com", tier: "other_companies" }]);
    expect(catalog).toBeNull();
    expect(errorsOf(issues)).toEqual([expect.stringContaining('"Haulio" (haulio.com) has no entry')]);
  });

  it("rejects duplicate brand IDs and websites", () => {
    const cfg = config();
    cfg.brands.push({ id: "corvane", website: "corvanefleet.com", aliases: [] });
    expect(errorsOf(build(cfg).issues)).toEqual([
      expect.stringContaining('brand id "corvane" is used twice'),
      expect.stringContaining("website corvanefleet.com is configured twice"),
    ]);
  });

  it("rejects an alias that names another brand", () => {
    const cfg = config();
    cfg.brands.find((b) => b.id === "fleetora")!.aliases.push("Trak Via");
    expect(errorsOf(build(cfg).issues)).toEqual([expect.stringContaining('"Trak Via" (fleetora) collides with a name or alias of "trakvia"')]);
  });

  it("warns about and drops an alias that repeats the brand's own name", () => {
    const cfg = config();
    cfg.brands.find((b) => b.id === "trakvia")!.aliases.push("TRAKVIA");
    const { catalog, issues } = build(cfg);
    expect(catalog!.brands.find((b) => b.id === "trakvia")!.forms).toHaveLength(1);
    expect(issues).toEqual([expect.objectContaining({ severity: "warn", message: expect.stringContaining("repeats an existing form") })]);
  });

  it.each([
    [{ id: "x", name: "Logistics by Corvane", brand: "corvane", qualifiers: ["Logistics"] }, "must end with one of its qualifiers"],
    [{ id: "x", name: "Corvanex Logistics", brand: "corvane", qualifiers: ["Logistics"] }, '"corvanex" is not a name or alias of "corvane"'],
  ])("rejects a decoy whose head is not a name of its brand (%#)", (decoy, message) => {
    expect(errorsOf(build(config({ decoys: [decoy] })).issues)).toEqual([expect.stringContaining(message)]);
  });

  it("rejects a decoy for an unknown brand, or one identical to a brand name", () => {
    const unknown = config({ decoys: [{ id: "d", name: "Acme Logistics", brand: "acme", qualifiers: ["Logistics"] }] });
    expect(errorsOf(build(unknown).issues)).toEqual([expect.stringContaining('refers to unknown brand "acme"')]);
    const clash = config({ decoys: [{ id: "d", name: "Corvane Fleet", brand: "corvane", qualifiers: ["Fleet"] }] });
    expect(errorsOf(build(clash).issues)).toEqual([expect.stringContaining('identical to a name or alias of "corvane"')]);
  });
});

describe("loadBrandCatalog (filesystem)", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-brands-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("loads brands.json from the data directory with the shipped config", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "brands.json"), JSON.stringify(BRANDS_JSON));
      const { catalog, issues } = loadBrandCatalog({ dataDir: dir, configPath: SHIPPED_CONFIG_PATH });
      expect(issues).toEqual([]);
      expect(catalog!.brands.map((b) => b.id)).toEqual(["corvane", "trakvia", "routelyne", "gridwell", "fleetora", "novahaul"]);
    });
  });

  it("reports a missing brands.json, a missing config and invalid JSON as errors", () => {
    withDir((dir) => {
      expect(loadBrandCatalog({ dataDir: dir, configPath: SHIPPED_CONFIG_PATH }).issues[0]!.message).toContain("cannot read file");
      expect(loadBrandCatalog({ dataDir: dir, configPath: join(dir, "none.json") }).catalog).toBeNull();
      writeFileSync(join(dir, "brands.json"), "{ not json");
      const bad = loadBrandCatalog({ dataDir: dir, configPath: SHIPPED_CONFIG_PATH });
      expect(bad.catalog).toBeNull();
      expect(bad.issues[0]!.message).toContain("not valid JSON");
    });
  });
});
