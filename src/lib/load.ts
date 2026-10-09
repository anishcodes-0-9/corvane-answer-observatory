/**
 * Loader: raw data-pack files → normalised responses + data-quality warnings.
 *
 * Rules:
 * - File format is detected from content (JSON array, JSONL, a single object,
 *   or an object wrapping one array of records), never from the extension.
 * - Nothing is dropped silently. Every skipped record produces a warning with
 *   its file and line/record index, and LoadStats.allRecordsAccountedFor checks
 *   that the counts add up.
 * - Weeks come only from the explicit `week` field, never from timestamps.
 * - Error records (e.g. timeouts) are kept with status "error".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CoverageLevel,
  CoverageReport,
  DataQualityWarning,
  Dataset,
  EngineCoverage,
  EngineId,
  ExpectationSource,
  ExpectedDataset,
  KnownEngineId,
  LoadResult,
  LoadStats,
  NormalizedResponse,
  Prompt,
  RecordAccounting,
  RecordDisposition,
  ResponseStatus,
  SlotRef,
  SourceLocation,
  TimestampFormat,
  WarningCode,
  WarningSeverity,
  WeekCoverage,
} from "./types";

export interface InputFile {
  name: string;
  content: string;
}

export interface ParseOptions {
  /** Prompt IDs from prompts.csv. When given, unknown prompt IDs produce warnings. */
  knownPromptIds?: readonly string[];
}

// Field aliases, in priority order: when several are present the first wins.
const TEXT_FIELDS = ["response_text", "answer", "text", "content"] as const;
const CITATION_FIELDS = ["citations", "sources"] as const;
const RUN_FIELDS = ["run", "run_number"] as const;
const TIMESTAMP_FIELDS = ["collected_at", "collected"] as const;

const KNOWN_FIELDS = new Set<string>([
  "response_id",
  "week",
  "engine",
  "prompt_id",
  "error",
  ...TEXT_FIELDS,
  ...CITATION_FIELDS,
  ...RUN_FIELDS,
  ...TIMESTAMP_FIELDS,
]);

// Files in the data pack that are not responses.
const AUXILIARY_FILE = /^(prompts\.csv|brands\.json|facts\.json|readme(\..*)?)$/i;
const RESPONSE_FILE_NAME = /^responses/i;

/**
 * A file holds responses if it is named like one or mentions response_id
 * anywhere (quoted or not). Checking the raw text means a corrupted or
 * unsupported-format response file (e.g. a CSV export) is parsed and reported
 * record by record rather than quietly ignored.
 */
function looksLikeResponseFile(name: string, content: string): boolean {
  return RESPONSE_FILE_NAME.test(name) || /\bresponse_id\b/.test(content);
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

const ENGINE_ALIASES: Record<string, KnownEngineId> = {
  chatgpt: "chatgpt",
  openaichatgpt: "chatgpt",
  perplexity: "perplexity",
  perplexityai: "perplexity",
  aioverview: "google_ai_overview",
  aioverviews: "google_ai_overview",
  googleaioverview: "google_ai_overview",
  googleaioverviews: "google_ai_overview",
};

/** Canonical engine IDs the loader recognises, in a stable order. */
export const KNOWN_ENGINE_IDS: readonly KnownEngineId[] = ["chatgpt", "perplexity", "google_ai_overview"];

export function canonicalEngine(label: string): { id: EngineId; known: boolean } {
  const key = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = ENGINE_ALIASES[key];
  if (known) return { id: known, known: true };
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return { id: slug || "unknown", known: false };
}

// ---------------------------------------------------------------------------
// HTML entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decodes HTML entities in one pass (so "&amp;amp;" becomes "&amp;", not "&"). */
export function decodeHtmlEntities(input: string): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = input.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid =
        Number.isFinite(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    unknown.push(match);
    return match;
  });
  return { text, unknown };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function utcMillis(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const d = new Date(t);
  // Rejects dates like 31/02 that Date.UTC would silently roll over.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return t;
}

/**
 * Parses ISO 8601 (with or without offset) and DD/MM/YYYY HH:mm[:ss].
 * Timestamps without an offset are interpreted as UTC.
 * DD/MM (not MM/DD) is assumed: in the case-study data, week 4's 07/09–08/09
 * only fits between week 3 (31 Aug) and week 5 (14 Sep) when read as day/month.
 */
