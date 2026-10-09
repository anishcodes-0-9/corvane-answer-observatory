import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCoverage,
  canonicalEngine,
  crossCheckPrompts,
  ExpectedConfigError,
  inferExpectedDataset,
  decodeHtmlEntities,
  loadDataset,
  loadDatasetForAnalysis,
  loadExpectedDataset,
  parseExpectedDataset,
  parsePromptsCsv,
  parseResponseFiles,
  parseTimestamp,
  summarizeCoverageGaps,
  verifyRecordAccounting,
  type InputFile,
} from "../src/lib/load";
import type { ExpectedDataset, LoadResult, NormalizedResponse, WarningCode } from "../src/lib/types";

// --- Synthetic fixtures (shapes mirror the two schemas seen in the data pack) ---

type Rec = Record<string, unknown>;

/** Weeks 1–3, 5, 6 schema. */
const schemaA = (overrides: Rec = {}): Rec => ({
  response_id: "r_a1",
  week: 1,
  engine: "chatgpt",
  prompt_id: "P01",
  run: 1,
  collected_at: "2026-08-18T14:18:00Z",
  response_text: "Corvane Fleet is a strong pick.",
  citations: ["https://corvanefleet.com/features/"],
  ...overrides,
});

/** Week 4 schema. */
const schemaB = (overrides: Rec = {}): Rec => ({
  response_id: "r_b1",
  week: 4,
  engine: "ChatGPT",
  prompt_id: "p01",
  run_number: 1,
  collected: "07/09/2026 21:26",
  answer: "Corvane Fleet is a strong pick.",
  sources: ["https://corvanefleet.com/features/"],
  ...overrides,
});

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const parseOne = (content: string, name = "responses.jsonl", knownPromptIds?: string[]) =>
  parseResponseFiles([{ name, content }], knownPromptIds ? { knownPromptIds } : {});
const codes = (res: LoadResult) => res.warnings.map((w) => w.code);
const warningsOf = (res: LoadResult, code: WarningCode) => res.warnings.filter((w) => w.code === code);
const withoutSource = (r: NormalizedResponse) => {
  const { source: _source, ...rest } = r;
  return rest;
};

describe("format detection", () => {
  it("reads a JSON array and JSONL with the same records identically", () => {
    const records = [schemaA(), schemaA({ response_id: "r_a2", run: 2 })];
    const fromArray = parseOne(JSON.stringify(records, null, 2), "Responses.json");
    const fromJsonl = parseOne(jsonl(...records), "responses.jsonl");

    expect(fromArray.stats.rawRecords).toBe(2);
    expect(fromJsonl.stats.rawRecords).toBe(2);
    expect(fromArray.responses.map(withoutSource)).toEqual(fromJsonl.responses.map(withoutSource));
    expect(fromArray.responses[1]!.source).toEqual({ file: "Responses.json", recordIndex: 1, line: null });
    expect(fromJsonl.responses[1]!.source).toEqual({ file: "responses.jsonl", recordIndex: 1, line: 2 });
  });

  it("detects format from content, not extension", () => {
    // JSONL content in a .json file, and a JSON array in a .jsonl file.
    expect(parseOne(jsonl(schemaA()), "responses.json").responses).toHaveLength(1);
    expect(parseOne(JSON.stringify([schemaA()]), "responses.jsonl").responses).toHaveLength(1);
  });

  it("loads response files by content even when not named responses*", () => {
    const res = parseOne(jsonl(schemaA()), "week7.jsonl");
    expect(res.responses).toHaveLength(1);
    expect(res.stats.responseFiles).toEqual(["week7.jsonl"]);
  });

  it("reads records wrapped in a single array property", () => {
    const res = parseOne(JSON.stringify({ responses: [schemaA()] }), "responses-week7.json");
    expect(res.responses).toHaveLength(1);
    expect(codes(res)).toContain("format_note");
  });

  it("ignores non-response files with an informational note", () => {
    const files: InputFile[] = [
      { name: ".DS_Store", content: "\u0000\u0001Bud1" },
      { name: "prompts.csv", content: "prompt_id,question\nP01,q\n" },
      { name: "README.txt", content: "notes" },
      { name: "notes.json", content: '{"hello": "world"}' },
      { name: "responses.jsonl", content: jsonl(schemaA()) },
    ];
    const res = parseResponseFiles(files);
    expect(res.responses).toHaveLength(1);
    expect(res.stats.ignoredFiles).toEqual([".DS_Store", "README.txt", "notes.json", "prompts.csv"]);
    expect(warningsOf(res, "ignored_file").every((w) => w.severity === "info")).toBe(true);
  });
});

describe("schema normalisation", () => {
  it("normalises both schemas to the same contract", () => {
    const a = parseOne(jsonl(schemaA())).responses[0]!;
    const b = parseOne(jsonl(schemaB())).responses[0]!;

    expect(a).toMatchObject({
      id: "r_a1",
      week: 1,
      engine: "chatgpt",
      engineLabel: "chatgpt",
      promptId: "P01",
      run: 1,
      collectedAt: "2026-08-18T14:18:00.000Z",
      timestampFormat: "iso_offset",
      text: "Corvane Fleet is a strong pick.",
      citations: ["https://corvanefleet.com/features/"],
      status: "ok",
      error: null,
    });
    expect(b).toMatchObject({
      id: "r_b1",
      week: 4,
      engine: "chatgpt",
      engineLabel: "ChatGPT",
      promptId: "P01",
      promptIdRaw: "p01",
      run: 1,
      collectedAt: "2026-09-07T21:26:00.000Z",
      collectedAtRaw: "07/09/2026 21:26",
      timestampFormat: "dmy",
      text: "Corvane Fleet is a strong pick.",
      citations: ["https://corvanefleet.com/features/"],
      status: "ok",
    });
  });

  it("treats null citations as an empty list without a warning", () => {
    const res = parseOne(jsonl(schemaA({ citations: null })));
    expect(res.responses[0]!.citations).toEqual([]);
    expect(codes(res)).not.toContain("invalid_citations");
  });

  it("uses the explicit week, never the timestamp", () => {
    const res = parseOne(jsonl(schemaA({ week: 3, collected_at: "2026-09-22T10:00:00Z" })));
    expect(res.responses[0]!.week).toBe(3);
  });
});

