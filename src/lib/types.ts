/**
 * Data contracts for the loader layer.
 *
 * Contracts for later layers (brands, segmentation, mentions, tone, facts,
 * scoring) are added alongside those modules so this file only describes
 * what is implemented.
 */

/** Canonical engine IDs we know about. Unknown engines are kept as a slug. */
export type KnownEngineId = "chatgpt" | "perplexity" | "google_ai_overview";
export type EngineId = KnownEngineId | (string & {});

/**
 * ok    – usable answer text.
 * error – the collector reported an error (e.g. timeout). Never treated as a valid empty answer.
 * empty – no error was reported, but the answer text is missing or blank.
 */
export type ResponseStatus = "ok" | "error" | "empty";

export type TimestampFormat =
  | "iso_offset" // ISO 8601 with Z or ±HH:MM
  | "iso_naive" // ISO 8601 without an offset; interpreted as UTC
  | "dmy" // DD/MM/YYYY HH:mm[:ss]; interpreted as UTC
  | "unparsed";

export interface SourceLocation {
  /** File name relative to the data directory. */
  file: string;
  /** 0-based position of the record among the records in that file. */
  recordIndex: number;
  /** 1-based line number for line-delimited (JSONL) files; null for JSON arrays. */
  line: number | null;
}

export interface NormalizedResponse {
  id: string;
  /** Explicit week from the record. Never inferred from timestamps. */
  week: number;
  /** Canonical engine ID, e.g. "google_ai_overview". */
  engine: EngineId;
  /** Engine label exactly as it appeared in the record, e.g. "AI Overview". */
  engineLabel: string;
  /** Uppercased (and, where it matches a known prompt, zero-padded) prompt ID. */
  promptId: string;
  /** Prompt ID exactly as it appeared in the record. */
  promptIdRaw: string;
  /** Run number (1 or 2 in the case-study data); null if missing or invalid. */
  run: number | null;
  /** ISO 8601 UTC timestamp, or null if missing/unparseable. */
  collectedAt: string | null;
  collectedAtRaw: string | null;
  timestampFormat: TimestampFormat | null;
  /** Answer text exactly as supplied (HTML entities intact). */
  rawText: string;
  /** Answer text with HTML entities decoded. Used for all analysis. */
  text: string;
  citations: string[];
  status: ResponseStatus;
  /** Error label from the collector, e.g. "timeout". Present only when status is "error". */
  error: string | null;
  source: SourceLocation;
}

export type WarningSeverity = "info" | "warn" | "error";

export type WarningCode =
  | "ignored_file"
  | "format_note"
  | "unreadable_file"
  | "malformed_file"
  | "malformed_record"
  | "not_an_object"
  | "missing_required_field"
  | "invalid_week"
  | "invalid_run"
  | "unknown_engine"
  | "unknown_prompt"
  | "prompt_id_normalized"
  | "unknown_field"
  | "conflicting_text_fields"
  | "invalid_text_field"
  | "invalid_citations"
  | "unparseable_timestamp"
  | "missing_timestamp"
  | "nested_response_files"
  | "naive_timestamp"
  | "unknown_html_entity"
  | "error_record"
  | "error_with_text"
  | "empty_text"
  | "duplicate_exact"
  | "duplicate_conflict"
  | "duplicate_file"
  | "duplicate_slot"
  | "prompts_missing"
  | "prompts_malformed"
  | "expected_config_invalid"
  | "expected_config_mismatch";

export interface DataQualityWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  file?: string;
  line?: number | null;
  recordIndex?: number;
  responseIds?: string[];
  /** For aggregated warnings (e.g. one unknown field seen many times). */
  count?: number;
}

export interface Prompt {
  id: string;
  question: string;
  stage: string;
  priority: number | null;
}

/**
 * What happened to one raw input record. Every record the loader can delimit
 * (a JSONL line or a JSON array entry) gets exactly one disposition.
 */
export type RecordDispositionKind =
  | "retained" // kept as a unique response (any status, including error)
  | "malformed" // not valid JSON, or not a JSON object
  | "invalid" // valid object but a required field was missing or invalid
  | "exact_duplicate" // same ID and identical content as a retained record
  | "conflicting_duplicate"; // same ID as a retained record, different content

export interface RecordDisposition {
  file: string;
  recordIndex: number;
  line: number | null;
  responseId: string | null;
  disposition: RecordDispositionKind;
  /** Warning that explains a non-retained disposition; null for retained records. */
  warningCode: WarningCode | null;
}

