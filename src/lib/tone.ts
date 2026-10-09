/**
 * Rules-based tone per mentioned brand, following the brief:
 *   recommended     – the answer suggests choosing the company
 *   neutral         – named without a judgement
 *   negative        – criticised, but not ruled out
 *   not_recommended – the answer advises against it
 * "If an answer is mixed about a company, use the tone of its final verdict."
 *
 * Method (transparent and deterministic):
 * 1. Split the answer into lines, and lines into sentences (a markdown table
 *    row is one sentence). Each sentence belongs to the brands matched inside
 *    it; a sentence naming no brand belongs to the last brand named earlier on
 *    the same line ("Some users find X expensive. Even so, it's the one I'd pick.").
 * 2. Split a sentence into clauses at contrast words (but, though, although,
 *    however, even so, that said). The sentence's verdict is the verdict of its
 *    LAST clause that has one ("often recommended, but ... go in with caution"
 *    is negative).
 * 3. A clause's verdict: not_recommended phrases first, then negative, then
 *    recommended; otherwise neutral.
 * 4. A brand's tone is its last non-neutral verdict in the answer; neutral if none.
 */
import type { BrandId, BrandMatch } from "./brandTypes";

export type Tone = "recommended" | "neutral" | "negative" | "not_recommended";

export interface ToneEvidence {
  tone: Exclude<Tone, "neutral">;
  rule: string;
  /** The sentence the verdict came from, as written. */
  sentence: string;
  start: number;
  end: number;
}

export interface BrandTone {
  tone: Tone;
  /** Non-neutral verdicts in text order; the last one decides. */
  evidence: ToneEvidence[];
}

type Rule = [string, RegExp];