describe("engine and prompt normalisation", () => {
  it.each([
    ["chatgpt", "chatgpt"],
    ["ChatGPT", "chatgpt"],
    ["Perplexity", "perplexity"],
    ["perplexity", "perplexity"],
    ["AI Overview", "google_ai_overview"],
    ["Google AI Overview", "google_ai_overview"],
    ["google_ai_overview", "google_ai_overview"],
  ])("maps %s to %s", (label, id) => {
    expect(canonicalEngine(label)).toEqual({ id, known: true });
  });

  it("keeps unknown engines as a slug with one aggregated warning", () => {
    const res = parseOne(
      jsonl(schemaA({ engine: "Gemini 2.5 Pro" }), schemaA({ response_id: "r_a2", run: 2, engine: "Gemini 2.5 Pro" })),
    );
    expect(res.responses.map((r) => r.engine)).toEqual(["gemini_2_5_pro", "gemini_2_5_pro"]);
    const w = warningsOf(res, "unknown_engine");
    expect(w).toHaveLength(1);
    expect(w[0]!.count).toBe(2);
  });

  it("uppercases prompt IDs and pads them to match known prompts", () => {
    const res = parseOne(
      jsonl(schemaA({ prompt_id: "p01" }), schemaA({ response_id: "r_a2", prompt_id: "P1" })),
      "responses.jsonl",
      ["P01", "P02"],
    );
    expect(res.responses.map((r) => r.promptId)).toEqual(["P01", "P01"]);
    expect(codes(res)).toContain("prompt_id_normalized");
    expect(codes(res)).not.toContain("unknown_prompt");
  });

  it("keeps unknown prompt IDs and warns", () => {
    const res = parseOne(jsonl(schemaA({ prompt_id: "P99" })), "responses.jsonl", ["P01"]);
    expect(res.responses[0]!.promptId).toBe("P99");
    expect(warningsOf(res, "unknown_prompt")[0]).toMatchObject({ severity: "warn", count: 1 });
  });

  it("warns once per unknown field with a count", () => {
    const res = parseOne(
      jsonl(schemaA({ model: "gpt-x" }), schemaA({ response_id: "r_a2", run: 2, model: "gpt-x" })),
    );
    expect(res.responses).toHaveLength(2);
    expect(warningsOf(res, "unknown_field")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"model"'), count: 2, file: "responses.jsonl" }),
    ]);
  });
});

describe("HTML entities", () => {
  it("decodes entities into text and preserves the raw text", () => {
    const raw = "Options vary by price &amp; feature focus. It&#39;s based in Columbus, Ohio, &amp; has been around.";
    const r = parseOne(jsonl(schemaA({ response_text: raw }))).responses[0]!;
    expect(r.rawText).toBe(raw);
    expect(r.text).toBe("Options vary by price & feature focus. It's based in Columbus, Ohio, & has been around.");
  });

  it("decodes in a single pass and leaves unknown entities alone", () => {
    expect(decodeHtmlEntities("a &amp;amp; b").text).toBe("a &amp; b");
    expect(decodeHtmlEntities("&#x27;&lt;&gt;&quot;").text).toBe("'<>\"");
    expect(decodeHtmlEntities("x &bogus; y")).toEqual({ text: "x &bogus; y", unknown: ["&bogus;"] });
  });
});

describe("timestamps", () => {
  it("parses ISO with Z and with a +05:30 offset to UTC", () => {
    expect(parseTimestamp("2026-08-18T14:18:00Z")).toEqual({ iso: "2026-08-18T14:18:00.000Z", format: "iso_offset" });
    expect(parseTimestamp("2026-09-14T23:41:00+05:30")).toEqual({
      iso: "2026-09-14T18:11:00.000Z",
      format: "iso_offset",
    });
  });

  it("parses DD/MM/YYYY HH:mm as day first", () => {
    expect(parseTimestamp("07/09/2026 21:26")).toEqual({ iso: "2026-09-07T21:26:00.000Z", format: "dmy" });
    expect(parseTimestamp("08/09/2026 00:30")).toEqual({ iso: "2026-09-08T00:30:00.000Z", format: "dmy" });
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseTimestamp("31/02/2026 10:00").iso).toBeNull();
    expect(parseTimestamp("07/13/2026 10:00").iso).toBeNull();
    expect(parseTimestamp("2026-02-30T10:00:00Z").iso).toBeNull();
  });

  it("keeps a record with no timestamp, leaves it null, and notes it once per file", () => {
    const res = parseOne(
      jsonl(schemaA({ collected_at: undefined }), schemaA({ response_id: "r_a2", run: 2, collected_at: null })),
    );
    expect(res.responses.map((r) => [r.status, r.collectedAt, r.collectedAtRaw, r.timestampFormat])).toEqual([
      ["ok", null, null, null],
      ["ok", null, null, null],
    ]);
    expect(warningsOf(res, "missing_timestamp")).toEqual([
      expect.objectContaining({ severity: "info", file: "responses.jsonl", count: 2 }),
    ]);
    expect(codes(res)).not.toContain("unparseable_timestamp");
  });

  it("keeps the record but warns on an unparseable timestamp", () => {
    const res = parseOne(jsonl(schemaA({ collected_at: "last tuesday" })));
    expect(res.responses[0]).toMatchObject({ collectedAt: null, collectedAtRaw: "last tuesday", status: "ok" });
    expect(codes(res)).toContain("unparseable_timestamp");
  });
});

