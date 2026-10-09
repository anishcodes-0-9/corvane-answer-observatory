/**
 * Runs brand detection over a data directory and writes a reviewable artifact.
 *
 *   DATA_DIR=~/Downloads/corvane_data_pack npm run brand-analysis
 *   DATA_DIR=... npm run brand-analysis -- --out out/brand-analysis.json
 *
 * Environment: DATA_DIR (default ./data), BRAND_CONFIG, EXPECTED_CONFIG.
 * The artifact is deterministic: no timestamps or absolute paths, and inputs
 * are identified by SHA-256 so identical inputs give byte-identical output.
 * Exits 1 without writing if the input is not fully accounted for or the
 * brand configuration is invalid.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeResponses } from "../src/lib/brandAnalysis";
import { DEFAULT_BRAND_CONFIG, loadBrandCatalog } from "../src/lib/brands";
import { DEFAULT_EXPECTED_CONFIG, ExpectedConfigError, expandHome, loadDatasetForAnalysis } from "../src/lib/load";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const dataDir = resolve(expandHome(process.env.DATA_DIR ?? "./data"));
if (!existsSync(dataDir)) fail(`Data directory not found: ${dataDir}`);
const brandConfig = resolve(expandHome(process.env.BRAND_CONFIG ?? DEFAULT_BRAND_CONFIG));
const expectedConfig = resolve(expandHome(process.env.EXPECTED_CONFIG ?? DEFAULT_EXPECTED_CONFIG));
const outArg = process.argv.indexOf("--out");
const outFile = resolve(outArg !== -1 && process.argv[outArg + 1] ? process.argv[outArg + 1]! : "out/brand-analysis.json");

let input: ReturnType<typeof loadDatasetForAnalysis>;
try {
  input = loadDatasetForAnalysis({ dataDir, configPath: expectedConfig });
} catch (e) {
  if (e instanceof ExpectedConfigError) fail(`Expected-dataset config error:\n  ${e.warnings.map((w) => w.message).join("\n  ")}`);
  throw e;
}
const { dataset } = input;
if (!dataset.stats.allRecordsAccountedFor) {
  fail(
    "Refusing to analyse: not every input record is accounted for. Run `npm run data-quality` for details.\n" +
      `  unsplittable: ${dataset.stats.unsplittableFiles.join(", ") || "none"}; unreadable: ${dataset.stats.unreadableFiles.join(", ") || "none"}; ` +
      `nested: ${dataset.stats.nestedResponseFiles.join(", ") || "none"}; ledger problems: ${dataset.stats.accounting.problems.join("; ") || "none"}`,
  );
}

const { catalog, issues } = loadBrandCatalog({ dataDir, configPath: brandConfig });
for (const i of issues.filter((x) => x.severity === "warn")) console.warn(`warn: ${i.message}${i.file ? ` [${i.file}]` : ""}`);
if (!catalog) {
  fail(`Brand configuration error:\n  ${issues.filter((x) => x.severity === "error").map((i) => `${i.message}${i.file ? ` [${i.file}]` : ""}`).join("\n  ")}`);
}

const result = analyzeResponses(dataset.responses, catalog!);

// Consistency: exactly one analysis per retained response, in the same order.
const ids = result.responses.map((r) => r.responseId);
if (ids.length !== dataset.responses.length || ids.some((id, i) => id !== dataset.responses[i]!.id)) {
  fail("Internal error: analysis does not cover each retained response exactly once");
}

// Paths in the artifact are relative to the repository root, so output does not depend on the working directory.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRelative = (file: string) => relative(repoRoot, file) || basename(file);
const artifact = {
  schema: "brand-analysis/v1",
  inputs: {
    responseFiles: dataset.stats.responseFiles.map((name) => ({ name, sha256: sha256(join(dataDir, name)) })),
    brandsFile: { name: basename(join(dataDir, "brands.json")), sha256: sha256(join(dataDir, "brands.json")) },
    brandConfig: { path: repoRelative(brandConfig), sha256: sha256(brandConfig) },
    expectedConfig: { path: repoRelative(expectedConfig), sha256: sha256(expectedConfig) },
  },
  loader: {
    rawRecords: dataset.stats.rawRecords,
    uniqueResponses: dataset.stats.uniqueResponses,
    byStatus: dataset.stats.byStatus,
    allRecordsAccountedFor: dataset.stats.allRecordsAccountedFor,
  },
  catalog: {
    brands: catalog!.brands.map((b) => ({ id: b.id, name: b.name, website: b.website, tier: b.tier, forms: b.forms.map((f) => f.label) })),
    decoys: catalog!.decoys.map((d) => ({ id: d.id, name: d.name, brand: d.brand })),
    fuzzy: catalog!.fuzzy,
    wordList: catalog!.wordList ? { source: catalog!.wordList.source, size: catalog!.wordList.size } : null,
  },
  summary: result.summary,
  responses: result.responses,
};
const json = `${JSON.stringify(artifact, null, 2)}\n`;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, json);

const s = result.summary;
console.log(`Responses: ${s.responses} (analysed ${s.analyzed}; not analysed: ${s.notAnalyzed.error} error, ${s.notAnalyzed.empty} empty)`);
console.log("Brand                 tier                 mentioned in   website  name  alias  fuzzy");
for (const b of s.byBrand) {
  const m = b.matches;
  console.log(
    `  ${b.brand.padEnd(20)}${b.tier.padEnd(21)}${String(b.responsesMentioning).padStart(6)} answers  ${String(m.website).padStart(7)}${String(m.name).padStart(6)}${String(m.alias).padStart(7)}${String(m.fuzzy).padStart(7)}`,
  );
}
console.log(`Answers containing a decoy: ${s.decoyResponses}; fuzzy matches: ${s.fuzzyMatches}; ambiguous candidates: ${s.ambiguousCandidates}`);
console.log(`Wrote ${repoRelative(outFile)} (sha256 ${createHash("sha256").update(json).digest("hex")})`);
