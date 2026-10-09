/**
 * Prints weekly visibility scores and week-on-week changes, and writes the
 * full report to out/scores.json.
 *
 *   DATA_DIR=~/Downloads/corvane_data_pack npm run scores
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PipelineError, runPipeline } from "../src/lib/pipeline";

let result: ReturnType<typeof runPipeline>;
try {
  result = runPipeline({ dataDir: process.env.DATA_DIR ?? "./data" });
} catch (e) {
  if (e instanceof PipelineError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const { scores } = result;
const outDir = resolve(process.env.OUT_DIR ?? "out");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);

const first = scores.brands[0]!;
console.log("Coverage per week (same for every brand):");
for (const w of first.weeks) {
  console.log(
    `  week ${w.week}: ${w.observedSlots}/${w.expectedSlots} slots observed${w.partial ? ` — PARTIAL (missing engines: ${w.missingEngines.join(", ") || "none"}; ${w.missingSlots} slots missing)` : ""}`,
  );
}
for (const b of scores.brands) {
  console.log(`\n${b.brand} (${b.tier})`);
  console.log(`  scores: ${b.weeks.map((w) => `w${w.week} ${w.score ?? "—"}${w.partial ? "*" : ""}`).join("  ")}   (* partial week)`);
  for (const c of b.changes) {
    const range = c.interval ? ` [${c.interval.low}, ${c.interval.high}]` : "";
    console.log(`  w${c.fromWeek}→w${c.toWeek}: ${c.meanChange ?? "—"} over ${c.matchedSlots} matched slots${range} → ${c.verdict}`);
  }
}
console.log(`\nWrote ${resolve(outDir, "scores.json")}`);
