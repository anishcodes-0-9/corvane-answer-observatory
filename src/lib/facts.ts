/**
 * Wrong-fact detection against facts.json.
 *
 * Only explicit claims that contradict a known fact are flagged. A claim that
 * facts.json does not cover, or that cannot be read reliably, is left
 * unflagged ("unverified, not wrong", as the brief says). Supported claim
 * patterns, by fact_key (the dotted path into facts.json):
 *
 *   hq                  "based in <place>", "headquartered in <place>"
 *   founded             "founded/established/launched in <year>", "around since <year>"
 *   starting_price_usd  "pricing/plans start at $N", "from $N", "starting at $N",
 *                       per vehicle (per month) only; ranges are ignored
 *   features.<name>     an explicit negation of a feature the company has
 *                       ("doesn't support ELD compliance"), or an explicit
 *                       claim of a feature it lacks ("includes built-in dashcams")
 *   integrations        an explicit negation of a listed integration
 *                       ("doesn't integrate with QuickBooks")
 *
 * Claims are attributed to a brand with the same sentence ownership as tone:
 * the brand named in the sentence, or the last brand named earlier on the same
 * line ("It's based in Columbus, Georgia."). Sentences about a decoy are never
 * attributed to a brand.
 */
import type { BrandId, BrandMatch } from "./brandTypes";
import { attributeSentences } from "./tone";

export interface CompanyFacts {
  startingPriceUsd: number | null;
  priceUnit: string | null;
  hq: { city: string; state: string | null } | null;
  founded: number | null;
  features: Record<string, boolean>;
  integrations: string[];
}

