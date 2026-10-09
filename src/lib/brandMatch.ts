/**
 * findBrandMatches(text, catalog): which brands a piece of text names, where,
 * and how. Pure: no knowledge of responses, files or the loader.
 *
 * Steps (see docs/brand-analysis.md):
 * 1. Candidates: websites (regex), names/aliases (token n-grams compared by
 *    their joined keys), fuzzy misspellings (capitalised n-grams near a key).
 * 2. Decoys: the decoy's head word (exact or misspelled, e.g. "Corvane")
 *    followed by a qualifier ("Logistics"/"Logistic"), or the decoy name
 *    written as one word, becomes a decoy span.
 * 3. Drop candidates overlapping a decoy; drop fuzzy candidates overlapping an
 *    exact one; then accept non-overlapping candidates greedily in a fixed order.
 */
import type {
  AmbiguousCandidate,
  BrandCatalog,
  BrandForm,
  BrandId,
  BrandMatch,
  DecoyMatch,
  MatchType,
  TextMatchResult,
} from "./brandTypes";
import { editDistance, isNameJoiner, startsWithCapital, tokenize, type Token } from "./textTokens";

interface Candidate {
  brand: BrandId;
  start: number;
  end: number;
  matchType: MatchType;
  matchedForm: string;
  distance: number;
  /** Compact key of the brand form matched; null for website candidates. */
  formCompact: string | null;
  /** Index of the token after the candidate; null for website candidates. */
  nextToken: number | null;
}

const TYPE_RANK: Record<MatchType, number> = { website: 0, name: 1, alias: 2, fuzzy: 3 };
/** Longest span of tokens tried as one name, e.g. "Gridwell Sys tems". */
const MAX_NGRAM = 4;
/** Fuzzy candidates are limited to one or two words. */
const MAX_FUZZY_NGRAM = 2;

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function websiteCandidates(text: string, catalog: BrandCatalog): Candidate[] {
  const out: Candidate[] = [];
  for (const brand of catalog.brands) {
    // The brand's own domain: optional scheme, "www." and path; also as an
    // email domain ("sales@trakvia.com"). Not part of a longer host on either
    // side ("notgridwell.io", "gridwell.io.example.com"). Case-insensitive.
    const re = new RegExp(
      String.raw`(?<![\p{L}\p{N}._/-])(?:https?:\/\/)?(?:www\.)?${escapeRegExp(brand.website)}(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])(?:\/[^\s)\]>"'*|]*)?`,
      "giu",
    );
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const surface = m[0].replace(/[.,;:!?]+$/, "");
      out.push({
        brand: brand.id,
        start,
        end: start + surface.length,
        matchType: "website",
        matchedForm: brand.website,
        distance: 0,
        formCompact: null,
        nextToken: null,
      });
    }
  }
  return out;
}

interface NGram {
  first: number;
  last: number;
  /** Token keys, e.g. ["corvain", "fleet"]. */
  keys: string[];
  compact: string;
  start: number;
  end: number;
}

function* ngrams(text: string, tokens: Token[], maxN: number): Generator<NGram> {
  for (let i = 0; i < tokens.length; i++) {
    const keys: string[] = [];
    for (let j = i; j < tokens.length && j - i < maxN; j++) {
      if (j > i && !isNameJoiner(text.slice(tokens[j - 1]!.end, tokens[j]!.start))) break;
      keys.push(tokens[j]!.key);
      yield { first: i, last: j, keys: [...keys], compact: keys.join(""), start: tokens[i]!.start, end: tokens[j]!.end };
    }
  }
}

/** "logistics" and "logistic" compare equal: decoy qualifiers may be singular or plural. */
function singular(key: string): string {
  return key.length > 3 && key.endsWith("s") ? key.slice(0, -1) : key;
}

/**
 * True when a fuzzy candidate is a real dictionary word with nothing else to
 * suggest the brand ("Corvina"). It is allowed when the rest of a multi-word
 * name follows exactly ("Corvina Fleet"): the context makes the typo obvious.
 */
function isRealWordWithoutContext(g: NGram, form: BrandForm, catalog: BrandCatalog): boolean {
  if (!catalog.wordList) return false;
  const corroborated = g.keys.length > 1 && g.keys.some((k, i) => form.tokens[i] === k);
  if (corroborated) return false;
  return g.keys.some((k) => !form.tokens.includes(k) && catalog.wordList!.has(k));
}

