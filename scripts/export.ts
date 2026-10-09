/**
 * Writes the brief's scoring export to out/:
 *   mentions.csv     response_id, brand, mentioned, position, tone
 *   wrong_facts.csv  response_id, brand, fact_key, claim_text   (Corvane only)
 *
 *   DATA_DIR=~/Downloads/corvane_data_pack npm run export
 *
 * Refuses to write if the input is not fully accounted for, a configuration
 * file is invalid, or any row breaks the brief's schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mentionsCsv } from "../src/lib/mentionsCsv";
import { FACT_CHECK_BRANDS, PipelineError, runPipeline } from "../src/lib/pipeline";
import { wrongFactsCsv } from "../src/lib/wrongFactsCsv";

let result: ReturnType<typeof runPipeline>;
try {
  result = runPipeline({
    dataDir: process.env.DATA_DIR ?? "./data",
    ...(process.env.EXPECTED_CONFIG ? { expectedConfig: process.env.EXPECTED_CONFIG } : {}),
    ...(process.env.BRAND_CONFIG ? { brandConfig: process.env.BRAND_CONFIG } : {}),
  });
} catch (e) {
  if (e instanceof PipelineError) {
    console.error(`Refusing to export: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const { input, analysis, mentionRows, wrongFacts, catalog } = result;
const outDir = resolve(process.env.OUT_DIR ?? "out");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "mentions.csv"), mentionsCsv(mentionRows));
writeFileSync(resolve(outDir, "wrong_facts.csv"), wrongFactsCsv(wrongFacts));

const responses = input.dataset.responses.length;
const notAnalyzed = analysis.responses.filter((r) => r.status === "not_analyzed").length;
console.log(`mentions.csv: ${mentionRows.length} rows = ${responses} responses × ${catalog.brands.length} brands`);
console.log(`  ${notAnalyzed} not-analysed responses (errors/empty) exported as mentioned=false with blank position and tone`);
console.log(`  mentioned rows: ${mentionRows.filter((r) => r.mentioned).length}`);
const byKey = new Map<string, number>();
for (const w of wrongFacts) byKey.set(w.factKey, (byKey.get(w.factKey) ?? 0) + 1);
console.log(`wrong_facts.csv: ${wrongFacts.length} rows (${FACT_CHECK_BRANDS.join(", ")}) in ${new Set(wrongFacts.map((w) => w.responseId)).size} answers`);
for (const [k, n] of [...byKey].sort()) console.log(`  ${k}: ${n}`);