export function parseTimestamp(raw: string): { iso: string | null; format: TimestampFormat } {
  const value = raw.trim();
  const iso = ISO_RE.exec(value);
  if (iso) {
    const [, y, mo, d, h, mi, s, frac, offset] = iso;
    const ms = frac ? Number((frac + "00").slice(0, 3)) : 0;
    const local = utcMillis(+y!, +mo!, +d!, +h!, +mi!, s ? +s : 0, ms);
    if (local === null) return { iso: null, format: "unparsed" };
    if (!offset) return { iso: new Date(local).toISOString(), format: "iso_naive" };
    if (offset.toUpperCase() === "Z") return { iso: new Date(local).toISOString(), format: "iso_offset" };
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4));
    if (offH > 23 || offM > 59) return { iso: null, format: "unparsed" };
    const utc = local - sign * (offH * 60 + offM) * 60_000;
    return { iso: new Date(utc).toISOString(), format: "iso_offset" };
  }
  const dmy = DMY_RE.exec(value);
  if (dmy) {
    const [, d, mo, y, h, mi, s] = dmy;
    const t = utcMillis(+y!, +mo!, +d!, +h!, +mi!, s ? +s : 0, 0);
    return t === null ? { iso: null, format: "unparsed" } : { iso: new Date(t).toISOString(), format: "dmy" };
  }
  return { iso: null, format: "unparsed" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so key order never makes two identical records look different. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function firstPresent(obj: JsonObject, fields: readonly string[]): { field: string; value: Json } | null {
  for (const field of fields) {
    if (field in obj && obj[field] !== null && obj[field] !== undefined) {
      return { field, value: obj[field]! };
    }
  }
  return null;
}

function scalarToString(value: Json | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parsePositiveInt(value: Json | undefined, allowWeekPrefix = false): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 ? value : null;
  if (typeof value === "string") {
    const re = allowWeekPrefix ? /^\s*(?:week\s*)?(\d+)\s*$/i : /^\s*(\d+)\s*$/;
    const m = re.exec(value);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 ? n : null;
  }
  return null;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// ---------------------------------------------------------------------------
// Container parsing (format detection from content)
// ---------------------------------------------------------------------------

type Entry =
  | { ok: true; value: unknown; recordIndex: number; line: number | null }
  | { ok: false; error: string; recordIndex: number; line: number | null };

type Container =
  | { kind: "array" | "jsonl" | "single" | "wrapped"; entries: Entry[]; note?: string }
  | { kind: "empty" }
  | { kind: "invalid"; error: string }
  | { kind: "not_records"; note: string };

function parseContainer(rawContent: string): Container {
  const content = rawContent.replace(/^﻿/, "");
  const trimmed = content.trim();
  if (trimmed === "") return { kind: "empty" };

  let whole: unknown;
  let wholeError: string | null = null;
  try {
    whole = JSON.parse(trimmed);
  } catch (e) {
    wholeError = (e as Error).message;
  }

  if (wholeError === null) {
    if (Array.isArray(whole)) {
      return {
        kind: "array",
        entries: whole.map((value, i) => ({ ok: true as const, value, recordIndex: i, line: null })),
      };
    }
    if (isObject(whole)) {
      if ("response_id" in whole) {
        return { kind: "single", entries: [{ ok: true, value: whole, recordIndex: 0, line: 1 }] };
      }
      const arrays = Object.entries(whole).filter(
        ([, v]) => Array.isArray(v) && v.length > 0 && v.every(isObject),
      );
      if (arrays.length === 1) {
        const [key, arr] = arrays[0]!;
        return {
          kind: "wrapped",
          note: `records read from the "${key}" property`,
          entries: (arr as unknown[]).map((value, i) => ({ ok: true as const, value, recordIndex: i, line: null })),
        };
      }
      return { kind: "not_records", note: "JSON object without response records" };
    }
    return { kind: "not_records", note: "JSON value is not an array or object" };
  }

  // A JSON array that does not parse cannot be split into records safely.
  if (trimmed.startsWith("[")) return { kind: "invalid", error: wholeError };

  // Otherwise treat as line-delimited JSON; each bad line is reported on its own.
  const entries: Entry[] = [];
  const lines = content.split(/\r?\n/);
  let recordIndex = 0;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      entries.push({ ok: true, value: JSON.parse(line), recordIndex, line: i + 1 });
    } catch (e) {
      entries.push({ ok: false, error: (e as Error).message, recordIndex, line: i + 1 });
    }
    recordIndex += 1;
  });
  return { kind: "jsonl", entries };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

class WarningSink {
  readonly items: DataQualityWarning[] = [];
  add(code: WarningCode, severity: WarningSeverity, message: string, extra: Partial<DataQualityWarning> = {}) {
    this.items.push({ code, severity, message, ...extra });
  }
}

/** Per-file aggregation so repetitive issues produce one warning, not hundreds. */
class FileAggregates {
  unknownFields = new Map<string, number>();
  unknownEngines = new Map<string, { slug: string; count: number }>();
  unknownPrompts = new Map<string, number>();
  normalizedPrompts = new Map<string, { to: string; count: number }>();
  naiveTimestamps = { count: 0, formats: new Set<TimestampFormat>() };
  missingTimestamps = 0;
  unknownEntities = new Map<string, number>();

  flush(file: string, warnings: WarningSink) {
    for (const [field, count] of this.unknownFields) {
      warnings.add("unknown_field", "warn", `Unrecognised field "${field}" ignored`, { file, count });
    }
    for (const [label, { slug, count }] of this.unknownEngines) {
      warnings.add("unknown_engine", "warn", `Unknown engine "${label}" kept as "${slug}"`, { file, count });
    }
    for (const [id, count] of this.unknownPrompts) {
      warnings.add("unknown_prompt", "warn", `Prompt ID "${id}" is not in prompts.csv; records kept`, { file, count });
    }
    for (const [from, { to, count }] of this.normalizedPrompts) {
      warnings.add("prompt_id_normalized", "info", `Prompt ID "${from}" normalised to "${to}"`, { file, count });
    }
    if (this.missingTimestamps > 0) {
      warnings.add(
        "missing_timestamp",
        "info",
        "No timestamp (field absent or null); record kept with collectedAt = null. Weeks come from the week field, not timestamps",
        { file, count: this.missingTimestamps },
      );
    }
    if (this.naiveTimestamps.count > 0) {
      const formats = [...this.naiveTimestamps.formats].sort().join(", ");
      warnings.add(
        "naive_timestamp",
        "info",
        `Timestamps without a time zone (${formats}) interpreted as UTC; DD/MM/YYYY assumed for slash dates`,
        { file, count: this.naiveTimestamps.count },
      );
    }
    for (const [entity, count] of this.unknownEntities) {
      warnings.add("unknown_html_entity", "info", `Unknown HTML entity ${entity} left as-is`, { file, count });
    }
  }
}

interface Context {
  warnings: WarningSink;
  agg: FileAggregates;
  knownPrompts: Set<string> | null;
}

function normalizePromptId(raw: string, ctx: Context): string {
  const upper = raw.trim().toUpperCase();
  if (!ctx.knownPrompts || ctx.knownPrompts.has(upper)) return upper;
  // Match "P1" to a known "P01" (same prefix and number).
  const m = /^([A-Z]*)0*(\d+)$/.exec(upper);
  if (m) {
    for (const known of ctx.knownPrompts) {
      const k = /^([A-Z]*)0*(\d+)$/.exec(known);
      if (k && k[1] === m[1] && Number(k[2]) === Number(m[2])) {
        const entry = ctx.agg.normalizedPrompts.get(raw) ?? { to: known, count: 0 };
        entry.count += 1;
        ctx.agg.normalizedPrompts.set(raw, entry);
        return known;
      }
    }
  }
  ctx.agg.unknownPrompts.set(upper, (ctx.agg.unknownPrompts.get(upper) ?? 0) + 1);
  return upper;
}