function fuzzyLimit(key: string, catalog: BrandCatalog): number {
  const f = catalog.fuzzy;
  return key.length >= f.longKeyLength ? f.maxDistanceLong : f.maxDistanceShort;
}

/** Best fuzzy brand for an n-gram, or an ambiguity when several brands tie. */
function fuzzyMatch(
  g: NGram,
  catalog: BrandCatalog,
): { brand: BrandId; form: BrandForm; distance: number } | { ambiguous: BrandId[]; distance: number } | null {
  const f = catalog.fuzzy;
  if (g.compact.length < f.minKeyLength) return null;
  const words = g.last - g.first + 1;
  const best = new Map<BrandId, { form: BrandForm; distance: number }>();
  for (const brand of catalog.brands) {
    for (const form of brand.forms) {
      if (form.compact.length < f.minKeyLength) continue;
      // A misspelling has at most as many words as the name: "Gridwel is" must
      // not match the one-word "Gridwell" by swallowing the next word.
      if (words > form.tokens.length) continue;
      if (g.compact.slice(0, f.sharedPrefix) !== form.compact.slice(0, f.sharedPrefix)) continue;
      // The full name followed by more letters is a different word ("Corvanex",
      // "Corvanes"), just as "Gridwellness" is not Gridwell.
      if (g.compact.length > form.compact.length && g.compact.startsWith(form.compact)) continue;
      const limit = fuzzyLimit(form.compact, catalog);
      const distance = editDistance(g.compact, form.compact, limit);
      if (distance === 0 || distance > limit) continue;
      if (isRealWordWithoutContext(g, form, catalog)) continue;
      const prev = best.get(brand.id);
      if (!prev || distance < prev.distance) best.set(brand.id, { form, distance });
    }
  }
  if (best.size === 0) return null;
  const min = Math.min(...[...best.values()].map((b) => b.distance));
  const tied = catalog.brands.map((b) => b.id).filter((id) => best.get(id)?.distance === min);
  if (tied.length > 1) return { ambiguous: tied, distance: min };
  const winner = best.get(tied[0]!)!;
  return { brand: tied[0]!, form: winner.form, distance: winner.distance };
}

