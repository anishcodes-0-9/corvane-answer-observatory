/**
 * The single analysis path shared by the CLI scripts and the dashboard:
 * load → brand analysis (mentions, positions, tone) → wrong facts → scores.
 * Throws PipelineError with a readable message if any input is unusable.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeResponses } from "./brandAnalysis";
import { loadBrandCatalog } from "./brands";
import type { BrandAnalysisResult, BrandCatalog } from "./brandTypes";
import { findWrongFacts, parseFacts, type CompanyFacts, type WrongFact } from "./facts";
import { expandHome, loadDatasetForAnalysis, type AnalysisInput } from "./load";
import { buildMentionRows, validateMentionRows, type MentionRow } from "./mentionsCsv";
import { computeScores, type ScoreReport } from "./scoring";
import { sortWrongFacts, validateWrongFacts } from "./wrongFactsCsv";

/** Core requirement: wrong facts about the client. Competitor fact-checking is a stretch item. */
export const FACT_CHECK_BRANDS = ["corvane"];

export class PipelineError extends Error {}

export interface PipelineOptions {
  dataDir: string;
  expectedConfig?: string;
  brandConfig?: string;
}

export interface PipelineResult {
  input: AnalysisInput;
  catalog: BrandCatalog;
  analysis: BrandAnalysisResult;
  mentionRows: MentionRow[];
  facts: Map<string, CompanyFacts>;
  wrongFacts: WrongFact[];
  scores: ScoreReport;
}

export function runPipeline(options: PipelineOptions): PipelineResult {
  const dataDir = resolve(expandHome(options.dataDir));
  let input: AnalysisInput;
  try {
    input = loadDatasetForAnalysis({ dataDir, ...(options.expectedConfig ? { configPath: options.expectedConfig } : {}) });
  } catch (e) {
    throw new PipelineError((e as Error).message);
  }
  const { dataset, expected } = input;
  if (!dataset.stats.allRecordsAccountedFor) {
    throw new PipelineError("Not every input record is accounted for; run `npm run data-quality` for details.");
  }
  const { catalog, issues } = loadBrandCatalog({ dataDir, ...(options.brandConfig ? { configPath: options.brandConfig } : {}) });
  if (!catalog) throw new PipelineError(`Brand configuration error: ${issues.map((i) => i.message).join("; ")}`);

  let factsRaw: unknown;
  try {
    factsRaw = JSON.parse(readFileSync(join(dataDir, "facts.json"), "utf8"));
  } catch (e) {
    throw new PipelineError(`Cannot read facts.json from ${dataDir}: ${(e as Error).message}`);
  }
  const { facts, issues: factIssues } = parseFacts(factsRaw);
  if (factIssues.length > 0) throw new PipelineError(`facts.json problems: ${factIssues.join("; ")}`);
  for (const b of FACT_CHECK_BRANDS) if (!facts.has(b)) throw new PipelineError(`facts.json has no entry for "${b}"`);

  const analysis = analyzeResponses(dataset.responses, catalog);
  const brandIds = catalog.brands.map((b) => b.id);
  const mentionRows = buildMentionRows(analysis.responses, brandIds);
  const mentionProblems = validateMentionRows(mentionRows, dataset.responses.map((r) => r.id), brandIds);
  if (mentionProblems.length > 0) throw new PipelineError(`mentions.csv failed validation: ${mentionProblems.slice(0, 10).join("; ")}`);

  const analysed = dataset.responses.filter((r) => r.status === "ok");
  const byId = new Map(analysis.responses.map((a) => [a.responseId, a]));
  const wrongFacts = sortWrongFacts(
    analysed.flatMap((r) => {
      const a = byId.get(r.id);
      return a && a.status === "analyzed"
        ? findWrongFacts(r.id, r.text, a.brands.flatMap((b) => b.matches), a.decoys, facts, FACT_CHECK_BRANDS)
        : [];
    }),
    dataset.responses.map((r) => r.id),
  );
  const factProblems = validateWrongFacts(wrongFacts, new Map(analysed.map((r) => [r.id, r.text])), facts, FACT_CHECK_BRANDS);
  if (factProblems.length > 0) throw new PipelineError(`wrong_facts.csv failed validation: ${factProblems.slice(0, 10).join("; ")}`);

  const scores = computeScores(dataset.responses, analysis.responses, catalog.brands.map((b) => ({ id: b.id, tier: b.tier })), expected);
  return { input, catalog, analysis, mentionRows, facts, wrongFacts, scores };
}
