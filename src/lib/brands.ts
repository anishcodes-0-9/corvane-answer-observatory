/**
 * Brand catalog: brands.json (data pack) + config/brands.config.json (repo)
 * → validated BrandCatalog. No matching happens here.
 *
 * brands.json supplies official names, websites and tiers. The config maps each
 * company (by website) to the brief's brand ID and adds aliases, decoys and
 * fuzzy settings. Any inconsistency is an error: analysis must not run with a
 * brand silently missing or two brands sharing a name.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import wordListPath from "word-list";
import { expandHome } from "./load";
import type { Brand, BrandCatalog, BrandForm, BrandTier, CatalogIssue, Decoy, FuzzySettings, WordList } from "./brandTypes";
import { tokenize } from "./textTokens";

export const DEFAULT_BRAND_CONFIG = "config/brands.config.json";

export const DEFAULT_FUZZY: FuzzySettings = {
  enabled: true,
  minKeyLength: 6,
  sharedPrefix: 3,
  maxDistanceShort: 1,
  maxDistanceLong: 2,
  longKeyLength: 7,
  requireCapitalInitial: true,
  rejectDictionaryWords: true,
};

let cachedWordList: WordList | null = null;

/**
 * English dictionary from the pinned `word-list` package (MIT, ~274k words).
 * Bundled with the project rather than read from the operating system, so
 * results do not depend on the machine. Loaded once per process.
 */
export function loadWordList(): WordList {
  if (cachedWordList) return cachedWordList;
  const raw = readFileSync(wordListPath, "utf8");
  const words = new Set(
    raw
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
  const pkg = JSON.parse(readFileSync(join(dirname(wordListPath), "package.json"), "utf8")) as { name: string; version: string };
  const sha = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  cachedWordList = { source: `${pkg.name}@${pkg.version} (sha256 ${sha})`, size: words.size, has: (w) => words.has(w) };
  return cachedWordList;
}

export interface BrandsJsonEntry {
  name: string;
  website: string;
  tier: BrandTier;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Lower-cases and strips scheme, "www." and trailing slash. Null if not a plain domain. */
export function normalizeWebsite(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

function formFrom(label: string, kind: BrandForm["kind"]): BrandForm | null {
  const tokens = tokenize(label).map((t) => t.key);
  if (tokens.length === 0) return null;
  return { label, kind, tokens, compact: tokens.join("") };
}

/** Parses brands.json: { client: {...}, tracked_competitors: [...], other_companies: [...] }. */
export function parseBrandsJson(value: unknown, file = "brands.json"): { entries: BrandsJsonEntry[]; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const err = (message: string) => issues.push({ severity: "error", message, file });
  if (!isObj(value)) {
    err("brands.json must be a JSON object");
    return { entries: [], issues };
  }
  const entries: BrandsJsonEntry[] = [];
  const take = (v: unknown, tier: BrandTier, where: string) => {
    if (!isObj(v) || !nonEmptyString(v.name) || !nonEmptyString(v.website)) {
      err(`${where} must have a non-empty "name" and "website"`);
      return;
    }
    const website = normalizeWebsite(v.website);
    if (!website) {
      err(`${where} has an invalid website ${JSON.stringify(v.website)}`);
      return;
    }
    entries.push({ name: v.name.trim(), website, tier });
  };
  if (value.client === undefined) err('missing "client"');
  else take(value.client, "client", "client");
  for (const tier of ["tracked_competitors", "other_companies"] as const) {
    const list = value[tier];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      err(`"${tier}" must be a list`);
      continue;
    }
    list.forEach((v, i) => take(v, tier, `${tier}[${i}]`));
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.website)) err(`website ${e.website} appears more than once`);
    seen.add(e.website);
  }
  return { entries, issues };
}

interface ParsedConfig {
  brands: Array<{ id: string; website: string; aliases: string[] }>;
  decoys: Array<{ id: string; name: string; brand: string; qualifiers: string[] }>;
  fuzzy: FuzzySettings;
  brandsFile: string;
}

