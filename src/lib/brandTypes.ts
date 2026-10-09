/**
 * Contracts for brand detection. See docs/brand-analysis.md for the rules.
 */
import type { EngineId, SourceLocation } from "./types";

export type BrandId = string;
export type BrandTier = "client" | "tracked_competitors" | "other_companies";

export interface FuzzySettings {
  enabled: boolean;
  /** Fuzzy matching is only tried against brand keys at least this long. */
  minKeyLength: number;
  /** A candidate must share this many leading letters with the brand key. */
  sharedPrefix: number;
  /** Max edit distance for keys shorter than longKeyLength. */
  maxDistanceShort: number;
  /** Max edit distance for keys of longKeyLength or more. */
  maxDistanceLong: number;
  longKeyLength: number;
  /** Only capitalised words are fuzzy candidates (brand names are proper nouns). */
  requireCapitalInitial: boolean;
  /**
   * A misspelling is a non-word: a fuzzy candidate that is an English
   * dictionary word ("Corvina") is rejected unless the rest of a multi-word
   * brand name follows it exactly ("Corvina Fleet").
   */
  rejectDictionaryWords: boolean;
}

/** Dictionary used to recognise real words. Keys are lower-case. */
export interface WordList {
  /** Package, version and checksum, recorded for reproducibility. */
  source: string;
  size: number;
  has(word: string): boolean;
}

/** A brand form expressed as normalised token keys, e.g. ["corvane", "fleet"]. */
export interface BrandForm {
  /** Original spelling, for reporting. */
  label: string;
  kind: "name" | "alias";
  tokens: string[];
  /** Tokens concatenated, e.g. "corvanefleet". Used for joined/spaced variants. */
  compact: string;
}

export interface Brand {
  id: BrandId;
  name: string;
  website: string;
  tier: BrandTier;
  forms: BrandForm[];
}

export interface Decoy {
  id: string;
  name: string;
  /** Brand whose name the decoy shares; that brand's candidates are suppressed inside the decoy. */
  brand: BrandId;
  /** Normalised qualifier tokens that turn a brand form into the decoy, e.g. [["logistics"]]. */
  qualifiers: string[][];
  /**
   * Compact key of the decoy name without its qualifier, e.g. "corvane". Only a
   * mention of this head (exact or misspelled) followed by a qualifier is the
   * decoy; the full brand name ("Corvane Fleet Logistics") is not.
   */
  head: string;
  /** Compact form of the decoy name, e.g. "corvanelogistics". */
  compact: string;
}

export interface BrandCatalog {
  /** In configured order; this is also the output order. */
  brands: Brand[];
  decoys: Decoy[];
  fuzzy: FuzzySettings;
  /** Present when fuzzy.rejectDictionaryWords is on. */
  wordList: WordList | null;
}

export interface CatalogIssue {
  severity: "error" | "warn";
  message: string;
  file?: string;
}

export type MatchType = "website" | "name" | "alias" | "fuzzy";

export interface BrandMatch {
  brand: BrandId;
  /** UTF-16 offsets into NormalizedResponse.text (entity-decoded), end exclusive. */
  start: number;
  end: number;
  /** text.slice(start, end), exactly as written. */
  surface: string;
  matchType: MatchType;
  /** The brand form or website that matched, e.g. "Corvane Fleet" or "corvanefleet.com". */
  matchedForm: string;
  /** Edit distance for fuzzy matches; 0 otherwise. */
  distance: number;
}

export interface DecoyMatch {
  decoy: string;
  brand: BrandId;
  start: number;
  end: number;
  surface: string;
}

/** A fuzzy span equally close to more than one brand. Not counted as a mention. */
export interface AmbiguousCandidate {
  start: number;
  end: number;
  surface: string;
  brands: BrandId[];
  distance: number;
}

export interface TextMatchResult {
  matches: BrandMatch[];
  decoys: DecoyMatch[];
  ambiguous: AmbiguousCandidate[];
}

export interface BrandResult {
  brand: BrandId;
  mentioned: boolean;
  /** 1-based order of first mention among brands; null if not mentioned. */
  position: number | null;
  /** All accepted matches for this brand, in text order. */
  matches: BrandMatch[];
}

export interface ResponseProvenance {
  responseId: string;
  week: number;
  engine: EngineId;
  promptId: string;
  run: number | null;
  source: SourceLocation;
}

export type ResponseBrandAnalysis = ResponseProvenance &
  (
    | {
        status: "analyzed";
        /** One entry per catalog brand, in catalog order. */
        brands: BrandResult[];
        decoys: DecoyMatch[];
        ambiguous: AmbiguousCandidate[];
      }
    | {
        /** Error or empty responses: nothing was observed, so no brand results at all. */
        status: "not_analyzed";
        reason: "error" | "empty";
        error: string | null;
      }
  );

export interface BrandAnalysisSummary {
  responses: number;
  analyzed: number;
  notAnalyzed: { error: number; empty: number };
  /** Per brand: analysed responses that mention it, and how matches were made. */
  byBrand: Array<{
    brand: BrandId;
    tier: BrandTier;
    responsesMentioning: number;
    matches: Record<MatchType, number>;
  }>;
  decoyResponses: number;
  ambiguousCandidates: number;
  fuzzyMatches: number;
}

export interface BrandAnalysisResult {
  responses: ResponseBrandAnalysis[];
  summary: BrandAnalysisSummary;
}
