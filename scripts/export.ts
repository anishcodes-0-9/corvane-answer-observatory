/**
 * Writes the brief's scoring export to out/:
 *   mentions.csv   response_id, brand, mentioned, position, tone
 *
 *   DATA_DIR=~/Downloads/corvane_data_pack npm run export
 *
 * Refuses to write if the input is not fully accounted for, the brand
 * configuration is invalid, or the rows break the brief's schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { loadBrandCatalog } from "../src/lib/brands";
import { expandHome, loadDatasetForAnalysis } from "../src/lib/load";
import { buildMentionRows, mentionsCsv, validateMentionRows } from "../src/lib/mentionsCsv";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const dataDir = resolve(expandHome(process.env.DATA_DIR ?? "./data"));
const outDir = resolve(process.env.OUT_DIR ?? "out");
const { dataset } = loadDatasetForAnalysis({ dataDir, ...(process.env.EXPECTED_CONFIG ? { configPath: process.env.EXPECTED_CONFIG } : {}) });
if (!dataset.stats.allRecordsAccountedFor) fail("Refusing to export: not every input record is accounted for (run `npm run data-quality`).");
const { catalog, issues } = loadBrandCatalog({ dataDir, ...(process.env.BRAND_CONFIG ? { configPath: process.env.BRAND_CONFIG } : {}) });
if (!catalog) fail(`Brand configuration error:\n  ${issues.map((i) => i.message).join("\n  ")}`);

const analysis = analyzeResponses(dataset.responses, catalog!);
const brandIds = catalog!.brands.map((b) => b.id);
const rows = buildMentionRows(analysis.responses, brandIds);
const problems = validateMentionRows(rows, dataset.responses.map((r) => r.id), brandIds);
if (problems.length > 0) fail(`mentions.csv failed validation:\n  ${problems.slice(0, 20).join("\n  ")}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "mentions.csv"), mentionsCsv(rows));

const notAnalyzed = analysis.responses.filter((r) => r.status === "not_analyzed").length;
console.log(`mentions.csv: ${rows.length} rows = ${dataset.responses.length} responses × ${brandIds.length} brands`);
console.log(`  ${notAnalyzed} not-analysed responses (errors/empty) exported as mentioned=false with blank position and tone`);
console.log(`  mentioned rows: ${rows.filter((r) => r.mentioned).length}`);