describe("duplicates", () => {
  it("keeps one copy of an exact duplicate, even with different key order", () => {
    const rec = schemaA();
    const reordered = Object.fromEntries(Object.entries(rec).reverse());
    const res = parseOne(jsonl(rec, reordered));
    expect(res.responses).toHaveLength(1);
    expect(res.stats).toMatchObject({ rawRecords: 2, exactDuplicates: 1, uniqueResponses: 1, allRecordsAccountedFor: true });
    expect(warningsOf(res, "duplicate_exact")[0]).toMatchObject({ severity: "warn", line: 2, responseIds: ["r_a1"] });
  });

  it("keeps the first of two conflicting records and raises an error", () => {
    const res = parseOne(jsonl(schemaA({ response_text: "first" }), schemaA({ response_text: "second" })));
    expect(res.responses).toHaveLength(1);
    expect(res.responses[0]!.text).toBe("first");
    expect(res.stats.conflictingDuplicates).toBe(1);
    expect(warningsOf(res, "duplicate_conflict")[0]).toMatchObject({ severity: "error", line: 2 });
  });

  it("flags a whole file that duplicates another (same data in two formats)", () => {
    const records = [schemaA(), schemaA({ response_id: "r_a2", run: 2 })];
    const res = parseResponseFiles([
      { name: "Responses.json", content: JSON.stringify(records) },
      { name: "responses.jsonl", content: jsonl(...records) },
    ]);
    expect(res.responses).toHaveLength(2);
    expect(res.stats.exactDuplicates).toBe(2);
    expect(warningsOf(res, "duplicate_file")).toEqual([expect.objectContaining({ file: "responses.jsonl", count: 2 })]);
  });

  it("warns when two different IDs claim the same week/engine/prompt/run slot", () => {
    const res = parseOne(jsonl(schemaA(), schemaA({ response_id: "r_other" })));
    expect(res.responses).toHaveLength(2);
    expect(warningsOf(res, "duplicate_slot")[0]!.responseIds).toEqual(["r_a1", "r_other"]);
  });
});

describe("error and empty records", () => {
  it("keeps a timeout as an error, never as a valid empty answer", () => {
    const res = parseOne(
      jsonl(schemaA({ response_text: "", citations: null, error: "timeout" }), schemaB({ answer: "", sources: [], error: "timeout" })),
    );
    expect(res.responses.map((r) => [r.status, r.error])).toEqual([
      ["error", "timeout"],
      ["error", "timeout"],
    ]);
    expect(res.stats.byStatus).toEqual({ ok: 0, error: 2, empty: 0 });
    expect(warningsOf(res, "error_record")).toHaveLength(2);
  });

  it("treats a record with both an error and text as an error", () => {
    const res = parseOne(jsonl(schemaA({ error: "rate_limited" })));
    expect(res.responses[0]!.status).toBe("error");
    expect(codes(res)).toContain("error_with_text");
  });

  it("marks blank text without an error as empty", () => {
    const res = parseOne(jsonl(schemaA({ response_text: "   " })));
    expect(res.responses[0]!.status).toBe("empty");
    expect(codes(res)).toContain("empty_text");
  });
});

describe("malformed input", () => {
  it("skips a bad JSONL line with its line number and loads the rest", () => {
    const content = `${JSON.stringify(schemaA())}\n{"response_id": "r_broken", "week": \n\n${JSON.stringify(schemaA({ response_id: "r_a3", run: 2 }))}\n`;
    const res = parseOne(content);
    expect(res.responses.map((r) => r.id)).toEqual(["r_a1", "r_a3"]);
    expect(res.stats).toMatchObject({ rawRecords: 3, malformedRecords: 1, allRecordsAccountedFor: true });
    expect(warningsOf(res, "malformed_record")[0]).toMatchObject({ severity: "error", file: "responses.jsonl", line: 2 });
  });

  it("skips records missing required fields, with location", () => {
    const res = parseOne(jsonl(schemaA({ engine: undefined }), schemaA({ response_id: "r_a2", week: "soon" }), schemaA({ response_id: "r_a3", run: 2 })));
    expect(res.responses.map((r) => r.id)).toEqual(["r_a3"]);
    expect(res.stats).toMatchObject({ invalidRecords: 2, allRecordsAccountedFor: true });
    expect(warningsOf(res, "missing_required_field")[0]).toMatchObject({ line: 1, message: expect.stringContaining("engine") });
    expect(warningsOf(res, "invalid_week")[0]).toMatchObject({ line: 2, responseIds: ["r_a2"] });
  });

  it("skips non-object array entries with their record index", () => {
    const res = parseOne(JSON.stringify([schemaA(), 42, "x"]), "Responses.json");
    expect(res.responses).toHaveLength(1);
    expect(warningsOf(res, "not_an_object").map((w) => w.recordIndex)).toEqual([1, 2]);
    expect(res.stats.allRecordsAccountedFor).toBe(true);
  });

  it("reports an unparseable JSON array file as an error instead of crashing", () => {
    const res = parseOne('[{"response_id": "r_1", ', "Responses.json");
    expect(res.responses).toHaveLength(0);
    expect(warningsOf(res, "malformed_file")[0]!.severity).toBe("error");
  });

  it("keeps a record with an invalid run number, with run = null", () => {
    const res = parseOne(jsonl(schemaA({ run: "first" })));
    expect(res.responses[0]!.run).toBeNull();
    expect(codes(res)).toContain("invalid_run");
  });
});