const NOT_RECOMMENDED: Rule[] = [
  // "Avoid X" as advice (sentence/bullet start or "I'd/you should avoid"), not "helps you avoid fines".
  // ...also after a list label such as "1. **Trakvia**: Avoid ..." or "**If budget matters:** Avoid ...".
  ["avoid", /(?:^|:\**\s|\*\*\s*)[\s\-*\d.)#>]*avoid\b|\b(?:i'd|i would|you should|better to|we'd)\s+avoid\b/],
  ["wouldnt-choose", /\bwould(?:n't| not) (?:choose|pick|recommend|use|go with|buy)\b/],
  ["not-right-fit", /\b(?:not|isn't|is not|aren't) (?:the )?right (?:fit|choice|option|tool)\b/],
  ["overkill", /\boverkill\b/],
  ["skip", /\bskip\b/],
  ["not-recommended", /\bnot recommended\b/],
  ["dont-recommend", /\b(?:don't|do not|can't|cannot) recommend\b/],
  ["not-for", /\bnot for (?:small|your|you|most|mid|large|owner)/],
  ["steer-clear", /\bsteer clear\b/],
];

const NEGATIVE: Rule[] = [
  ["complaints", /\bcomplain(?:t|ts|ed|s)?\b/],
  ["slow-support", /\bslow (?:customer )?support\b|\bslow fixes\b/],
  ["outages", /\boutages?\b/],
  ["caution", /\bcaution\b/],
  ["clunky", /\bclunky\b/],
  ["limited", /\b(?:is|are|feels?|seems?) limited\b|\blimited compared\b/],
  ["takes-longer", /\btakes? longer than expected\b/],
  ["expensive", /\bexpensive\b|\boverpriced\b/],
  ["mixed-reviews", /\bmixed reviews\b/],
  ["drawbacks", /\bdrawbacks?\b|\bdownsides?\b|\bweak(?:er|ness)?\b/],
];

const RECOMMENDED: Rule[] = [
  ["best-overall", /\bbest overall\b/],
  ["top-pick", /\btop (?:pick|choice|suggestion)\b/],
  ["strong-choice", /\b(?:strong|safe|safest|solid|reliable|great|good|best) (?:pick|choice|option|bet)\b/],
  ["hard-to-beat", /\bhard to beat\b/],
  ["recommend", /\bi(?:'d| would)? recommend\b/],
  ["pick", /\bif i had to pick\b|\bi(?:'d| would) pick\b|\bthe one i(?:'d| would) (?:pick|choose)\b/],
  ["start-with", /\bi(?:'d| would) start with\b|\bstart your shortlist with\b/],
  ["shortlist", /\bworth shortlisting\b|\bshortlist(?:ing)? (?:it|them)\b/],
  ["stands-out", /\bstands out\b/],
  ["better-choices", /\bone of the better (?:choices|options)\b/],
  ["point-to", /\bpoint to .* as the best\b/],
];

const CONTRAST = /\b(?:but|though|although|however|even so|that said)\b/;

function clauseVerdict(clause: string): { tone: Exclude<Tone, "neutral">; rule: string } | null {
  for (const [tone, rules] of [
    ["not_recommended", NOT_RECOMMENDED],
    ["negative", NEGATIVE],
    ["recommended", RECOMMENDED],
  ] as const) {
    for (const [rule, re] of rules) if (re.test(clause)) return { tone, rule };
  }
  return null;
}

/** Verdict of a sentence: its last clause that has one. */
export function sentenceVerdict(sentence: string): { tone: Exclude<Tone, "neutral">; rule: string } | null {
  const normalized = sentence.toLowerCase().replace(/[‘’ʼ]/g, "'");
  const clauses = normalized.split(CONTRAST);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const v = clauseVerdict(clauses[i]!);
    if (v) return v;
  }
  return null;
}

interface Sentence {
  start: number;
  end: number;
  line: number;
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let lineStart = 0;
  text.split("\n").forEach((line, lineNo) => {
    const isTableRow = /^\s*\|/.test(line);
    const pieces = isTableRow ? [{ s: 0, e: line.length }] : splitSentences(line);
    for (const p of pieces) {
      if (line.slice(p.s, p.e).trim() === "") continue;
      out.push({ start: lineStart + p.s, end: lineStart + p.e, line: lineNo });
    }
    lineStart += line.length + 1;
  });
  return out;
}

/** Splits a line after . ! ? followed by space, and at citation markers like "[2]". */
function splitSentences(line: string): Array<{ s: number; e: number }> {
  const out: Array<{ s: number; e: number }> = [];
  const boundary = /(?<=[.!?])\s+|\s*\[\d+\]\s*/g;
  let s = 0;
  for (const m of line.matchAll(boundary)) {
    out.push({ s, e: m.index });
    s = m.index + m[0].length;
  }
  out.push({ s, e: line.length });
  return out;
}

export interface OwnedSentence {
  start: number;
  end: number;
  text: string;
  /** Brands the sentence is about: those named in it, or the carried-over brand. */
  brands: BrandId[];
  /** True when the brands were carried over from an earlier sentence on the same line. */
  carried: boolean;
}

/**
 * Which brands each sentence is about. A sentence naming no brand belongs to
 * the last brand named earlier on the same line ("It's based in Ohio."). A
 * sentence that names a decoy (e.g. Corvane Logistics) and no brand belongs to
 * nobody and ends the carry-over, so a decoy's details never land on a brand.
 */
export function attributeSentences(
  text: string,
  matches: readonly BrandMatch[],
  decoys: ReadonlyArray<{ start: number; end: number }> = [],
): OwnedSentence[] {
  const out: OwnedSentence[] = [];
  let carryLine = -1;
  let carryBrand: BrandId | null = null;
  for (const sent of sentences(text)) {
    const inside = matches.filter((m) => m.start >= sent.start && m.start < sent.end);
    const hasDecoy = decoys.some((d) => d.start >= sent.start && d.start < sent.end);
    let brands: BrandId[] = [];
    let carried = false;
    if (inside.length > 0) {
      brands = [...new Set(inside.map((m) => m.brand))];
      carryBrand = inside[inside.length - 1]!.brand;
      carryLine = sent.line;
    } else if (hasDecoy) {
      carryBrand = null;
    } else if (carryBrand && carryLine === sent.line) {
      brands = [carryBrand];
      carried = true;
    }
    out.push({ start: sent.start, end: sent.end, text: text.slice(sent.start, sent.end), brands, carried });
  }
  return out;
}

export function classifyTones(
  text: string,
  matches: readonly BrandMatch[],
  decoys: ReadonlyArray<{ start: number; end: number }> = [],
): Map<BrandId, BrandTone> {
  const result = new Map<BrandId, BrandTone>();
  for (const m of matches) if (!result.has(m.brand)) result.set(m.brand, { tone: "neutral", evidence: [] });
  for (const sent of attributeSentences(text, matches, decoys)) {
    if (sent.brands.length === 0) continue;
    const verdict = sentenceVerdict(sent.text);
    if (!verdict) continue;
    for (const brand of sent.brands) {
      result.get(brand)!.evidence.push({ ...verdict, sentence: sent.text, start: sent.start, end: sent.end });
    }
  }
  for (const t of result.values()) {
    const last = t.evidence[t.evidence.length - 1];
    if (last) t.tone = last.tone;
  }
  return result;
}