export interface WrongFact {
  responseId: string;
  brand: BrandId;
  /** Dotted path into facts.json, e.g. "hq" or "features.dashcams". */
  factKey: string;
  /** The sentence containing the claim, exactly as written in the answer. */
  claimText: string;
  claimed: string;
  actual: string;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// facts.json
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses facts.json into per-brand facts keyed by the brief's brand IDs ("corvane", ...). */
export function parseFacts(value: unknown): { facts: Map<BrandId, CompanyFacts>; issues: string[] } {
  const facts = new Map<BrandId, CompanyFacts>();
  const issues: string[] = [];
  if (!isObj(value)) return { facts, issues: ["facts.json must be a JSON object"] };
  for (const [brand, raw] of Object.entries(value)) {
    if (brand.startsWith("_")) continue;
    if (!isObj(raw)) {
      issues.push(`facts for "${brand}" must be an object`);
      continue;
    }
    const hqRaw = typeof raw.hq === "string" ? raw.hq.split(",").map((s) => s.trim()) : null;
    const features: Record<string, boolean> = {};
    if (isObj(raw.features)) for (const [k, v] of Object.entries(raw.features)) if (typeof v === "boolean") features[k] = v;
    facts.set(brand, {
      startingPriceUsd: typeof raw.starting_price_usd === "number" ? raw.starting_price_usd : null,
      priceUnit: typeof raw.price_unit === "string" ? raw.price_unit : null,
      hq: hqRaw && hqRaw[0] ? { city: hqRaw[0], state: hqRaw[1] ?? null } : null,
      founded: typeof raw.founded === "number" ? raw.founded : null,
      features,
      integrations: Array.isArray(raw.integrations) ? raw.integrations.filter((i): i is string => typeof i === "string") : [],
    });
  }
  return { facts, issues };
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut",
  de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia",
  wi: "wisconsin", wy: "wyoming",
};
const STATE_NAMES = new Set(Object.values(US_STATES));
/** Places too vague to contradict a city/state ("based in the Midwest"). */
const VAGUE_PLACES = new Set(["midwest", "the midwest", "us", "usa", "the us", "united states", "the united states", "america", "north america", "europe", "the south", "the north", "the east", "the west"]);

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
const stateName = (s: string) => {
  const k = norm(s).replace(/\.$/, "");
  return US_STATES[k] ?? (STATE_NAMES.has(k) ? k : null);
};

const FEATURE_TERMS: Record<string, string> = {
  gps_tracking: String.raw`gps(?: tracking)?`,
  eld_compliance: String.raw`eld(?: compliance)?|electronic logging`,
  fuel_card_integration: String.raw`fuel[- ]card(?:s| integrations?| controls)?`,
  maintenance_alerts: String.raw`maintenance (?:alerts?|reminders?)`,
  driver_app: String.raw`driver app|mobile app`,
  dashcams: String.raw`dash ?cams?|dashboard cameras?|video[- ]based safety|in-cab cameras?`,
  payroll: String.raw`payroll`,
};
const NEGATION = String.raw`(?:doesn't|does not|don't|do not|can't|cannot|won't|isn't|is not|lacks?|without|no)\b`;
const AFFIRM = String.raw`(?:includes?|included|offers?|provides?|supports?|handles?|comes with|has|have|features?|built[- ]in)\b`;

interface Claim {
  factKey: string;
  check: (f: CompanyFacts) => { contradicts: boolean; claimed: string; actual: string } | null;
}

function hqClaims(sentence: string): Claim[] {
  const m = /\b(?:based|headquartered|headquarters (?:is|are)?)\s+(?:out of|in)\s+((?:the\s+)?[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*)(?:,\s*([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*))?/.exec(sentence);
  if (!m) return [];
  // Names may contain "." ("St. Louis") but not end with the sentence's full stop.
  const place = m[1]!.replace(/[.'-]+$/, "");
  const second = m[2] ? m[2].replace(/[.'-]+$/, "") : null;
  return [
    {
      factKey: "hq",
      check: (f) => {
        if (!f.hq) return null;
        const claimed = second ? `${place}, ${second}` : place;
        const actual = f.hq.state ? `${f.hq.city}, ${f.hq.state}` : f.hq.city;
        if (VAGUE_PLACES.has(norm(place))) return null;
        const factState = f.hq.state ? stateName(f.hq.state) : null;
        if (!second) {
          // One place: a state is compared with the state, anything else with the city.
          const asState = stateName(place);
          if (asState) return factState ? { contradicts: asState !== factState, claimed, actual } : null;
          return { contradicts: norm(place) !== norm(f.hq.city), claimed, actual };
        }
        const claimedState = stateName(second);
        if (!claimedState) return null; // "Columbus, near the river": not a state, can't compare
        const cityDiffers = norm(place) !== norm(f.hq.city);
        const stateDiffers = factState !== null && claimedState !== factState;
        return { contradicts: cityDiffers || stateDiffers, claimed, actual };
      },
    },
  ];
}

function foundedClaims(sentence: string): Claim[] {
  const m = /\b(?:founded|established|launched|started)\s+in\s+((?:18|19|20)\d{2})\b|\b(?:around|operating|in business)\s+since\s+((?:18|19|20)\d{2})\b/i.exec(sentence);
  if (!m) return [];
  const year = Number(m[1] ?? m[2]);
  return [{ factKey: "founded", check: (f) => (f.founded === null ? null : { contradicts: year !== f.founded, claimed: String(year), actual: String(f.founded) }) }];
}

function priceClaims(sentence: string): Claim[] {
  const s = norm(sentence);
  if (/\bbetween\s+\$/.test(s) || /\$\s?\d[\d,.]*\s*(?:-|–|to)\s*\$?\d/.test(s)) return []; // ranges are not a starting price
  const m = /(?:pricing|prices?|plans?|it)\s+(?:starts?|begins?)\s+at\s+(about|around|roughly|approximately|~)?\s*\$\s?(\d+(?:\.\d+)?)|(?:expect to pay|costs?|starting|starts)\s+(?:from|at)\s+(about|around|roughly|approximately|~)?\s*\$\s?(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return [];
  const approx = Boolean(m[1] ?? m[3]);
  const amount = Number(m[2] ?? m[4]);
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
  if (!/^\s*(?:per|a|\/)\s*(?:vehicle|truck|unit)/.test(after)) return []; // unit must be per vehicle
  if (/\b(?:per|a)\s+(?:year|annum|week|day)\b/.test(after)) return [];
  return [
    {
      factKey: "starting_price_usd",
      check: (f) => {
        if (f.startingPriceUsd === null) return null;
        const tolerance = approx ? Math.max(2, f.startingPriceUsd * 0.1) : 0;
        return {
          contradicts: Math.abs(amount - f.startingPriceUsd) > tolerance,
          claimed: `${approx ? "about " : ""}$${amount}`,
          actual: `$${f.startingPriceUsd}`,
        };
      },
    },
  ];
}

function featureClaims(sentence: string): Claim[] {
  const s = norm(sentence);
  const claims: Claim[] = [];
  for (const [feature, term] of Object.entries(FEATURE_TERMS)) {
    // An audience description is not a claim: "for carriers that need ELD compliance".
    const audience = new RegExp(String.raw`\b(?:that|who)\s+(?:need|needs|want|wants|use|uses)\b[^.]{0,30}\b(?:${term})\b`).test(s);
    if (audience) continue;
    // A negation wins over the verb it negates ("doesn't support ELD" is not
    // an affirmation of ELD).
    const negated = new RegExp(String.raw`\b${NEGATION}[^.;]{0,30}?\b(?:${term})\b`).test(s);
    const affirmed =
      !negated &&
      (new RegExp(String.raw`\b${AFFIRM}[^.;]{0,40}?\b(?:${term})\b`).test(s) ||
        new RegExp(String.raw`\b(?:${term})\b[^.;]{0,20}\b(?:is|are) included\b`).test(s));
    if (!negated && !affirmed) continue;
    claims.push({
      factKey: `features.${feature}`,
      check: (f) => {
        const has = f.features[feature];
        if (has === undefined) return null;
        return { contradicts: negated ? has : !has, claimed: negated ? "does not have it" : "has it", actual: has ? "has it" : "does not have it" };
      },
    });
  }
  return claims;
}

function integrationClaims(sentence: string, f: CompanyFacts): Claim[] {
  const s = norm(sentence);
  const claims: Claim[] = [];
  for (const name of f.integrations) {
    const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(String.raw`\b(?:doesn't|does not|don't|do not|can't|cannot|won't|no longer)\s+(?:integrate|connect|work|sync)\s+with\b[^.;]{0,30}\b${n}\b`).test(s)) {
      claims.push({
        factKey: "integrations",
        check: () => ({ contradicts: true, claimed: `does not integrate with ${name}`, actual: f.integrations.join(", ") }),
      });
    }
  }
  return claims;
}

/**
 * Finds contradicted facts in one answer for the given brands. `matches` and
 * `decoys` come from brand matching on the same text.
 */
export function findWrongFacts(
  responseId: string,
  text: string,
  matches: readonly BrandMatch[],
  decoys: ReadonlyArray<{ start: number; end: number }>,
  facts: ReadonlyMap<BrandId, CompanyFacts>,
  brands: readonly BrandId[],
): WrongFact[] {
  const out: WrongFact[] = [];
  const seen = new Set<string>();
  for (const sent of attributeSentences(text, matches, decoys)) {
    // Only sentences about exactly one brand: a claim in a sentence naming two
    // companies cannot be attributed reliably.
    if (sent.brands.length !== 1) continue;
    const brand = sent.brands[0]!;
    if (!brands.includes(brand)) continue;
    const f = facts.get(brand);
    if (!f) continue;
    const claimText = sent.text.trim();
    const claims = [...hqClaims(claimText), ...foundedClaims(claimText), ...priceClaims(claimText), ...featureClaims(claimText), ...integrationClaims(claimText, f)];
    for (const claim of claims) {
      const result = claim.check(f);
      if (!result?.contradicts) continue;
      const key = `${brand}|${claim.factKey}|${claimText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ responseId, brand, factKey: claim.factKey, claimText, claimed: result.claimed, actual: result.actual, start: sent.start, end: sent.end });
    }
  }
  return out;
}