describe("coverage", () => {
  const rec = (week: number, engine: string, prompt: string, run: number, extra: Rec = {}) =>
    schemaA({ response_id: `r_${week}_${engine}_${prompt}_${run}`, week, engine, prompt_id: prompt, run, ...extra });
  const full = (week: number, engines: string[], prompts = ["P01", "P02"]) =>
    engines.flatMap((e) => prompts.flatMap((p) => [1, 2].map((r) => rec(week, e, p, r))));
  const plan = (overrides: Partial<ExpectedDataset> = {}): ExpectedDataset => ({
    weeks: [1, 2],
    engines: ["chatgpt", "perplexity", "google_ai_overview"],
    promptIds: ["P01", "P02"],
    runs: [1, 2],
    ...overrides,
  });

  // --- Existing scenarios (inferred expectations), assertions on the new shape ---

  it("flags a week missing an entire engine as incomplete", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt", "perplexity"]), ...full(2, ["chatgpt"])));
    const cov = buildCoverage(res.responses, inferExpectedDataset(res.responses, { promptIds: ["P01", "P02"] }));
    expect(cov.expected.engines).toEqual(["chatgpt", "perplexity"]);
    expect(cov.expected.source).toEqual({ weeks: "inferred", engines: "inferred", promptIds: "config", runs: "inferred" });
    const [w1, w2] = cov.weeks;
    expect(w1).toMatchObject({ week: 1, expectedSlots: 8, observed: { slots: 8, complete: true }, usable: { complete: true } });
    expect(w2!.observed).toMatchObject({ slots: 4, complete: false, missingEngines: ["perplexity"] });
    expect(w2!.observed.missingSlots).toHaveLength(4);
  });

  it("does not call a week complete just because it has some records", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt"]), rec(2, "chatgpt", "P01", 1)));
    const w2 = buildCoverage(res.responses, inferExpectedDataset(res.responses)).weeks[1]!;
    expect(w2.weekMissing).toBe(false);
    expect(w2.observed.complete).toBe(false);
    expect(w2.observed.missingSlots).toEqual([
      { engine: "chatgpt", promptId: "P01", run: 2 },
      { engine: "chatgpt", promptId: "P02", run: 1 },
      { engine: "chatgpt", promptId: "P02", run: 2 },
    ]);
  });

  it("separates present-but-errored slots from missing ones", () => {
    const records = full(1, ["chatgpt"]).map((r, i) => (i === 0 ? { ...r, response_text: "", error: "timeout" } : r));
    const errored = parseOne(jsonl(...records)).responses;
    const w1 = buildCoverage(errored, inferExpectedDataset(errored)).weeks[0]!;
    expect(w1.observed).toMatchObject({ slots: 4, complete: true, missingSlots: [] });
    expect(w1.usable).toMatchObject({ slots: 3, complete: false });
    expect(w1.usable.missingSlots).toEqual([{ engine: "chatgpt", promptId: "P01", run: 1 }]);
    expect(w1.unusableSlots).toEqual([{ engine: "chatgpt", promptId: "P01", run: 1 }]);
  });

  it("reports a week with no records at all between two observed weeks", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt"]), ...full(3, ["chatgpt"])));
    const cov = buildCoverage(res.responses, inferExpectedDataset(res.responses));
    expect(cov.expected.weeks).toEqual([1, 2, 3]);
    expect(cov.weeks[1]).toMatchObject({ week: 2, weekMissing: true, observed: { slots: 0, complete: false, missingEngines: ["chatgpt"] } });
  });

  it("lists records outside the expected prompts as unslotted rather than dropping them", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt"]), rec(1, "chatgpt", "P99", 1)));
    const cov = buildCoverage(res.responses, inferExpectedDataset(res.responses, { promptIds: ["P01", "P02"] }));
    expect(cov.weeks[0]!.unslottedRecords).toEqual(["r_1_chatgpt_P99_1"]);
    expect(cov.unexpected.promptIds).toEqual(["P99"]);
  });

  // --- Explicit expected dataset ---

  it("reports an engine that is missing from every week", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt", "perplexity"]), ...full(2, ["chatgpt", "perplexity"])));
    const cov = buildCoverage(res.responses, plan());
    for (const w of cov.weeks) {
      expect(w.observed.missingEngines).toEqual(["google_ai_overview"]);
      expect(w.observed).toMatchObject({ slots: 8, complete: false });
      expect(w.expectedSlots).toBe(12);
      expect(w.byEngine.find((e) => e.engine === "google_ai_overview")).toEqual({
        engine: "google_ai_overview",
        expectedSlots: 4,
        observedSlots: 0,
        usableSlots: 0,
      });
    }
    // Inferring engines from the data would have hidden this completely.
    expect(buildCoverage(res.responses, inferExpectedDataset(res.responses)).weeks.every((w) => w.observed.complete)).toBe(true);
  });

  it("reports a missing final week that has no records at all", () => {
    const all = ["chatgpt", "perplexity", "google_ai_overview"];
    const res = parseOne(jsonl(...full(1, all), ...full(2, all)));
    const cov = buildCoverage(res.responses, plan({ weeks: [1, 2, 3] }));
    expect(cov.weeks.map((w) => w.week)).toEqual([1, 2, 3]);
    expect(cov.weeks[2]).toMatchObject({
      week: 3,
      expectedWeek: true,
      weekMissing: true,
      expectedSlots: 12,
      observed: { slots: 0, complete: false, missingEngines: all, missingPrompts: ["P01", "P02"], missingRuns: [1, 2] },
      usable: { slots: 0, complete: false },
    });
    expect(cov.weeks[2]!.observed.missingSlots).toHaveLength(12);
    // Inference stops at the last week seen, so it cannot see week 3.
    expect(buildCoverage(res.responses, inferExpectedDataset(res.responses)).expected.weeks).toEqual([1, 2]);
  });

  it("reports a missing prompt and a missing run", () => {
    const records = [
      ...full(1, ["chatgpt"], ["P01"]), // P02 never asked this week
      rec(2, "chatgpt", "P01", 1),
      rec(2, "chatgpt", "P02", 1), // run 2 never collected this week
    ];
    const cov = buildCoverage(parseOne(jsonl(...records)).responses, plan({ engines: ["chatgpt"] }));
    const [w1, w2] = cov.weeks;
    expect(w1!.observed).toMatchObject({ missingPrompts: ["P02"], missingRuns: [], missingEngines: [], complete: false });
    expect(w1!.observed.missingSlots).toEqual([
      { engine: "chatgpt", promptId: "P02", run: 1 },
      { engine: "chatgpt", promptId: "P02", run: 2 },
    ]);
    expect(w2!.observed).toMatchObject({ missingPrompts: [], missingRuns: [2], complete: false });
  });

  it("reports a single missing prompt/run slot", () => {
    const records = full(1, ["chatgpt"]).filter((r) => !(r.prompt_id === "P02" && r.run === 1));
    const w1 = buildCoverage(parseOne(jsonl(...records)).responses, plan({ weeks: [1], engines: ["chatgpt"] })).weeks[0]!;
    expect(w1.observed.missingSlots).toEqual([{ engine: "chatgpt", promptId: "P02", run: 1 }]);
    expect(w1.observed).toMatchObject({ slots: 3, missingPrompts: [], missingRuns: [], complete: false });
  });

  it("keeps observed and usable separate when an engine only errored", () => {
    const records = full(1, ["chatgpt", "perplexity"]).map((r) =>
      r.engine === "perplexity" ? { ...r, response_text: "", error: "timeout" } : r,
    );
    const w1 = buildCoverage(parseOne(jsonl(...records)).responses, plan({ weeks: [1], engines: ["chatgpt", "perplexity"] }))
      .weeks[0]!;
    expect(w1.observed).toMatchObject({ slots: 8, complete: true, missingEngines: [] });
    expect(w1.usable).toMatchObject({ slots: 4, complete: false, missingEngines: ["perplexity"] });
    expect(w1.unusableSlots).toHaveLength(4);
  });

  it("still reports weeks and engines that the expectation does not include", () => {
    const res = parseOne(jsonl(...full(1, ["chatgpt"]), ...full(7, ["chatgpt", "gemini"])));
    const cov = buildCoverage(res.responses, plan({ weeks: [1], engines: ["chatgpt"] }));
    expect(cov.unexpected).toMatchObject({ weeks: [7], engines: ["gemini"] });
    const w7 = cov.weeks.find((w) => w.week === 7)!;
    expect(w7).toMatchObject({ expectedWeek: false, weekMissing: false, observed: { complete: true } });
    expect(w7.unslottedRecords).toHaveLength(4);
  });
});