/** Returns the normalised response, or the warning code explaining why the record was skipped. */
function normalizeRecord(
  obj: JsonObject,
  loc: SourceLocation,
  ctx: Context,
): NormalizedResponse | { skipped: WarningCode } {
  const where = { file: loc.file, line: loc.line, recordIndex: loc.recordIndex };
  const id = scalarToString(obj.response_id);
  const engineLabel = scalarToString(obj.engine);
  const promptRaw = scalarToString(obj.prompt_id);
  const missing = [
    id === null && "response_id",
    obj.week === undefined || obj.week === null ? "week" : false,
    engineLabel === null && "engine",
    promptRaw === null && "prompt_id",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    ctx.warnings.add(
      "missing_required_field",
      "error",
      `Record skipped: missing or empty ${missing.join(", ")}`,
      { ...where, ...(id ? { responseIds: [id] } : {}) },
    );
    return { skipped: "missing_required_field" };
  }
  const week = parsePositiveInt(obj.week, true);
  if (week === null) {
    ctx.warnings.add("invalid_week", "error", `Record skipped: week ${JSON.stringify(obj.week)} is not a positive integer`, {
      ...where,
      responseIds: [id!],
    });
    return { skipped: "invalid_week" };
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) ctx.agg.unknownFields.set(key, (ctx.agg.unknownFields.get(key) ?? 0) + 1);
  }

  const engine = canonicalEngine(engineLabel!);
  if (!engine.known) {
    const entry = ctx.agg.unknownEngines.get(engineLabel!) ?? { slug: engine.id, count: 0 };
    entry.count += 1;
    ctx.agg.unknownEngines.set(engineLabel!, entry);
  }

  const promptId = normalizePromptId(promptRaw!, ctx);

  // Run
  let run: number | null = null;
  const runField = firstPresent(obj, RUN_FIELDS);
  if (runField) run = parsePositiveInt(runField.value);
  if (run === null) {
    ctx.warnings.add(
      "invalid_run",
      "warn",
      runField
        ? `Run ${JSON.stringify(runField.value)} is not a positive integer; record kept with run = null`
        : "No run number; record kept with run = null",
      { ...where, responseIds: [id!] },
    );
  }

  // Timestamp
  let collectedAt: string | null = null;
  let collectedAtRaw: string | null = null;
  let timestampFormat: TimestampFormat | null = null;
  const tsField = firstPresent(obj, TIMESTAMP_FIELDS);
  if (tsField) {
    collectedAtRaw = typeof tsField.value === "string" ? tsField.value : JSON.stringify(tsField.value);
    const parsed = typeof tsField.value === "string" ? parseTimestamp(tsField.value) : { iso: null, format: "unparsed" as const };
    collectedAt = parsed.iso;
    timestampFormat = parsed.format;
    if (parsed.iso === null) {
      ctx.warnings.add("unparseable_timestamp", "warn", `Timestamp ${JSON.stringify(collectedAtRaw)} could not be parsed`, {
        ...where,
        responseIds: [id!],
      });
    } else if (parsed.format === "iso_naive" || parsed.format === "dmy") {
      ctx.agg.naiveTimestamps.count += 1;
      ctx.agg.naiveTimestamps.formats.add(parsed.format);
    }
  } else {
    ctx.agg.missingTimestamps += 1;
  }

  // Text
  const textFields = TEXT_FIELDS.filter((f) => f in obj && obj[f] !== null && obj[f] !== undefined);
  let rawText = "";
  if (textFields.length > 0) {
    const value = obj[textFields[0]!];
    rawText = typeof value === "string" ? value : "";
    const distinct = new Set(textFields.map((f) => (typeof obj[f] === "string" ? obj[f] : stableStringify(obj[f]))));
    if (distinct.size > 1) {
      ctx.warnings.add(
        "conflicting_text_fields",
        "warn",
        `Several answer-text fields with different values (${textFields.join(", ")}); using "${textFields[0]}"`,
        { ...where, responseIds: [id!] },
      );
    }
    if (typeof value !== "string") {
      ctx.warnings.add("invalid_text_field", "warn", `Answer field "${textFields[0]}" is not a string; treated as empty`, {
        ...where,
        responseIds: [id!],
      });
    }
  }
  const decoded = decodeHtmlEntities(rawText);
  for (const entity of decoded.unknown) {
    ctx.agg.unknownEntities.set(entity, (ctx.agg.unknownEntities.get(entity) ?? 0) + 1);
  }

  // Citations
  let citations: string[] = [];
  const citeField = firstPresent(obj, CITATION_FIELDS);
  if (citeField) {
    if (Array.isArray(citeField.value)) {
      const strings = citeField.value.filter((c): c is string => typeof c === "string" && c.trim() !== "");
      citations = strings.map((c) => c.trim());
      if (strings.length !== citeField.value.length) {
        ctx.warnings.add("invalid_citations", "warn", `Non-string or blank citation entries dropped from "${citeField.field}"`, {
          ...where,
          responseIds: [id!],
        });
      }
    } else if (typeof citeField.value === "string" && citeField.value.trim() !== "") {
      citations = [citeField.value.trim()];
      ctx.warnings.add("invalid_citations", "info", `"${citeField.field}" was a single string; treated as one citation`, {
        ...where,
        responseIds: [id!],
      });
    } else {
      ctx.warnings.add("invalid_citations", "warn", `"${citeField.field}" is not a list; treated as no citations`, {
        ...where,
        responseIds: [id!],
      });
    }
  }

  // Status. An error label always wins: a timeout is never a valid empty answer.
  const errorValue = obj.error;
  const errorLabel =
    errorValue === undefined || errorValue === null || errorValue === false || errorValue === ""
      ? null
      : typeof errorValue === "string"
        ? errorValue
        : stableStringify(errorValue);
  let status: ResponseStatus;
  if (errorLabel !== null) {
    status = "error";
    ctx.warnings.add("error_record", "warn", `Collector error "${errorLabel}"; kept with status "error"`, {
      ...where,
      responseIds: [id!],
    });
    if (decoded.text.trim() !== "") {
      ctx.warnings.add("error_with_text", "warn", "Record has an error label but also answer text; treated as an error", {
        ...where,
        responseIds: [id!],
      });
    }
  } else if (decoded.text.trim() === "") {
    status = "empty";
    ctx.warnings.add("empty_text", "warn", "No error reported but the answer text is empty", {
      ...where,
      responseIds: [id!],
    });
  } else {
    status = "ok";
  }

  return {
    id: id!,
    week,
    engine: engine.id,
    engineLabel: engineLabel!,
    promptId,
    promptIdRaw: promptRaw!,
    run,
    collectedAt,
    collectedAtRaw,
    timestampFormat,
    rawText,
    text: decoded.text,
    citations,
    status,
    error: errorLabel,
    source: loc,
  };
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure parser over in-memory files. Files are processed in name order so the
 * result does not depend on directory listing order.
 */
