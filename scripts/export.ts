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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { loadBrandCatalog } from "../src/lib/brands";
import { findWrongFacts, parseFacts } from "../src/lib/facts";
import { expandHome, loadDatasetForAnalysis } from "../src/lib/load";
import { buildMentionRows, mentionsCsv, validateMentionRows } from "../src/lib/mentionsCsv";
import { sortWrongFacts, validateWrongFacts, wrongFactsCsv } from "../src/lib/wrongFactsCsv";

/** Core requirement: wrong facts about the client. Competitor fact-checking is a stretch item. */
const FACT_CHECK_BRANDS = ["corvane"];

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

let factsRaw: unknown;
try {
  factsRaw = JSON.parse(readFileSync(join(dataDir, "facts.json"), "utf8"));
} catch (e) {
  fail(`Cannot read facts.json from ${dataDir}: ${(e as Error).message}`);
}
const { facts, issues: factIssues } = parseFacts(factsRaw);
if (factIssues.length > 0) fail(`facts.json problems:\n  ${factIssues.join("\n  ")}`);
for (const b of FACT_CHECK_BRANDS) if (!facts.has(b)) fail(`facts.json has no entry for "${b}"`);

// mentions.csv
const analysis = analyzeResponses(dataset.responses, catalog!);
const brandIds = catalog!.brands.map((b) => b.id);
const rows = buildMentionRows(analysis.responses, brandIds);
const problems = validateMentionRows(rows, dataset.responses.map((r) => r.id), brandIds);
if (problems.length > 0) fail(`mentions.csv failed validation:\n  ${problems.slice(0, 20).join("\n  ")}`);

// wrong_facts.csv (analysed responses only; collector errors have no claims)
const analysed = dataset.responses.filter((r) => r.status === "ok");
const byId = new Map(analysis.responses.map((a) => [a.responseId, a]));
const wrong = sortWrongFacts(
  analysed.flatMap((r) => {
    const a = byId.get(r.id)!;
    if (a.status !== "analyzed") return [];
    return findWrongFacts(r.id, r.text, a.brands.flatMap((b) => b.matches), a.decoys, facts, FACT_CHECK_BRANDS);
  }),
  dataset.responses.map((r) => r.id),
);
const wrongProblems = validateWrongFacts(wrong, new Map(analysed.map((r) => [r.id, r.text])), facts, FACT_CHECK_BRANDS);
if (wrongProblems.length > 0) fail(`wrong_facts.csv failed validation:\n  ${wrongProblems.slice(0, 20).join("\n  ")}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "mentions.csv"), mentionsCsv(rows));
writeFileSync(resolve(outDir, "wrong_facts.csv"), wrongFactsCsv(wrong));

const notAnalyzed = analysis.responses.filter((r) => r.status === "not_analyzed").length;
console.log(`mentions.csv: ${rows.length} rows = ${dataset.responses.length} responses × ${brandIds.length} brands`);
console.log(`  ${notAnalyzed} not-analysed responses (errors/empty) exported as mentioned=false with blank position and tone`);
console.log(`  mentioned rows: ${rows.filter((r) => r.mentioned).length}`);
const byKey = new Map<string, number>();
for (const w of wrong) byKey.set(w.factKey, (byKey.get(w.factKey) ?? 0) + 1);
console.log(`wrong_facts.csv: ${wrong.length} rows (${FACT_CHECK_BRANDS.join(", ")}) in ${new Set(wrong.map((w) => w.responseId)).size} answers`);
for (const [k, n] of [...byKey].sort()) console.log(`  ${k}: ${n}`);