/** Validates the shape of config/brands.config.json. Keys starting with "_" are comments. */
export function parseBrandConfig(value: unknown, file = DEFAULT_BRAND_CONFIG): { config: ParsedConfig | null; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const err = (message: string) => issues.push({ severity: "error", message, file });
  if (!isObj(value)) {
    err("brand config must be a JSON object");
    return { config: null, issues };
  }

  const brands: ParsedConfig["brands"] = [];
  if (!Array.isArray(value.brands) || value.brands.length === 0) err('"brands" must be a non-empty list');
  else {
    value.brands.forEach((b, i) => {
      const where = `brands[${i}]`;
      if (!isObj(b)) return err(`${where} must be an object`);
      if (!nonEmptyString(b.id) || !/^[a-z][a-z0-9_]*$/.test(b.id)) {
        return err(`${where}.id must be a lower-case slug (got ${JSON.stringify(b.id)})`);
      }
      const website = nonEmptyString(b.website) ? normalizeWebsite(b.website) : null;
      if (!website) return err(`${where}.website must be a plain domain (got ${JSON.stringify(b.website)})`);
      const aliases = b.aliases ?? [];
      if (!Array.isArray(aliases) || !aliases.every(nonEmptyString)) return err(`${where}.aliases must be a list of non-empty strings`);
      brands.push({ id: b.id, website, aliases: aliases.map((a) => a.trim()) });
    });
  }

  const decoys: ParsedConfig["decoys"] = [];
  if (value.decoys !== undefined) {
    if (!Array.isArray(value.decoys)) err('"decoys" must be a list');
    else {
      value.decoys.forEach((d, i) => {
        const where = `decoys[${i}]`;
        if (!isObj(d)) return err(`${where} must be an object`);
        if (!nonEmptyString(d.id) || !nonEmptyString(d.name) || !nonEmptyString(d.brand)) {
          return err(`${where} needs non-empty "id", "name" and "brand"`);
        }
        if (!Array.isArray(d.qualifiers) || d.qualifiers.length === 0 || !d.qualifiers.every(nonEmptyString)) {
          return err(`${where}.qualifiers must be a non-empty list of words`);
        }
        decoys.push({ id: d.id, name: d.name.trim(), brand: d.brand, qualifiers: d.qualifiers.map((q) => q.trim()) });
      });
    }
  }

  let fuzzy = DEFAULT_FUZZY;
  if (value.fuzzy !== undefined) {
    const f = value.fuzzy;
    if (!isObj(f)) err('"fuzzy" must be an object');
    else {
      const merged = { ...DEFAULT_FUZZY, ...Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("_"))) };
      const ints = ["minKeyLength", "sharedPrefix", "maxDistanceShort", "maxDistanceLong", "longKeyLength"] as const;
      const badInt = ints.filter((k) => !Number.isInteger(merged[k]) || (merged[k] as number) < 0);
      if (
        typeof merged.enabled !== "boolean" ||
        typeof merged.requireCapitalInitial !== "boolean" ||
        typeof merged.rejectDictionaryWords !== "boolean"
      ) {
        err('"fuzzy.enabled", "fuzzy.requireCapitalInitial" and "fuzzy.rejectDictionaryWords" must be true or false');
      } else if (badInt.length > 0) {
        err(`fuzzy settings must be non-negative integers: ${badInt.join(", ")}`);
      } else if (merged.maxDistanceShort > 3 || merged.maxDistanceLong > 3) {
        err("fuzzy edit distances above 3 would match unrelated words");
      } else if (merged.sharedPrefix < 1 || merged.minKeyLength <= merged.maxDistanceLong) {
        err("fuzzy.sharedPrefix must be at least 1 and fuzzy.minKeyLength must exceed the largest edit distance");
      } else {
        fuzzy = merged as FuzzySettings;
      }
    }
  }

  const brandsFile = value.brandsFile === undefined ? "brands.json" : value.brandsFile;
  if (!nonEmptyString(brandsFile)) err('"brandsFile" must be a file name');

  if (issues.some((i) => i.severity === "error")) return { config: null, issues };
  return { config: { brands, decoys, fuzzy, brandsFile: brandsFile as string }, issues };
}