export function parseResponseFiles(files: readonly InputFile[], options: ParseOptions = {}): LoadResult {
  const warnings = new WarningSink();
  const knownPrompts = options.knownPromptIds ? new Set(options.knownPromptIds.map((p) => p.trim().toUpperCase())) : null;
  const responses: NormalizedResponse[] = [];
  const byId = new Map<string, { canonical: string; source: SourceLocation }>();
  const responseFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const unsplittableFiles: string[] = [];
  const dispositions: RecordDisposition[] = [];
  let rawRecords = 0;
  let malformedRecords = 0;
  let invalidRecords = 0;
  let exactDuplicates = 0;
  let conflictingDuplicates = 0;

  const sorted = [...files].sort((a, b) => compareNames(a.name, b.name));
  for (const file of sorted) {
    if (file.name.startsWith(".") || AUXILIARY_FILE.test(file.name)) {
      ignoredFiles.push(file.name);
      warnings.add("ignored_file", "info", `Not a response file; ignored`, { file: file.name });
      continue;
    }
    if (!looksLikeResponseFile(file.name, file.content)) {
      ignoredFiles.push(file.name);
      warnings.add("ignored_file", "info", "No response records found; ignored", { file: file.name });
      continue;
    }
    responseFiles.push(file.name);

    const container = parseContainer(file.content);
    if (container.kind === "invalid") {
      unsplittableFiles.push(file.name);
      warnings.add("malformed_file", "error", `File is not valid JSON and could not be split into records: ${container.error}`, {
        file: file.name,
      });
      continue;
    }
    if (container.kind === "empty") {
      warnings.add("malformed_file", "warn", "Response file is empty", { file: file.name });
      continue;
    }
    if (container.kind === "not_records") {
      unsplittableFiles.push(file.name);
      warnings.add("malformed_file", "error", `No records could be read: ${container.note}`, { file: file.name });
      continue;
    }
    if (container.kind === "wrapped") {
      warnings.add("format_note", "info", `Wrapped JSON: ${container.note}`, { file: file.name });
    }
    const ctx: Context = { warnings, agg: new FileAggregates(), knownPrompts };
    let fileRecords = 0;
    let fileNew = 0;
    let fileExactDuplicates = 0;

    for (const entry of container.entries) {
      rawRecords += 1;
      fileRecords += 1;
      const loc: SourceLocation = { file: file.name, recordIndex: entry.recordIndex, line: entry.line };
      const where = { file: loc.file, line: loc.line, recordIndex: loc.recordIndex };
      const dispose = (
        disposition: RecordDisposition["disposition"],
        responseId: string | null,
        warningCode: WarningCode | null,
      ) => dispositions.push({ ...where, responseId, disposition, warningCode });

      if (!entry.ok) {
        malformedRecords += 1;
        warnings.add("malformed_record", "error", `Record skipped: invalid JSON (${entry.error})`, where);
        dispose("malformed", null, "malformed_record");
        continue;
      }
      if (!isObject(entry.value)) {
        malformedRecords += 1;
        warnings.add("not_an_object", "error", "Record skipped: not a JSON object", where);
        dispose("malformed", null, "not_an_object");
        continue;
      }
      const obj = entry.value;
      const id = scalarToString(obj.response_id);
      const previous = id !== null ? byId.get(id) : undefined;
      if (id !== null && previous) {
        const canonical = stableStringify(obj);
        const first = `${previous.source.file} ${previous.source.line !== null ? `line ${previous.source.line}` : `record ${previous.source.recordIndex}`}`;
        if (canonical === previous.canonical) {
          exactDuplicates += 1;
          fileExactDuplicates += 1;
          warnings.add("duplicate_exact", "warn", `Exact duplicate of ${id} (first seen at ${first}); copy dropped`, {
            ...where,
            responseIds: [id],
          });
          dispose("exact_duplicate", id, "duplicate_exact");
        } else {
          conflictingDuplicates += 1;
          warnings.add(
            "duplicate_conflict",
            "error",
            `Response ID ${id} reused with different content (first seen at ${first}); first record kept, this one dropped`,
            { ...where, responseIds: [id] },
          );
          dispose("conflicting_duplicate", id, "duplicate_conflict");
        }
        continue;
      }
      const normalized = normalizeRecord(obj, loc, ctx);
      if ("skipped" in normalized) {
        invalidRecords += 1;
        dispose("invalid", id, normalized.skipped);
        continue;
      }
      byId.set(normalized.id, { canonical: stableStringify(obj), source: loc });
      responses.push(normalized);
      dispose("retained", normalized.id, null);
      fileNew += 1;
    }
    ctx.agg.flush(file.name, warnings);
    if (fileRecords > 0 && fileNew === 0 && fileExactDuplicates === fileRecords) {
      warnings.add("duplicate_file", "warn", "Every record in this file duplicates an earlier file (same data loaded twice?)", {
        file: file.name,
        count: fileRecords,
      });
    }
  }

  // Two different IDs in the same week/engine/prompt/run slot.
  const slots = new Map<string, string[]>();
  for (const r of responses) {
    if (r.run === null) continue;
    const key = `${r.week}|${r.engine}|${r.promptId}|${r.run}`;
    const ids = slots.get(key) ?? [];
    ids.push(r.id);
    slots.set(key, ids);
  }
  for (const [key, ids] of slots) {
    if (ids.length > 1) {
      const [week, engine, prompt, run] = key.split("|");
      warnings.add(
        "duplicate_slot",
        "warn",
        `Week ${week} ${engine} ${prompt} run ${run} has ${ids.length} different response IDs; all kept`,
        { responseIds: ids },
      );
    }
  }

  const byStatus: Record<ResponseStatus, number> = { ok: 0, error: 0, empty: 0 };
  for (const r of responses) byStatus[r.status] += 1;
  const accounting = verifyRecordAccounting({
    rawRecords,
    counts: { malformedRecords, invalidRecords, exactDuplicates, conflictingDuplicates },
    responses,
    dispositions,
    warnings: warnings.items,
  });
  const stats: LoadStats = {
    responseFiles,
    ignoredFiles,
    unsplittableFiles,
    unreadableFiles: [],
    nestedResponseFiles: [],
    rawRecords,
    malformedRecords,
    invalidRecords,
    exactDuplicates,
    conflictingDuplicates,
    uniqueResponses: responses.length,
    byStatus,
    allRecordsAccountedFor: inputFullyAccounted(accounting, { unsplittableFiles, unreadableFiles: [], nestedResponseFiles: [] }),
    accounting,
  };
  return { responses, warnings: warnings.items, stats, dispositions };
}

