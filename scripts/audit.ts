/**
 * Manual accuracy audit.
 *
 *   DATA_DIR=... npm run audit:sample    writes validation/manual-review.csv (blind)
 *                                        and validation/manual-review-predictions.csv
 *   npm run audit:compare                scores the tool against your completed labels
 *                                        and writes validation/manual-review-results.md
 *
 * The sample is reproducible (fixed seed). The sample command refuses to
 * overwrite a review sheet that already has labels in it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUDIT_SEED, AUDIT_SIZE, compareAudit, parseAuditSheet, predictionSheet, reviewSheet, sampleForAudit, type AuditResult } from "../src/lib/audit";
import { parseCsv } from "../src/lib/load";
import { PipelineError, runPipeline } from "../src/lib/pipeline";

const BRANDS = ["corvane", "trakvia", "routelyne", "gridwell", "fleetora", "novahaul"];
const DIR = resolve("validation");
const SHEET = resolve(DIR, "manual-review.csv");
const PRED = resolve(DIR, "manual-review-predictions.csv");
const RESULTS = resolve(DIR, "manual-review-results.md");
const mode = process.argv[2];

if (mode === "sample") {
  if (existsSync(SHEET)) {
    const existing = parseAuditSheet(parseCsv(readFileSync(SHEET, "utf8")), BRANDS, false).rows;
    const labelled = existing.filter((r) => Object.values(r.brands).some((b) => b.mentioned) || r.notes);
    if (labelled.length > 0 && !process.argv.includes("--force")) {
      console.error(`${SHEET} already has labels in ${labelled.length} rows; refusing to overwrite (use --force).`);
      process.exit(1);
    }
  }
  let result: ReturnType<typeof runPipeline>;
  try {
    result = runPipeline({ dataDir: process.env.DATA_DIR ?? "./data" });
  } catch (e) {
    console.error(e instanceof PipelineError ? e.message : e);
    process.exit(1);
  }
  const { input, analysis } = result;
  const sample = sampleForAudit(input.dataset.responses);
  const questions = Object.fromEntries(input.dataset.prompts.map((p) => [p.id, p.question]));
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SHEET, reviewSheet(sample, questions, BRANDS));
  writeFileSync(PRED, predictionSheet(sample, analysis.responses, BRANDS));
  console.log(`Sampled ${sample.length} of ${input.dataset.responses.filter((r) => r.status === "ok").length} analysable answers (seed "${AUDIT_SEED}", size ${AUDIT_SIZE}):`);
  for (const r of sample) console.log(`  ${r.id}  W${r.week} ${r.engine} ${r.promptId} run ${r.run}`);
  console.log(`\nLabel ${SHEET} without opening ${PRED}. Instructions: validation/MANUAL_REVIEW.md`);
} else if (mode === "compare") {
  if (!existsSync(SHEET) || !existsSync(PRED)) {
    console.error("Run `npm run audit:sample` first.");
    process.exit(1);
  }
  const human = parseAuditSheet(parseCsv(readFileSync(SHEET, "utf8")), BRANDS, true);
  if (human.problems.length > 0) {
    console.error(`The review sheet is not complete yet; no accuracy is reported until it is.\n  ${human.problems.slice(0, 15).join("\n  ")}${human.problems.length > 15 ? `\n  … ${human.problems.length - 15} more` : ""}`);
    process.exit(1);
  }
  const tool = parseAuditSheet(parseCsv(readFileSync(PRED, "utf8")), BRANDS, true);
  const all = compareAudit(human.rows, tool.rows, BRANDS);
  const clear = compareAudit(human.rows, tool.rows, BRANDS, { excludeAmbiguous: true });
  const pct = (a: number, t: number) => (t ? `${a}/${t} (${((100 * a) / t).toFixed(1)}%)` : "n/a");
  const block = (title: string, r: AuditResult) =>
    [
      `### ${title} (${r.answers} answers)`,
      "",
      `| Measure | Result |`,
      `|---|---|`,
      `| Mentions (answer × company cells) | ${pct(r.mention.agree, r.mention.total)} |`,
      `| Mention precision | ${r.mention.precision === null ? "n/a" : r.mention.precision.toFixed(3)} (${r.mention.falsePositive} false positives) |`,
      `| Mention recall | ${r.mention.recall === null ? "n/a" : r.mention.recall.toFixed(3)} (${r.mention.falseNegative} missed) |`,
      `| Position, where both found the company | ${pct(r.position.agree, r.position.total)} |`,
      `| Tone, where both found the company | ${pct(r.tone.agree, r.tone.total)} |`,
      "",
    ].join("\n");
  const notes = human.rows.filter((r) => r.ambiguous || r.notes).map((r) => `- ${r.responseId}${r.ambiguous ? " (ambiguous)" : ""}: ${r.notes || "no note"}`);
  const md = [
    "# Manual accuracy audit: results",
    "",
    `Sample: ${human.rows.length} answers drawn at random (seed \`${AUDIT_SEED}\`) from the analysable answers, labelled by hand before looking at the tool's predictions.`,
    "",
    block("All sampled answers", all),
    block("Excluding answers marked ambiguous", clear),
    "## Disagreements",
    "",
    all.disagreements.length === 0
      ? "None."
      : ["| Answer | Company | Field | Human | Tool | Ambiguous |", "|---|---|---|---|---|---|", ...all.disagreements.map((d) => `| ${d.responseId} | ${d.brand} | ${d.field} | ${d.human} | ${d.tool} | ${d.ambiguous ? "yes" : ""} |`)].join("\n"),
    "",
    "## Reviewer notes",
    "",
    notes.length ? notes.join("\n") : "None.",
    "",
  ].join("\n");
  writeFileSync(RESULTS, md);
  console.log(md);
} else {
  console.error("usage: tsx scripts/audit.ts sample|compare");
  process.exit(2);
}