/** Joins brands.json and config into a catalog, rejecting unknown references and name collisions. */
export function buildBrandCatalog(
  entries: readonly BrandsJsonEntry[],
  config: ParsedConfig,
  files: { brands?: string; config?: string } = {},
  /** Injectable for tests; defaults to the bundled dictionary when the config asks for one. */
  wordList?: WordList,
): { catalog: BrandCatalog | null; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const err = (message: string, file = files.config) => issues.push({ severity: "error", message, ...(file ? { file } : {}) });
  const warn = (message: string) => issues.push({ severity: "warn", message, ...(files.config ? { file: files.config } : {}) });

  const byWebsite = new Map(entries.map((e) => [e.website, e]));
  const configured = new Set<string>();
  const ids = new Set<string>();
  const brands: Brand[] = [];

  for (const b of config.brands) {
    if (ids.has(b.id)) err(`brand id "${b.id}" is used twice`);
    ids.add(b.id);
    if (configured.has(b.website)) err(`website ${b.website} is configured twice`);
    configured.add(b.website);
    const entry = byWebsite.get(b.website);
    if (!entry) {
      err(`unknown brand reference: "${b.id}" points to ${b.website}, which is not in brands.json`);
      continue;
    }
    const forms: BrandForm[] = [];
    const name = formFrom(entry.name, "name");
    if (!name) {
      err(`brands.json name ${JSON.stringify(entry.name)} has no letters or digits`, files.brands);
      continue;
    }
    forms.push(name);
    for (const alias of b.aliases) {
      const form = formFrom(alias, "alias");
      if (!form) err(`alias ${JSON.stringify(alias)} for "${b.id}" has no letters or digits`);
      else if (forms.some((f) => f.compact === form.compact)) warn(`alias ${JSON.stringify(alias)} for "${b.id}" repeats an existing form; ignored`);
      else forms.push(form);
    }
    brands.push({ id: b.id, name: entry.name, website: entry.website, tier: entry.tier, forms });
  }
  for (const e of entries) {
    if (!configured.has(e.website)) err(`brands.json company "${e.name}" (${e.website}) has no entry in the brand config`);
  }

  // No two brands may share a form: a name must identify exactly one company.
  const owner = new Map<string, string>();
  for (const b of brands) {
    for (const f of b.forms) {
      const other = owner.get(f.compact);
      if (other && other !== b.id) err(`"${f.label}" (${b.id}) collides with a name or alias of "${other}"`);
      owner.set(f.compact, b.id);
    }
  }

  const decoys: Decoy[] = [];
  const decoyIds = new Set<string>();
  for (const d of config.decoys) {
    if (decoyIds.has(d.id)) err(`decoy id "${d.id}" is used twice`);
    decoyIds.add(d.id);
    if (!ids.has(d.brand)) {
      err(`decoy "${d.id}" refers to unknown brand "${d.brand}"`);
      continue;
    }
    const nameTokens = tokenize(d.name).map((t) => t.key);
    const nameKey = nameTokens.join("");
    const qualifiers = d.qualifiers.map((q) => tokenize(q).map((t) => t.key));
    if (!nameKey || qualifiers.some((q) => q.length === 0)) {
      err(`decoy "${d.id}" has an empty name or qualifier`);
      continue;
    }
    const clash = owner.get(nameKey);
    if (clash) err(`decoy "${d.name}" is identical to a name or alias of "${clash}"`);
    // The decoy name must be <head> + <qualifier>, and the head must be a name
    // or alias of the brand it shadows; otherwise it could never be recognised.
    const ending = qualifiers.find((q) => q.length < nameTokens.length && q.every((t, k) => nameTokens[nameTokens.length - q.length + k] === t));
    if (!ending) {
      err(`decoy "${d.name}" must end with one of its qualifiers`);
      continue;
    }
    const head = nameTokens.slice(0, nameTokens.length - ending.length).join("");
    if (owner.get(head) !== d.brand) {
      err(`decoy "${d.name}": "${head}" is not a name or alias of "${d.brand}"`);
      continue;
    }
    decoys.push({ id: d.id, name: d.name, brand: d.brand, qualifiers, head, compact: nameKey });
  }

  if (issues.some((i) => i.severity === "error")) return { catalog: null, issues };
  const words = config.fuzzy.enabled && config.fuzzy.rejectDictionaryWords ? (wordList ?? loadWordList()) : null;
  return { catalog: { brands, decoys, fuzzy: config.fuzzy, wordList: words }, issues };
}

/** Reads the brand config (repo) and brands.json (data directory) and builds the catalog. */
export function loadBrandCatalog(options: { dataDir: string; configPath?: string }): {
  catalog: BrandCatalog | null;
  issues: CatalogIssue[];
} {
  const configFile = resolve(expandHome(options.configPath ?? DEFAULT_BRAND_CONFIG));
  const read = (file: string): { value?: unknown; issue?: CatalogIssue } => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      return { issue: { severity: "error", message: `cannot read file: ${(e as Error).message}`, file } };
    }
    try {
      return { value: JSON.parse(raw) };
    } catch (e) {
      return { issue: { severity: "error", message: `not valid JSON: ${(e as Error).message}`, file } };
    }
  };

  const cfgRaw = read(configFile);
  if (cfgRaw.issue) return { catalog: null, issues: [cfgRaw.issue] };
  const parsedConfig = parseBrandConfig(cfgRaw.value, configFile);
  if (!parsedConfig.config) return { catalog: null, issues: parsedConfig.issues };

  const brandsFile = resolve(join(expandHome(options.dataDir), parsedConfig.config.brandsFile));
  const brandsRaw = read(brandsFile);
  if (brandsRaw.issue) return { catalog: null, issues: [...parsedConfig.issues, brandsRaw.issue] };
  const parsedBrands = parseBrandsJson(brandsRaw.value, brandsFile);
  if (parsedBrands.issues.some((i) => i.severity === "error")) {
    return { catalog: null, issues: [...parsedConfig.issues, ...parsedBrands.issues] };
  }
  const built = buildBrandCatalog(parsedBrands.entries, parsedConfig.config, { brands: brandsFile, config: configFile });
  return { catalog: built.catalog, issues: [...parsedConfig.issues, ...parsedBrands.issues, ...built.issues] };
}