/**
 * The whole input is accounted for only when the record ledger balances AND no
 * file failed before its records could be counted. A balanced ledger alone says
 * nothing about records inside a broken or unreadable file.
 */
function inputFullyAccounted(
  accounting: RecordAccounting,
  failures: { unsplittableFiles: readonly string[]; unreadableFiles: readonly string[]; nestedResponseFiles: readonly string[] },
): boolean {
  return (
    accounting.balanced &&
    failures.unsplittableFiles.length === 0 &&
    failures.unreadableFiles.length === 0 &&
    failures.nestedResponseFiles.length === 0
  );
}

/**
 * Checks the accounting invariant independently of the counters that produced
 * it: the counts must sum to rawRecords, the disposition ledger must agree
 * with the counts and with the retained responses, and every dropped record
 * must have a warning at the same location. Exported so tests can feed it
 * tampered input.
 */
export function verifyRecordAccounting(input: {
  rawRecords: number;
  counts: { malformedRecords: number; invalidRecords: number; exactDuplicates: number; conflictingDuplicates: number };
  responses: readonly NormalizedResponse[];
  dispositions: readonly RecordDisposition[];
  warnings: readonly DataQualityWarning[];
}): RecordAccounting {
  const { rawRecords, counts, responses, dispositions, warnings } = input;
  const problems: string[] = [];
  const tally = (kind: RecordDisposition["disposition"]) => dispositions.filter((d) => d.disposition === kind).length;

  const summed =
    responses.length + counts.malformedRecords + counts.invalidRecords + counts.exactDuplicates + counts.conflictingDuplicates;
  if (summed !== rawRecords) problems.push(`counts sum to ${summed} but ${rawRecords} raw records were read`);
  if (dispositions.length !== rawRecords) {
    problems.push(`${dispositions.length} dispositions recorded for ${rawRecords} raw records`);
  }
  const pairs: Array<[RecordDisposition["disposition"], number, string]> = [
    ["retained", responses.length, "retained responses"],
    ["malformed", counts.malformedRecords, "malformed count"],
    ["invalid", counts.invalidRecords, "invalid count"],
    ["exact_duplicate", counts.exactDuplicates, "exact duplicate count"],
    ["conflicting_duplicate", counts.conflictingDuplicates, "conflicting duplicate count"],
  ];
  for (const [kind, expected, label] of pairs) {
    const n = tally(kind);
    if (n !== expected) problems.push(`${n} "${kind}" dispositions but ${label} is ${expected}`);
  }

  const retainedIds = dispositions.filter((d) => d.disposition === "retained").map((d) => d.responseId);
  const responseIds = responses.map((r) => r.id);
  if (retainedIds.length !== new Set(retainedIds).size) problems.push("a response ID was retained more than once");
  if (retainedIds.join("\u0000") !== responseIds.join("\u0000")) {
    problems.push("retained dispositions do not match the retained responses");
  }
  const retainedSet = new Set(retainedIds);

  for (const d of dispositions) {
    const at = `${d.file} ${d.line !== null ? `line ${d.line}` : `record ${d.recordIndex}`}`;
    if (d.disposition === "retained") {
      if (d.warningCode !== null) problems.push(`retained record at ${at} carries drop warning ${d.warningCode}`);
      continue;
    }
    // A duplicate is only a duplicate of something that was kept.
    if ((d.disposition === "exact_duplicate" || d.disposition === "conflicting_duplicate") && !retainedSet.has(d.responseId)) {
      problems.push(`${d.disposition} record at ${at} refers to ${d.responseId ?? "(no ID)"}, which was not retained`);
    }
    const explained = warnings.some(
      (w) => w.code === d.warningCode && w.file === d.file && w.recordIndex === d.recordIndex && (w.line ?? null) === d.line,
    );
    if (!explained) {
      problems.push(`${d.disposition} record at ${at} has no matching ${d.warningCode ?? "(none)"} warning`);
    }
  }

  return {
    rawRecords,
    retained: responses.length,
    malformed: counts.malformedRecords,
    invalid: counts.invalidRecords,
    exactDuplicates: counts.exactDuplicates,
    conflictingDuplicates: counts.conflictingDuplicates,
    balanced: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = content.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function parsePromptsCsv(content: string, file = "prompts.csv"): { prompts: Prompt[]; warnings: DataQualityWarning[] } {
  const warnings = new WarningSink();
  const rows = parseCsv(content);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idCol = col("prompt_id");
  if (idCol < 0) {
    warnings.add("prompts_malformed", "error", 'prompts.csv has no "prompt_id" column; prompt checks disabled', { file });
    return { prompts: [], warnings: warnings.items };
  }
  const prompts: Prompt[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, i) => {
    const id = (cells[idCol] ?? "").trim().toUpperCase();
    if (!id) {
      warnings.add("prompts_malformed", "warn", "Row without a prompt_id skipped", { file, line: i + 2 });
      return;
    }
    if (seen.has(id)) {
      warnings.add("prompts_malformed", "warn", `Duplicate prompt_id ${id}; first row kept`, { file, line: i + 2 });
      return;
    }
    seen.add(id);
    const priority = parsePositiveInt((cells[col("priority")] ?? "").trim());
    prompts.push({
      id,
      question: (cells[col("question")] ?? "").trim(),
      stage: (cells[col("stage")] ?? "").trim(),
      priority,
    });
  });
  return { prompts, warnings: warnings.items };
}

// ---------------------------------------------------------------------------
// Expected dataset (collection plan)
// ---------------------------------------------------------------------------

export const DEFAULT_EXPECTED_CONFIG = "config/expected-dataset.json";

/** Validates an expected-dataset config. Returns null plus error warnings if it is unusable. */
export function parseExpectedDataset(
  value: unknown,
  file = DEFAULT_EXPECTED_CONFIG,
): { expected: ExpectedDataset | null; warnings: DataQualityWarning[] } {
  const warnings = new WarningSink();
  const fail = (message: string) => {
    warnings.add("expected_config_invalid", "error", message, { file });
    return { expected: null, warnings: warnings.items };
  };
  if (!isObject(value)) return fail("Expected-dataset config must be a JSON object");

  const positiveInts = (key: string): number[] | null => {
    const v = value[key];
    if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1)) {
      return null;
    }
    const unique = [...new Set(v as number[])].sort((a, b) => a - b);
    if (unique.length !== v.length) {
      warnings.add("expected_config_invalid", "warn", `Duplicate values in "${key}" collapsed`, { file });
    }
    return unique;
  };
  const strings = (key: string): string[] | null => {
    const v = value[key];
    if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === "string" && s.trim() !== "")) return null;
    return v as string[];
  };

  const weeks = positiveInts("weeks");
  if (!weeks) return fail('"weeks" must be a non-empty list of positive integers');
  const runs = positiveInts("runs");
  if (!runs) return fail('"runs" must be a non-empty list of positive integers');
  const engineLabels = strings("engines");
  if (!engineLabels) return fail('"engines" must be a non-empty list of engine IDs');
  const promptLabels = strings("promptIds");
  if (!promptLabels) return fail('"promptIds" must be a non-empty list of prompt IDs');

  // The plan may only name engines the loader can canonicalise. An unknown label
  // would otherwise become a slug that no record could ever match, and the
  // engine would show as permanently missing instead of as a config mistake.
  const resolved = engineLabels.map((label) => ({ label, ...canonicalEngine(label) }));
  const unsupported = resolved.filter((e) => !e.known).map((e) => JSON.stringify(e.label));
  if (unsupported.length > 0) {
    return fail(
      `Unsupported engine(s) in "engines": ${unsupported.join(", ")}. Supported: ${KNOWN_ENGINE_IDS.join(", ")} ` +
        "(aliases such as \"ChatGPT\" or \"AI Overview\" are accepted). Add new engines to ENGINE_ALIASES in load.ts.",
    );
  }
  const engines = [...new Set(resolved.map((e) => e.id))];
  const promptIds = [...new Set(promptLabels.map((p) => p.trim().toUpperCase()))];

  // Prompt IDs must be single tokens. Anything else ("P 01", "P01;P02") can never
  // match a record, so its slots would show as permanently missing.
  const malformed = promptIds.filter((p) => !/^[A-Z][A-Z0-9_-]*$/.test(p));
  if (malformed.length > 0) {
    return fail(`Malformed prompt ID(s) in "promptIds": ${malformed.map((p) => JSON.stringify(p)).join(", ")}`);
  }
  // The loader pads data prompt IDs to match known prompts ("P1" → "P01"), so
  // "P1" and "P01" in one config would name the same prompt twice, and one of
  // them could never be filled.
  const byNumber = new Map<string, string[]>();
  for (const p of promptIds) {
    const m = /^([A-Z]*)0*(\d+)$/.exec(p);
    const key = m ? `${m[1]}#${Number(m[2])}` : p;
    byNumber.set(key, [...(byNumber.get(key) ?? []), p]);
  }
  const ambiguous = [...byNumber.values()].filter((ids) => ids.length > 1);
  if (ambiguous.length > 0) {
    return fail(`Prompt IDs that differ only by zero-padding name the same prompt: ${ambiguous.map((g) => g.join(" / ")).join("; ")}`);
  }
  if (engines.length !== engineLabels.length) {
    warnings.add("expected_config_invalid", "warn", "Duplicate engines in config collapsed", { file });
  }
  if (promptIds.length !== promptLabels.length) {
    warnings.add("expected_config_invalid", "warn", "Duplicate prompt IDs in config collapsed", { file });
  }
  return { expected: { weeks, engines, promptIds, runs }, warnings: warnings.items };
}