describe("expected dataset config", () => {
  it("ships the case-study plan: weeks 1–6, three engines, P01–P15, runs 1–2", () => {
    const { expected, warnings } = loadExpectedDataset(fileURLToPath(new URL("../config/expected-dataset.json", import.meta.url)));
    expect(warnings).toEqual([]);
    expect(expected).toEqual({
      weeks: [1, 2, 3, 4, 5, 6],
      engines: ["chatgpt", "perplexity", "google_ai_overview"],
      promptIds: Array.from({ length: 15 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
      runs: [1, 2],
    });
  });

  it("canonicalises engine labels and normalises prompt IDs", () => {
    const { expected } = parseExpectedDataset({ weeks: [2, 1], engines: ["AI Overview", "ChatGPT"], promptIds: ["p01"], runs: [1] });
    expect(expected).toEqual({ weeks: [1, 2], engines: ["google_ai_overview", "chatgpt"], promptIds: ["P01"], runs: [1] });
  });

  it.each([
    [{ engines: ["chatgpt"], promptIds: ["P01"], runs: [1] }, "weeks"],
    [{ weeks: [0], engines: ["chatgpt"], promptIds: ["P01"], runs: [1] }, "weeks"],
    [{ weeks: [1], engines: [], promptIds: ["P01"], runs: [1] }, "engines"],
    [{ weeks: [1], engines: ["chatgpt"], promptIds: ["P01"], runs: ["1"] }, "runs"],
    [{ weeks: [1], engines: ["chatgpt"], promptIds: [""], runs: [1] }, "promptIds"],
  ])("rejects an invalid config (%j)", (config, field) => {
    const { expected, warnings } = parseExpectedDataset(config);
    expect(expected).toBeNull();
    expect(warnings[0]).toMatchObject({ code: "expected_config_invalid", severity: "error", message: expect.stringContaining(field) });
  });

  it("warns when prompts.csv and the config disagree", () => {
    const expected: ExpectedDataset = { weeks: [1], engines: ["chatgpt"], promptIds: ["P01", "P02"], runs: [1] };
    const prompts = [
      { id: "P01", question: "", stage: "", priority: 1 },
      { id: "P03", question: "", stage: "", priority: 1 },
    ];
    const w = crossCheckPrompts(expected, prompts);
    expect(w.map((x) => x.message)).toEqual([
      expect.stringContaining("P03"),
      expect.stringContaining("P02"),
    ]);
    expect(crossCheckPrompts(expected, [])).toEqual([]);
  });
});

describe("record accounting", () => {
  const mixed = () =>
    [
      JSON.stringify(schemaA()), // line 1: retained
      '{"response_id": "r_bad", ', // line 2: malformed JSON
      "[1, 2]", // line 3: not an object
      JSON.stringify(schemaA({ response_id: "r_noweek", week: undefined })), // line 4: invalid
      JSON.stringify(schemaA()), // line 5: exact duplicate of line 1
      JSON.stringify(schemaA({ response_text: "different" })), // line 6: conflicting duplicate of line 1
      JSON.stringify(schemaA({ response_id: "r_timeout", response_text: "", error: "timeout" })), // line 7: retained (error)
    ].join("\n");

  it("gives every raw record exactly one explicit disposition", () => {
    const res = parseOne(mixed());
    expect(res.dispositions.map((d) => [d.line, d.disposition, d.warningCode])).toEqual([
      [1, "retained", null],
      [2, "malformed", "malformed_record"],
      [3, "malformed", "not_an_object"],
      [4, "invalid", "missing_required_field"],
      [5, "exact_duplicate", "duplicate_exact"],
      [6, "conflicting_duplicate", "duplicate_conflict"],
      [7, "retained", null],
    ]);
    expect(res.stats.accounting).toEqual({
      rawRecords: 7,
      retained: 2,
      malformed: 2,
      invalid: 1,
      exactDuplicates: 1,
      conflictingDuplicates: 1,
      balanced: true,
      problems: [],
    });
    expect(res.stats.byStatus).toEqual({ ok: 1, error: 1, empty: 0 });
    expect(res.stats.allRecordsAccountedFor).toBe(true);
  });

  it("keeps the first record of a conflicting duplicate and accounts for the second", () => {
    const res = parseResponseFiles([
      { name: "responses-1.jsonl", content: jsonl(schemaA({ response_text: "original" })) },
      { name: "responses-2.jsonl", content: jsonl(schemaA({ response_text: "rewritten" })) },
    ]);
    expect(res.responses.map((r) => r.text)).toEqual(["original"]);
    expect(res.dispositions).toEqual([
      { file: "responses-1.jsonl", recordIndex: 0, line: 1, responseId: "r_a1", disposition: "retained", warningCode: null },
      {
        file: "responses-2.jsonl",
        recordIndex: 0,
        line: 1,
        responseId: "r_a1",
        disposition: "conflicting_duplicate",
        warningCode: "duplicate_conflict",
      },
    ]);
    expect(warningsOf(res, "duplicate_conflict")[0]).toMatchObject({
      severity: "error",
      file: "responses-2.jsonl",
      message: expect.stringContaining("responses-1.jsonl line 1"),
    });
    expect(res.stats.accounting).toMatchObject({ rawRecords: 2, retained: 1, conflictingDuplicates: 1, balanced: true });
  });

  it("detects a ledger that does not balance", () => {
    const res = parseOne(mixed());
    const base = {
      rawRecords: res.stats.rawRecords,
      counts: res.stats,
      responses: res.responses,
      dispositions: res.dispositions,
      warnings: res.warnings,
    };
    expect(verifyRecordAccounting(base).balanced).toBe(true);

    const lostRecord = verifyRecordAccounting({ ...base, dispositions: res.dispositions.slice(1) });
    expect(lostRecord.balanced).toBe(false);
    expect(lostRecord.problems.join(" ")).toContain("6 dispositions recorded for 7 raw records");

    const unexplained = verifyRecordAccounting({
      ...base,
      warnings: res.warnings.filter((w) => w.code !== "duplicate_exact"),
    });
    expect(unexplained.problems).toEqual([expect.stringContaining("exact_duplicate record at responses.jsonl line 5")]);

    const miscounted = verifyRecordAccounting({ ...base, counts: { ...res.stats, invalidRecords: 0 } });
    expect(miscounted.balanced).toBe(false);
  });
});

describe("expected dataset config: engines", () => {
  const base = { weeks: [1], promptIds: ["P01"], runs: [1] };

  it.each([[["gemini"]], [["Bing Chat"]], [["chatgpt", "claude"]], [["chat gpt 4"]]])(
    "rejects unsupported engine IDs %j instead of mapping them to a slug",
    (engines) => {
      const { expected, warnings } = parseExpectedDataset({ ...base, engines });
      expect(expected).toBeNull();
      expect(warnings).toEqual([
        expect.objectContaining({ code: "expected_config_invalid", severity: "error", message: expect.stringContaining("Unsupported engine") }),
      ]);
    },
  );

  it("accepts every known alias and maps it to the canonical ID", () => {
    const { expected, warnings } = parseExpectedDataset({
      ...base,
      engines: ["ChatGPT", "Perplexity", "Google AI Overviews"],
    });
    expect(warnings).toEqual([]);
    expect(expected!.engines).toEqual(["chatgpt", "perplexity", "google_ai_overview"]);
  });

  it.each([
    [["P 01"], "Malformed prompt ID"],
    [["P01;P02"], "Malformed prompt ID"],
    [["01"], "Malformed prompt ID"],
    [["P1", "P01"], "zero-padding"],
    [["P01", "P001", "P02"], "zero-padding"],
  ])("rejects prompt IDs %j that could never match a record", (promptIds, reason) => {
    const { expected, warnings } = parseExpectedDataset({ weeks: [1], engines: ["chatgpt"], promptIds, runs: [1] });
    expect(expected).toBeNull();
    expect(warnings[0]).toMatchObject({ code: "expected_config_invalid", severity: "error", message: expect.stringContaining(reason) });
  });

  it("collapses exact and case-only duplicate prompt IDs with a warning", () => {
    const { expected, warnings } = parseExpectedDataset({ weeks: [1], engines: ["chatgpt"], promptIds: ["P01", "p01", " P01 ", "P02"], runs: [1] });
    expect(expected!.promptIds).toEqual(["P01", "P02"]);
    expect(warnings.map((w) => w.message)).toEqual(["Duplicate prompt IDs in config collapsed"]);
  });

  it("collapses aliases of the same engine with a warning", () => {
    const { expected, warnings } = parseExpectedDataset({ ...base, engines: ["ChatGPT", "chatgpt", "AI Overview", "google_ai_overview"] });
    expect(expected!.engines).toEqual(["chatgpt", "google_ai_overview"]);
    expect(warnings).toEqual([expect.objectContaining({ severity: "warn", message: "Duplicate engines in config collapsed" })]);
  });

  it("collapses duplicate weeks and runs with a warning", () => {
    const { expected, warnings } = parseExpectedDataset({ weeks: [2, 1, 2], engines: ["chatgpt"], promptIds: ["P01"], runs: [1, 1] });
    expect(expected).toMatchObject({ weeks: [1, 2], runs: [1] });
    expect(warnings.map((w) => w.message)).toEqual([
      'Duplicate values in "weeks" collapsed',
      'Duplicate values in "runs" collapsed',
    ]);
  });
});

describe("record accounting: file-level failures", () => {
  it("does not claim the input is accounted for when one file could not be split", () => {
    const res = parseResponseFiles([
      { name: "responses-broken.json", content: '[{"response_id": "r_lost", ' },
      { name: "responses-ok.jsonl", content: jsonl(schemaA()) },
    ]);
    // The record ledger for what could be read still balances...
    expect(res.stats.accounting).toMatchObject({ rawRecords: 1, retained: 1, balanced: true });
    expect(res.dispositions).toHaveLength(1);
    // ...but the input as a whole is not accounted for.
    expect(res.stats.allRecordsAccountedFor).toBe(false);
    expect(res.stats.unsplittableFiles).toEqual(["responses-broken.json"]);
  });

  it.skipIf(process.getuid?.() === 0)("does not claim the input is accounted for when a data file is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-unreadable-"));
    const locked = join(dir, "responses-b.jsonl");
    try {
      writeFileSync(join(dir, "responses-a.jsonl"), jsonl(schemaA()));
      writeFileSync(locked, jsonl(schemaA({ response_id: "r_hidden" })));
      chmodSync(locked, 0o000);
      const ds = loadDataset(dir);
      expect(ds.responses.map((r) => r.id)).toEqual(["r_a1"]);
      expect(ds.stats.accounting.balanced).toBe(true);
      expect(ds.stats.unreadableFiles).toEqual(["responses-b.jsonl"]);
      expect(ds.stats.allRecordsAccountedFor).toBe(false);
      expect(ds.warnings).toContainEqual(expect.objectContaining({ code: "unreadable_file", severity: "error", file: "responses-b.jsonl" }));
    } finally {
      chmodSync(locked, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("follows a symlinked response file instead of ignoring it", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-symlink-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "corvane-target-"));
    try {
      writeFileSync(join(elsewhere, "real.jsonl"), jsonl(schemaA()));
      symlinkSync(join(elsewhere, "real.jsonl"), join(dir, "responses.jsonl"));
      symlinkSync(join(elsewhere, "gone.jsonl"), join(dir, "responses-broken-link.jsonl"));
      const ds = loadDataset(dir);
      expect(ds.responses.map((r) => r.id)).toEqual(["r_a1"]);
      expect(ds.stats.unreadableFiles).toEqual(["responses-broken-link.jsonl"]);
      expect(ds.stats.allRecordsAccountedFor).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reports response files in subdirectories instead of letting them escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-nested-"));
    try {
      writeFileSync(join(dir, "responses.jsonl"), jsonl(schemaA()));
      mkdirSync(join(dir, "week7", "late"), { recursive: true });
      writeFileSync(join(dir, "week7", "late", "answers.jsonl"), jsonl(schemaA({ response_id: "r_7", week: 7 })));
      mkdirSync(join(dir, "notes"));
      writeFileSync(join(dir, "notes", "todo.txt"), "nothing to see");
      mkdirSync(join(dir, ".cache"));
      writeFileSync(join(dir, ".cache", "responses.jsonl"), jsonl(schemaA({ response_id: "r_cache" })));

      const ds = loadDataset(dir);
      // Loading stays one level deep; the nested file is reported, not loaded.
      expect(ds.responses.map((r) => r.id)).toEqual(["r_a1"]);
      expect(ds.stats.nestedResponseFiles).toEqual(["week7/late/answers.jsonl"]);
      expect(ds.stats.accounting.balanced).toBe(true);
      expect(ds.stats.allRecordsAccountedFor).toBe(false);
      expect(ds.warnings).toContainEqual(
        expect.objectContaining({ code: "nested_response_files", severity: "error", file: "week7", count: 1 }),
      );
      expect(ds.warnings).toContainEqual(expect.objectContaining({ code: "ignored_file", severity: "info", file: "notes" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses an unsupported-format response file record by record instead of ignoring it", () => {
    const csv = "response_id,week,engine,prompt_id,run,answer\nr_7,7,chatgpt,P01,1,hello\n";
    const res = parseResponseFiles([
      { name: "responses.jsonl", content: jsonl(schemaA()) },
      { name: "week7.csv", content: csv },
    ]);
    expect(res.stats.responseFiles).toEqual(["responses.jsonl", "week7.csv"]);
    expect(res.stats.ignoredFiles).toEqual([]);
    expect(res.stats.malformedRecords).toBe(2);
    expect(warningsOf(res, "malformed_record").map((w) => [w.file, w.line, w.severity])).toEqual([
      ["week7.csv", 1, "error"],
      ["week7.csv", 2, "error"],
    ]);
  });
});

describe("record accounting: ledger tampering", () => {
  const records = jsonl(schemaA(), schemaA(), schemaA({ response_id: "r_a2", run: 2 }));
  const verifyWith = (patch: Partial<Parameters<typeof verifyRecordAccounting>[0]>) => {
    const res = parseOne(records);
    return verifyRecordAccounting({
      rawRecords: res.stats.rawRecords,
      counts: res.stats,
      responses: res.responses,
      dispositions: res.dispositions,
      warnings: res.warnings,
      ...patch,
    });
  };
  const ledger = () => parseOne(records).dispositions;

  it("detects retained responses that do not match the retained ledger entries", () => {
    const res = parseOne(records);
    const v = verifyWith({ responses: [...res.responses].reverse() });
    expect(v.problems).toEqual(["retained dispositions do not match the retained responses"]);
  });

  it("detects a response retained twice", () => {
    const d = ledger();
    const v = verifyWith({ dispositions: d.map((x) => (x.responseId === "r_a2" ? { ...x, responseId: "r_a1" } : x)) });
    expect(v.problems).toContain("a response ID was retained more than once");
  });

  it("detects a duplicate that refers to a response that was not retained", () => {
    const d = ledger();
    const v = verifyWith({
      dispositions: d.map((x) => (x.disposition === "exact_duplicate" ? { ...x, responseId: "r_ghost" } : x)),
    });
    expect(v.problems).toEqual([expect.stringContaining("refers to r_ghost, which was not retained")]);
  });

  it("detects a retained entry that carries a drop warning", () => {
    const d = ledger();
    const v = verifyWith({
      dispositions: d.map((x, i) => (i === 0 ? { ...x, warningCode: "duplicate_exact" as const } : x)),
    });
    expect(v.problems).toEqual([expect.stringContaining("carries drop warning duplicate_exact")]);
  });

  it("does not accept a warning with the right code at the wrong location", () => {
    const res = parseOne(records);
    const moved = res.warnings.map((w) => (w.code === "duplicate_exact" ? { ...w, line: 99 } : w));
    expect(verifyWith({ warnings: moved }).problems).toEqual([expect.stringContaining("has no matching duplicate_exact warning")]);
  });
});

describe("production entry point", () => {
  const configPath = fileURLToPath(new URL("../config/expected-dataset.json", import.meta.url));

  it("builds coverage only from the validated config", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-analysis-"));
    try {
      writeFileSync(join(dir, "responses.jsonl"), jsonl(schemaA()));
      const input = loadDatasetForAnalysis({ dataDir: dir, configPath });
      expect(input.coverage.expected.source).toEqual({ weeks: "config", engines: "config", promptIds: "config", runs: "config" });
      expect(input.coverage.expected.weeks).toEqual([1, 2, 3, 4, 5, 6]);
      // One record, so inference would have expected 1 week × 1 engine × 1 prompt × 1 run.
      expect(input.coverage.weeks).toHaveLength(6);
      expect(input.coverage.weeks[0]!.expectedSlots).toBe(90);
      expect(input.coverage.weeks[5]!.weekMissing).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run with a missing or invalid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-badconfig-"));
    try {
      writeFileSync(join(dir, "responses.jsonl"), jsonl(schemaA()));
      writeFileSync(join(dir, "bad-config.json"), JSON.stringify({ weeks: [1], engines: ["gemini"], promptIds: ["P01"], runs: [1] }));
      expect(() => loadDatasetForAnalysis({ dataDir: dir, configPath: join(dir, "missing.json") })).toThrow(ExpectedConfigError);
      expect(() => loadDatasetForAnalysis({ dataDir: dir, configPath: join(dir, "bad-config.json") })).toThrow(/Unsupported engine/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels a plain ExpectedDataset as config, and inference as inferred", () => {
    const responses = parseOne(jsonl(schemaA())).responses;
    const plan: ExpectedDataset = { weeks: [1], engines: ["chatgpt"], promptIds: ["P01"], runs: [1] };
    expect(buildCoverage(responses, plan).expected.source.engines).toBe("config");
    expect(buildCoverage(responses, inferExpectedDataset(responses)).expected.source.engines).toBe("inferred");
  });
});

describe("coverage gap summary", () => {
  it("separates wholly missing dimensions from individual missing slots", () => {
    const records = ["P01", "P02"]
      .flatMap((p) => [1, 2].map((run) => schemaA({ response_id: `r_${p}_${run}`, prompt_id: p, run })))
      .filter((r) => !(r.prompt_id === "P02" && r.run === 2)); // one stray gap on chatgpt
    const responses = parseOne(jsonl(...records)).responses;
    const plan: ExpectedDataset = { weeks: [1], engines: ["chatgpt", "perplexity"], promptIds: ["P01", "P02"], runs: [1, 2] };
    const g = summarizeCoverageGaps(buildCoverage(responses, plan).weeks[0]!.observed);
    expect(g.whollyMissing).toEqual({ engines: ["perplexity"], prompts: [], runs: [] });
    expect(g.slotsInWhollyMissing).toBe(4);
    expect(g.individualSlots).toEqual([{ engine: "chatgpt", promptId: "P02", run: 2 }]);
  });

  it("explains every slot of a missing week by wholly missing dimensions", () => {
    const plan: ExpectedDataset = { weeks: [1, 2], engines: ["chatgpt"], promptIds: ["P01"], runs: [1, 2] };
    const responses = parseOne(jsonl(schemaA(), schemaA({ response_id: "r_a2", run: 2 }))).responses;
    const g = summarizeCoverageGaps(buildCoverage(responses, plan).weeks[1]!.observed);
    expect(g).toEqual({ whollyMissing: { engines: ["chatgpt"], prompts: ["P01"], runs: [1, 2] }, slotsInWhollyMissing: 2, individualSlots: [] });
  });
});

describe("prompts.csv", () => {
  it("parses rows, quoted commas and priorities", () => {
    const csv = 'prompt_id,question,stage,priority\np01,"Corvane vs Trakvia, which is better?",specific_company,3\nP02,Cheapest?,comparing_options,x\n';
    const { prompts, warnings } = parsePromptsCsv(csv);
    expect(prompts).toEqual([
      { id: "P01", question: "Corvane vs Trakvia, which is better?", stage: "specific_company", priority: 3 },
      { id: "P02", question: "Cheapest?", stage: "comparing_options", priority: null },
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("determinism", () => {
  it("returns identical results across runs and regardless of file order", () => {
    const files: InputFile[] = [
      { name: "responses-a.jsonl", content: jsonl(schemaA(), schemaA({ response_id: "r_x", engine: "Mystery" })) },
      { name: "responses-b.json", content: JSON.stringify([schemaB(), schemaA()]) },
      { name: ".DS_Store", content: "" },
    ];
    const first = parseResponseFiles(files, { knownPromptIds: ["P01"] });
    const second = parseResponseFiles(files, { knownPromptIds: ["P01"] });
    const reversed = parseResponseFiles([...files].reverse(), { knownPromptIds: ["P01"] });
    expect(second).toEqual(first);
    expect(reversed).toEqual(first);
    expect(buildCoverage(second.responses, inferExpectedDataset(second.responses))).toEqual(
      buildCoverage(first.responses, inferExpectedDataset(first.responses)),
    );
  });
});

describe("loadDataset (filesystem)", () => {
  it("loads a directory, skipping .DS_Store and using prompts.csv", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvane-load-"));
    try {
      writeFileSync(join(dir, ".DS_Store"), Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]));
      writeFileSync(join(dir, "prompts.csv"), "prompt_id,question,stage,priority\nP01,Q1,early_research,1\n");
      writeFileSync(join(dir, "Responses.json"), JSON.stringify([schemaA(), schemaB()]));
      const ds = loadDataset(dir);
      expect(ds.prompts.map((p) => p.id)).toEqual(["P01"]);
      expect(ds.responses.map((r) => r.id)).toEqual(["r_a1", "r_b1"]);
      expect(ds.stats.ignoredFiles).toEqual([".DS_Store", "prompts.csv"]);
      expect(ds.warnings.some((w) => w.severity === "error")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
