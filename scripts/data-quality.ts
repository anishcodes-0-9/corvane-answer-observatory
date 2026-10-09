/**
 * Prints the loader's data-quality report for a data directory.
 *
 *   DATA_DIR=~/Downloads/corvane_data_pack npm run data-quality
 *   DATA_DIR=... npm run data-quality -- --json   # machine-readable
 *
 * Coverage always uses the validated expected-dataset config
 * (config/expected-dataset.json, or EXPECTED_CONFIG). Exits with code 1 if the
 * directory or config is unusable, or if not every input record is accounted for.
 */
import { existsSync } from "node:fs";
import { ExpectedConfigError, expandHome, loadDatasetForAnalysis, summarizeCoverageGaps } from "../src/lib/load";
import type { AnalysisInput } from "../src/lib/load";
import type { CoverageLevel, DataQualityWarning, SlotRef } from "../src/lib/types";

const dataDir = expandHome(process.env.DATA_DIR ?? "./data");
if (!existsSync(dataDir)) {
  console.error(`Data directory not found: ${dataDir}\nSet DATA_DIR to the folder containing the responses file.`);
  process.exit(1);
}

let input: AnalysisInput;
try {
  input = loadDatasetForAnalysis({ dataDir, ...(process.env.EXPECTED_CONFIG ? { configPath: process.env.EXPECTED_CONFIG } : {}) });
} catch (e) {
  if (e instanceof ExpectedConfigError) {
    for (const w of e.warnings) console.error(`${w.severity}: ${w.message} [${w.file ?? "config"}]`);
    process.exit(1);
  }
  throw e;
}
const { dataset: ds, coverage, warnings } = input;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ dataDir: ds.dataDir, stats: ds.stats, warnings, coverage, dispositions: ds.dispositions }, null, 2),
  );
} else {
  const s = ds.stats;
  const a = s.accounting;
  console.log(`Data directory: ${ds.dataDir}`);
  console.log(`Response files: ${s.responseFiles.join(", ") || "(none)"}`);
  console.log(`Ignored files:  ${s.ignoredFiles.join(", ") || "(none)"}`);
  console.log(`Prompts:        ${ds.prompts.length}`);

  console.log("\nFile-level failures (records inside cannot be counted):");
  if (!s.unsplittableFiles.length && !s.unreadableFiles.length && !s.nestedResponseFiles.length) console.log("  none");
  if (s.unsplittableFiles.length) console.log(`  could not be split into records: ${s.unsplittableFiles.join(", ")}`);
  if (s.unreadableFiles.length) console.log(`  could not be read: ${s.unreadableFiles.join(", ")}`);
  if (s.nestedResponseFiles.length) console.log(`  in subdirectories, not loaded: ${s.nestedResponseFiles.join(", ")}`);

  console.log("\nRecord ledger (every raw record has one disposition):");
  console.log(`  Raw records              ${a.rawRecords}`);
  console.log(`  = retained (unique)      ${a.retained}   (ok ${s.byStatus.ok}, error ${s.byStatus.error}, empty ${s.byStatus.empty})`);
  console.log(`  + malformed              ${a.malformed}`);
  console.log(`  + invalid (skipped)      ${a.invalid}`);
  console.log(`  + exact duplicates       ${a.exactDuplicates}`);
  console.log(`  + conflicting duplicates ${a.conflictingDuplicates}`);
  console.log(`  Ledger balanced: ${a.balanced ? "yes" : "NO"}${a.problems.length ? `\n    ${a.problems.join("\n    ")}` : ""}`);
  console.log(`All input records accounted for: ${s.allRecordsAccountedFor ? "yes" : "NO"}`);

  console.log("\nWarnings by code:");
  const groups = new Map<string, DataQualityWarning[]>();
  for (const w of warnings) groups.set(`${w.severity}:${w.code}`, [...(groups.get(`${w.severity}:${w.code}`) ?? []), w]);
  for (const [key, list] of [...groups].sort(([x], [y]) => (x < y ? -1 : 1))) {
    console.log(`  ${key}  ×${list.length}`);
    for (const w of list.slice(0, 10)) {
      const loc = w.file ? ` [${w.file}${w.line != null ? `:${w.line}` : w.recordIndex !== undefined ? ` #${w.recordIndex}` : ""}]` : "";
      const count = w.count !== undefined ? ` (×${w.count})` : "";
      console.log(`      ${w.message}${count}${loc}`);
    }
    if (list.length > 10) console.log(`      … ${list.length - 10} more`);
  }

  const e = coverage.expected;
  console.log(
    `\nCoverage against config: weeks ${e.weeks.join(",")} × ${e.engines.length} engines (${e.engines.join(", ")}) × ${e.promptIds.length} prompts × runs ${e.runs.join(",")}`,
  );
  const u = coverage.unexpected;
  const unexpectedNotes = [
    u.weeks.length ? `weeks ${u.weeks.join(", ")}` : "",
    u.engines.length ? `engines ${u.engines.join(", ")}` : "",
    u.promptIds.length ? `prompts ${u.promptIds.join(", ")}` : "",
    u.runs.length ? `runs ${u.runs.join(", ")}` : "",
    u.recordsWithoutRun.length ? `${u.recordsWithoutRun.length} records without a run` : "",
  ].filter(Boolean);
  console.log(`  Data outside the config: ${unexpectedNotes.length ? unexpectedNotes.join("; ") : "none"}`);

  const slotList = (slots: SlotRef[]) => slots.map((x) => `${x.engine} ${x.promptId}/r${x.run}`).join(", ");
  const describeGaps = (label: string, level: CoverageLevel) => {
    const g = summarizeCoverageGaps(level);
    const wholly = [
      g.whollyMissing.engines.length ? `engines ${g.whollyMissing.engines.join(", ")}` : "",
      g.whollyMissing.prompts.length ? `prompts ${g.whollyMissing.prompts.join(", ")}` : "",
      g.whollyMissing.runs.length ? `runs ${g.whollyMissing.runs.join(", ")}` : "",
    ].filter(Boolean);
    if (wholly.length) console.log(`      ${label}, wholly missing: ${wholly.join("; ")} (${g.slotsInWhollyMissing} slots)`);
    if (g.individualSlots.length) {
      console.log(`      ${label}, individual slots (${g.individualSlots.length}): ${slotList(g.individualSlots)}`);
    }
  };

  for (const w of coverage.weeks) {
    const status = w.weekMissing
      ? "WEEK MISSING (no records)"
      : !w.observed.complete
        ? "INCOMPLETE"
        : w.usable.complete
          ? "complete"
          : "all slots observed, some not usable";
    console.log(
      `  Week ${w.week}${w.expectedWeek ? "" : " (not in config)"}: observed ${w.observed.slots}/${w.expectedSlots}, usable ${w.usable.slots}/${w.expectedSlots}: ${status}`,
    );
    describeGaps("Not observed", w.observed);
    if (w.unusableSlots.length) {
      console.log(`      Observed but not usable (error/empty records): ${slotList(w.unusableSlots)}`);
    }
    if (w.unslottedRecords.length) console.log(`      Records outside the config: ${w.unslottedRecords.join(", ")}`);
  }
}

if (!ds.stats.allRecordsAccountedFor) process.exit(1);