/**
 * Record-level accounting invariant:
 *   rawRecords === retained + malformed + invalid + exactDuplicates + conflictingDuplicates
 * and there is exactly one disposition per raw record; the count of each
 * disposition kind equals its counter; retained dispositions list exactly the
 * retained responses, in order, once each, with no warning code; every
 * duplicate refers to a retained response ID; and every non-retained
 * disposition has a matching warning at the same file and location.
 */
export interface RecordAccounting {
  rawRecords: number;
  retained: number;
  malformed: number;
  invalid: number;
  exactDuplicates: number;
  conflictingDuplicates: number;
  balanced: boolean;
  /** Human-readable reasons the invariant fails; empty when balanced. */
  problems: string[];
}

export interface LoadStats {
  responseFiles: string[];
  ignoredFiles: string[];
  /**
   * File-level failures. These are kept separate from per-record dispositions:
   * their records cannot be counted, so they cannot appear in the ledger.
   *
   * unsplittableFiles: response files that could not be split into records
   * (e.g. a broken JSON array).
   * unreadableFiles: files in the data directory that could not be read at all,
   * including broken symlinks (set by loadDataset; empty from parseResponseFiles).
   * nestedResponseFiles: response-like files found in subdirectories, which are
   * not loaded (set by loadDataset; empty from parseResponseFiles).
   */
  unsplittableFiles: string[];
  unreadableFiles: string[];
  nestedResponseFiles: string[];
  /** Every record entry encountered, including malformed lines. */
  rawRecords: number;
  /** Lines/entries that were not valid JSON or not objects. */
  malformedRecords: number;
  /** Valid JSON objects skipped because a required field was missing or invalid. */
  invalidRecords: number;
  exactDuplicates: number;
  conflictingDuplicates: number;
  /** Retained unique responses (any status). */
  uniqueResponses: number;
  byStatus: Record<ResponseStatus, number>;
  /**
   * True only when the record ledger balances (accounting.balanced) AND there
   * are no unsplittable, unreadable or nested response files. A balanced ledger
   * alone cannot vouch for records in files that were never split or loaded.
   */
  allRecordsAccountedFor: boolean;
  /** Record-level ledger only; see allRecordsAccountedFor for the whole input. */
  accounting: RecordAccounting;
}

export interface LoadResult {
  responses: NormalizedResponse[];
  warnings: DataQualityWarning[];
  stats: LoadStats;
  /** One entry per raw record, in input order. */
  dispositions: RecordDisposition[];
}

export interface Dataset extends LoadResult {
  dataDir: string;
  prompts: Prompt[];
}

/** The collection plan: which slots should exist. Loaded from config/expected-dataset.json. */
export interface ExpectedDataset {
  weeks: number[];
  engines: EngineId[];
  promptIds: string[];
  runs: number[];
}

export interface SlotRef {
  engine: EngineId;
  promptId: string;
  run: number;
}

/**
 * Coverage at one level. "Observed" counts a slot once any record exists for
 * it, whatever its status. "Usable" counts a slot only when it has an answer
 * with status "ok". An errored record therefore fills an observed slot but
 * leaves the usable slot missing.
 */
export interface CoverageLevel {
  slots: number;
  missingSlots: SlotRef[];
  /** Expected engines with no slot at this level this week. */
  missingEngines: EngineId[];
  /** Expected prompts with no slot at this level on any engine/run this week. */
  missingPrompts: string[];
  /** Expected runs with no slot at this level on any engine/prompt this week. */
  missingRuns: number[];
  complete: boolean;
}

export interface EngineCoverage {
  engine: EngineId;
  expectedSlots: number;
  observedSlots: number;
  usableSlots: number;
}

export interface WeekCoverage {
  week: number;
  /** False when the week is outside the expectation but records exist for it. */
  expectedWeek: boolean;
  /** No records at all for this week. */
  weekMissing: boolean;
  expectedSlots: number;
  observed: CoverageLevel;
  usable: CoverageLevel;
  /** Observed slots with no usable answer (only error/empty records). */
  unusableSlots: SlotRef[];
  byEngine: EngineCoverage[];
  /** Records in this week outside the expected engines/prompts/runs, or with no run number. */
  unslottedRecords: string[];
}

export type ExpectationSource = "config" | "inferred";

export interface CoverageReport {
  expected: ExpectedDataset & {
    /** Where each dimension's expectation came from. Inferred dimensions cannot reveal values absent from all data. */
    source: Record<keyof ExpectedDataset, ExpectationSource>;
  };
  /** Values seen in the data that the expectation does not include. */
  unexpected: {
    weeks: number[];
    engines: EngineId[];
    promptIds: string[];
    runs: number[];
    recordsWithoutRun: string[];
  };
  weeks: WeekCoverage[];
}