const HOST_RE = /(?<![\p{L}\p{N}_.@-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[a-z]{2,}(?![\p{L}\p{N}_-])/gu;

/**
 * Host names in the text that are not exactly a brand's own domain (optionally
 * with "www."). The top-level domain must be lower-case, so a missing space
 * after a full stop ("Gridwell.Next steps") is not mistaken for a host.
 */
function foreignHosts(text: string, catalog: BrandCatalog): Array<{ start: number; end: number }> {
  const own = new Set(catalog.brands.map((b) => b.website));
  const out: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(HOST_RE)) {
    const host = m[0].toLowerCase().replace(/^www\./, "");
    if (!own.has(host)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function findBrandMatches(text: string, catalog: BrandCatalog): TextMatchResult {
  const tokens = tokenize(text);
  const formIndex = new Map<string, { brand: BrandId; form: BrandForm }>();
  for (const brand of catalog.brands) for (const form of brand.forms) formIndex.set(form.compact, { brand: brand.id, form });
  const brandOrder = new Map(catalog.brands.map((b, i) => [b.id, i]));

  const exact: Candidate[] = websiteCandidates(text, catalog);
  const fuzzy: Candidate[] = [];
  const ambiguousRaw: AmbiguousCandidate[] = [];
  const decoyNames = new Map(catalog.decoys.map((d) => [singular(d.compact), d]));
  const decoySpans: DecoyMatch[] = [];

  const grams = [...ngrams(text, tokens, MAX_NGRAM)];
  for (const g of grams) {
    const decoy = decoyNames.get(singular(g.compact));
    if (decoy) {
      decoySpans.push({ decoy: decoy.id, brand: decoy.brand, start: g.start, end: g.end, surface: text.slice(g.start, g.end) });
    }
    const hit = formIndex.get(g.compact);
    if (hit) {
      exact.push({
        brand: hit.brand,
        start: g.start,
        end: g.end,
        matchType: hit.form.kind,
        matchedForm: hit.form.label,
        distance: 0,
        formCompact: hit.form.compact,
        nextToken: g.last + 1,
      });
      continue;
    }
    if (!catalog.fuzzy.enabled || g.last - g.first + 1 > MAX_FUZZY_NGRAM) continue;
    if (catalog.fuzzy.requireCapitalInitial && !startsWithCapital(tokens[g.first]!.raw)) continue;
    const fm = fuzzyMatch(g, catalog);
    if (!fm) continue;
    if ("ambiguous" in fm) {
      ambiguousRaw.push({ start: g.start, end: g.end, surface: text.slice(g.start, g.end), brands: fm.ambiguous, distance: fm.distance });
    } else {
      fuzzy.push({
        brand: fm.brand,
        start: g.start,
        end: g.end,
        matchType: "fuzzy",
        matchedForm: fm.form.label,
        distance: fm.distance,
        formCompact: fm.form.compact,
        nextToken: g.last + 1,
      });
    }
  }

  // The decoy head followed by a qualifier is the decoy, e.g. "Corvane Logistics".
  // Only the head counts: "Corvane Fleet Logistics" still names Corvane Fleet.
  for (const decoy of catalog.decoys) {
    for (const c of [...exact, ...fuzzy]) {
      if (c.brand !== decoy.brand || c.nextToken === null || c.formCompact !== decoy.head) continue;
      for (const qualifier of decoy.qualifiers) {
        let end = -1;
        let prevEnd = c.end;
        for (let k = 0; k < qualifier.length; k++) {
          const t = tokens[c.nextToken + k];
          if (!t || singular(t.key) !== singular(qualifier[k]!) || !isNameJoiner(text.slice(prevEnd, t.start))) {
            end = -1;
            break;
          }
          end = t.end;
          prevEnd = t.end;
        }
        if (end !== -1) decoySpans.push({ decoy: decoy.id, brand: decoy.brand, start: c.start, end, surface: text.slice(c.start, end) });
      }
    }
  }
  const decoys = dedupeSpans(decoySpans);

  // A brand name inside some other host name is not a mention: only the brand's
  // own domain counts ("gridwell.io.example.com", "routelyne.io" do not).
  const hosts = foreignHosts(text, catalog);
  const notInDecoy = (c: { start: number; end: number }) => !decoys.some((d) => overlaps(c, d));
  const allowed = (c: Candidate) => notInDecoy(c) && (c.matchType === "website" || !hosts.some((h) => overlaps(c, h)));
  const exactKept = exact.filter(allowed);
  const fuzzyKept = fuzzy.filter((c) => allowed(c) && !exactKept.some((e) => overlaps(c, e)));

  // Order: earliest start; exact before fuzzy; closer fuzzy before farther;
  // longer span; match-type priority; brand order. Fully deterministic.
  const ordered = [...exactKept, ...fuzzyKept].sort(
    (a, b) =>
      a.start - b.start ||
      Number(a.matchType === "fuzzy") - Number(b.matchType === "fuzzy") ||
      a.distance - b.distance ||
      b.end - b.start - (a.end - a.start) ||
      TYPE_RANK[a.matchType] - TYPE_RANK[b.matchType] ||
      brandOrder.get(a.brand)! - brandOrder.get(b.brand)!,
  );
  const accepted: Candidate[] = [];
  let reachedEnd = -1;
  for (const c of ordered) {
    if (c.start < reachedEnd) continue; // overlaps an accepted match (sorted by start)
    accepted.push(c);
    reachedEnd = c.end;
  }

  const matches: BrandMatch[] = accepted.map((c) => ({
    brand: c.brand,
    start: c.start,
    end: c.end,
    surface: text.slice(c.start, c.end),
    matchType: c.matchType,
    matchedForm: c.matchedForm,
    distance: c.distance,
  }));
  const ambiguous = dedupeSpans(
    ambiguousRaw.filter((a) => notInDecoy(a) && !accepted.some((m) => overlaps(a, m)) && !exactKept.some((e) => overlaps(a, e))),
  );
  return { matches, decoys, ambiguous };
}

/** Removes exact repeats and spans contained in a longer span; keeps text order. */
function dedupeSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: T[] = [];
  for (const s of sorted) {
    if (out.some((o) => o.start <= s.start && s.end <= o.end)) continue;
    out.push(s);
  }
  return out;
}