/** Reads and validates the expected-dataset config file. */
export function loadExpectedDataset(path = DEFAULT_EXPECTED_CONFIG): {
  expected: ExpectedDataset | null;
  warnings: DataQualityWarning[];
} {
  const file = resolve(expandHome(path));
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return {
      expected: null,
      warnings: [{ code: "expected_config_invalid", severity: "error", message: `Cannot read config: ${(e as Error).message}`, file }],
    };
  }
  try {
    return parseExpectedDataset(JSON.parse(raw), file);
  } catch (e) {
    return {
      expected: null,
      warnings: [{ code: "expected_config_invalid", severity: "error", message: `Config is not valid JSON: ${(e as Error).message}`, file }],
    };
  }
}

/** Warns when prompts.csv and the expected config disagree about which prompts exist. */
export function crossCheckPrompts(expected: ExpectedDataset, prompts: readonly Prompt[]): DataQualityWarning[] {
  if (prompts.length === 0) return [];
  const inCsv = new Set(prompts.map((p) => p.id));
  const inConfig = new Set(expected.promptIds);
  const warnings: DataQualityWarning[] = [];
  const onlyCsv = [...inCsv].filter((p) => !inConfig.has(p));
  const onlyConfig = [...inConfig].filter((p) => !inCsv.has(p));
  if (onlyCsv.length) {
    warnings.push({
      code: "expected_config_mismatch",
      severity: "warn",
      message: `Prompts in prompts.csv but not in the expected config (not covered): ${onlyCsv.join(", ")}`,
    });
  }
  if (onlyConfig.length) {
    warnings.push({
      code: "expected_config_mismatch",
      severity: "warn",
      message: `Prompts in the expected config but not in prompts.csv: ${onlyConfig.join(", ")}`,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * An expectation plus where each dimension came from. Production code builds
 * this only from the validated config (see loadDatasetForAnalysis), where every
 * dimension is "config".
 */
export type CoverageExpectation = ExpectedDataset & {
  source?: Record<keyof ExpectedDataset, ExpectationSource>;
};

/**
 * FOR TESTS AND EXPLORATION ONLY. Fills any dimension not given from the data
 * itself, and marks it "inferred". Inference cannot reveal values missing from
 * every record (an engine never collected, a final week never delivered), so
 * production analysis must use the validated config instead.
 */
export function inferExpectedDataset(
  responses: readonly NormalizedResponse[],
  partial: Partial<ExpectedDataset> = {},
): CoverageExpectation {
  const uniqSorted = <T>(xs: Iterable<T>, cmp: (a: T, b: T) => number) => [...new Set(xs)].sort(cmp);
  const byNumber = (a: number, b: number) => a - b;
  const source = (given: unknown): ExpectationSource => (given ? "config" : "inferred");

  let weeks: number[];
  if (partial.weeks) weeks = [...partial.weeks];
  else {
    const seen = uniqSorted(responses.map((r) => r.week), byNumber);
    weeks =
      seen.length === 0 ? [] : Array.from({ length: seen[seen.length - 1]! - seen[0]! + 1 }, (_, i) => seen[0]! + i);
  }
  return {
    weeks,
    engines: partial.engines ? [...partial.engines] : uniqSorted(responses.map((r) => r.engine), compareNames),
    promptIds: partial.promptIds ? [...partial.promptIds] : uniqSorted(responses.map((r) => r.promptId), compareNames),
    runs: partial.runs
      ? [...partial.runs]
      : uniqSorted(
          responses.map((r) => r.run).filter((r): r is number => r !== null),
          byNumber,
        ),
    source: {
      weeks: source(partial.weeks),
      engines: source(partial.engines),
      promptIds: source(partial.promptIds),
      runs: source(partial.runs),
    },
  };
}

/**
 * Which engine × prompt × run slots exist for each expected week, at two
 * levels: observed (any record) and usable (an "ok" answer). A week is complete
 * only when every expected slot is filled; having some records is not enough.
 *
 * The expectation is required and is never inferred here. Pass the validated
 * config (production) or inferExpectedDataset(...) (tests).
 */
export function buildCoverage(responses: readonly NormalizedResponse[], expectation: CoverageExpectation): CoverageReport {
  const uniqSorted = <T>(xs: Iterable<T>, cmp: (a: T, b: T) => number) => [...new Set(xs)].sort(cmp);
  const byNumber = (a: number, b: number) => a - b;

  const engines = [...new Set(expectation.engines)];
  const promptIds = [...new Set(expectation.promptIds)];
  const runs = uniqSorted(expectation.runs, byNumber);
  const expectedWeeks = uniqSorted(expectation.weeks, byNumber);
  const observedWeeks = uniqSorted(responses.map((r) => r.week), byNumber);
  const sources = expectation.source ?? { weeks: "config", engines: "config", promptIds: "config", runs: "config" };

  const engineSet = new Set<string>(engines);
  const promptSet = new Set(promptIds);
  const runSet = new Set(runs);
  const expectedWeekSet = new Set(expectedWeeks);

  const unexpected = {
    weeks: observedWeeks.filter((w) => !expectedWeekSet.has(w)),
    engines: uniqSorted(
      responses.map((r) => r.engine).filter((e) => !engineSet.has(e)),
      compareNames,
    ),
    promptIds: uniqSorted(
      responses.map((r) => r.promptId).filter((p) => !promptSet.has(p)),
      compareNames,
    ),
    runs: uniqSorted(
      responses.map((r) => r.run).filter((r): r is number => r !== null && !runSet.has(r)),
      byNumber,
    ),
    recordsWithoutRun: responses.filter((r) => r.run === null).map((r) => r.id),
  };

  // Weeks outside the expectation are still reported, so their records are visible.
  const reportWeeks = uniqSorted([...expectedWeeks, ...unexpected.weeks], byNumber);
  const slotKey = (engine: string, promptId: string, run: number) => `${engine}|${promptId}|${run}`;

  const weekCoverage: WeekCoverage[] = reportWeeks.map((week) => {
    const inWeek = responses.filter((r) => r.week === week);
    const slotStatuses = new Map<string, ResponseStatus[]>();
    const unslottedRecords: string[] = [];
    for (const r of inWeek) {
      if (!engineSet.has(r.engine) || !promptSet.has(r.promptId) || r.run === null || !runSet.has(r.run)) {
        unslottedRecords.push(r.id);
        continue;
      }
      const key = slotKey(r.engine, r.promptId, r.run);
      slotStatuses.set(key, [...(slotStatuses.get(key) ?? []), r.status]);
    }
    const isObserved = (s: SlotRef) => slotStatuses.has(slotKey(s.engine, s.promptId, s.run));
    const isUsable = (s: SlotRef) => (slotStatuses.get(slotKey(s.engine, s.promptId, s.run)) ?? []).includes("ok");

    const allSlots: SlotRef[] = engines.flatMap((engine) =>
      promptIds.flatMap((promptId) => runs.map((run) => ({ engine, promptId, run }))),
    );
    const level = (has: (s: SlotRef) => boolean): CoverageLevel => {
      const present = allSlots.filter(has);
      return {
        slots: present.length,
        missingSlots: allSlots.filter((s) => !has(s)),
        missingEngines: engines.filter((e) => !present.some((s) => s.engine === e)),
        missingPrompts: promptIds.filter((p) => !present.some((s) => s.promptId === p)),
        missingRuns: runs.filter((n) => !present.some((s) => s.run === n)),
        complete: allSlots.length > 0 && present.length === allSlots.length,
      };
    };

    const byEngine: EngineCoverage[] = engines.map((engine) => {
      const mine = allSlots.filter((s) => s.engine === engine);
      return {
        engine,
        expectedSlots: mine.length,
        observedSlots: mine.filter(isObserved).length,
        usableSlots: mine.filter(isUsable).length,
      };
    });

    return {
      week,
      expectedWeek: expectedWeekSet.has(week),
      weekMissing: inWeek.length === 0,
      expectedSlots: allSlots.length,
      observed: level(isObserved),
      usable: level(isUsable),
      unusableSlots: allSlots.filter((s) => isObserved(s) && !isUsable(s)),
      byEngine,
      unslottedRecords,
    };
  });

  return {
    expected: {
      weeks: expectedWeeks,
      engines,
      promptIds,
      runs,
      source: { ...sources },
    },
    unexpected,
    weeks: weekCoverage,
  };
}

// ---------------------------------------------------------------------------
// Filesystem entry point
// ---------------------------------------------------------------------------

/** Follows a symlink; null if it is broken or cannot be stat'ed. */
function entryKind(path: string, entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (!entry.isSymbolicLink()) return entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
  try {
    const st = statSync(path);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

const NESTED_SCAN_DEPTH = 5;

/**
 * Lists response-like files below a subdirectory. Subdirectories are NOT loaded
 * (loading is deliberately one level), but response files inside them must not
 * vanish silently, so they are found and reported. Hidden entries are skipped,
 * as at the top level; symlinked directories are not followed (avoids loops).
 */
function findNestedResponseFiles(dirPath: string, relPrefix: string, depth = 1): string[] {
  if (depth > NESTED_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
  } catch {
    return [`${relPrefix}/ (unreadable directory)`];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dirPath, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...findNestedResponseFiles(full, rel, depth + 1));
      continue;
    }
    if (entryKind(full, entry) !== "file" || AUXILIARY_FILE.test(entry.name)) continue;
    let content = "";
    try {
      content = readFileSync(full, "utf8");
    } catch {
      found.push(`${rel} (unreadable)`);
      continue;
    }
    if (looksLikeResponseFile(entry.name, content)) found.push(rel);
  }
  return found;
}

/**
 * Reads every regular file in dataDir (not subdirectories) and loads prompts
 * and responses. Symlinks are followed. Response-like files in subdirectories
 * are not loaded but are reported, and they block allRecordsAccountedFor.
 */
export function loadDataset(dataDir: string): Dataset {
  const dir = resolve(expandHome(dataDir));
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
  const extraWarnings: DataQualityWarning[] = [];
  const files: InputFile[] = [];
  const unreadableFiles: string[] = [];
  const nestedResponseFiles: string[] = [];
  let prompts: Prompt[] = [];
  let promptsFound = false;

  for (const entry of entries) {
    const kind = entryKind(join(dir, entry.name), entry);
    if (kind === null) {
      unreadableFiles.push(entry.name);
      extraWarnings.push({ code: "unreadable_file", severity: "error", message: "Broken symbolic link", file: entry.name });
      continue;
    }
    if (kind === "dir") {
      const nested = entry.name.startsWith(".") ? [] : findNestedResponseFiles(join(dir, entry.name), entry.name);
      if (nested.length > 0) {
        nestedResponseFiles.push(...nested);
        extraWarnings.push({
          code: "nested_response_files",
          severity: "error",
          message: `Subdirectory holds response-like files that were NOT loaded (only top-level files are read): ${nested.join(", ")}. Move them up a level or point DATA_DIR at them.`,
          file: entry.name,
          count: nested.length,
        });
      } else {
        extraWarnings.push({ code: "ignored_file", severity: "info", message: "Directory without response files; ignored", file: entry.name });
      }
      continue;
    }
    if (kind === "other") {
      extraWarnings.push({ code: "ignored_file", severity: "info", message: "Not a regular file; ignored", file: entry.name });
      continue;
    }
    if (entry.name.startsWith(".")) {
      // Hidden/system files (.DS_Store) are binary; don't read them.
      files.push({ name: entry.name, content: "" });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(dir, entry.name), "utf8");
    } catch (e) {
      // We cannot tell whether an unreadable file held responses, so it blocks
      // the "all records accounted for" claim.
      unreadableFiles.push(entry.name);
      extraWarnings.push({
        code: "unreadable_file",
        severity: "error",
        message: `Could not read file: ${(e as Error).message}`,
        file: entry.name,
      });
      continue;
    }
    if (/^prompts\.csv$/i.test(entry.name)) {
      const parsed = parsePromptsCsv(content, entry.name);
      prompts = parsed.prompts;
      promptsFound = true;
      extraWarnings.push(...parsed.warnings);
    }
    files.push({ name: entry.name, content });
  }
  if (!promptsFound) {
    extraWarnings.push({
      code: "prompts_missing",
      severity: "warn",
      message: "prompts.csv not found; unknown-prompt checks disabled and coverage uses prompts seen in the data",
    });
  }

  const result = parseResponseFiles(files, prompts.length > 0 ? { knownPromptIds: prompts.map((p) => p.id) } : {});
  const stats: LoadStats = {
    ...result.stats,
    unreadableFiles,
    nestedResponseFiles,
    allRecordsAccountedFor: inputFullyAccounted(result.stats.accounting, {
      unsplittableFiles: result.stats.unsplittableFiles,
      unreadableFiles,
      nestedResponseFiles,
    }),
  };
  return { dataDir: dir, prompts, ...result, stats, warnings: [...extraWarnings, ...result.warnings] };
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

export class ExpectedConfigError extends Error {
  constructor(readonly warnings: DataQualityWarning[]) {
    super(`Expected-dataset config is unusable: ${warnings.map((w) => w.message).join("; ")}`);
    this.name = "ExpectedConfigError";
  }
}

export interface AnalysisInput {
  dataset: Dataset;
  /** Validated collection plan; every coverage dimension comes from it. */
  expected: ExpectedDataset;
  coverage: CoverageReport;
  /** Config, prompts.csv cross-check and loader warnings, in that order. */
  warnings: DataQualityWarning[];
}

/**
 * The only loader entry point production analysis should use. It always
 * builds coverage from the validated expected-dataset config, never from
 * inference, and throws ExpectedConfigError if the config is missing or invalid.
 */
export function loadDatasetForAnalysis(options: { dataDir: string; configPath?: string }): AnalysisInput {
  const config = loadExpectedDataset(options.configPath ?? DEFAULT_EXPECTED_CONFIG);
  if (!config.expected) throw new ExpectedConfigError(config.warnings);
  const expected = config.expected;
  const dataset = loadDataset(options.dataDir);
  const coverage = buildCoverage(dataset.responses, {
    ...expected,
    source: { weeks: "config", engines: "config", promptIds: "config", runs: "config" },
  });
  return {
    dataset,
    expected,
    coverage,
    warnings: [...config.warnings, ...crossCheckPrompts(expected, dataset.prompts), ...dataset.warnings],
  };
}

// ---------------------------------------------------------------------------
// Coverage gap summary (reporting)
// ---------------------------------------------------------------------------

export interface CoverageGapSummary {
  /** Dimensions with no slot at all at this level this week. */
  whollyMissing: { engines: EngineId[]; prompts: string[]; runs: number[] };
  /** Slots explained by a wholly missing engine, prompt or run. */
  slotsInWhollyMissing: number;
  /** Missing slots NOT explained by a wholly missing dimension. */
  individualSlots: SlotRef[];
}

/**
 * Splits a coverage level's missing slots into wholly missing dimensions and
 * individual gaps, so a report can say "perplexity missing (30 slots)" rather
 * than listing 30 slots, while still naming any stray single gaps.
 */
export function summarizeCoverageGaps(level: CoverageLevel): CoverageGapSummary {
  const engines = new Set<string>(level.missingEngines);
  const prompts = new Set(level.missingPrompts);
  const runs = new Set(level.missingRuns);
  const explained = (s: SlotRef) => engines.has(s.engine) || prompts.has(s.promptId) || runs.has(s.run);
  const individualSlots = level.missingSlots.filter((s) => !explained(s));
  return {
    whollyMissing: { engines: [...level.missingEngines], prompts: [...level.missingPrompts], runs: [...level.missingRuns] },
    slotsInWhollyMissing: level.missingSlots.length - individualSlots.length,
    individualSlots,
  };
}
