/**
 * Applies brand matching to loader responses. Only "ok" responses are
 * analysed; error/empty responses are recorded as not analysed, never as
 * "no brands mentioned". Positions follow the brief: the order in which brands
 * are first named in the answer text, starting at 1.
 */
import type {
  BrandAnalysisResult,
  BrandAnalysisSummary,
  BrandCatalog,
  BrandResult,
  MatchType,
  ResponseBrandAnalysis,
  ResponseProvenance,
} from "./brandTypes";
import { findBrandMatches } from "./brandMatch";
import { classifyTones } from "./tone";
import type { NormalizedResponse } from "./types";

function provenance(r: NormalizedResponse): ResponseProvenance {
  return {
    responseId: r.id,
    week: r.week,
    engine: r.engine,
    promptId: r.promptId,
    run: r.run,
    source: { ...r.source },
  };
}

export function analyzeResponse(r: NormalizedResponse, catalog: BrandCatalog): ResponseBrandAnalysis {
  if (r.status !== "ok") {
    return { ...provenance(r), status: "not_analyzed", reason: r.status, error: r.error };
  }
  const { matches, decoys, ambiguous } = findBrandMatches(r.text, catalog);

  const firstAt = new Map<string, number>();
  for (const m of matches) if (!firstAt.has(m.brand)) firstAt.set(m.brand, m.start);
  const order = [...firstAt.entries()].sort((a, b) => a[1] - b[1]).map(([brand]) => brand);

  const tones = classifyTones(r.text, matches, decoys);
  const brands: BrandResult[] = catalog.brands.map((b) => {
    const own = matches.filter((m) => m.brand === b.id);
    const rank = order.indexOf(b.id);
    const tone = tones.get(b.id);
    return {
      brand: b.id,
      mentioned: own.length > 0,
      position: rank === -1 ? null : rank + 1,
      tone: own.length > 0 ? (tone?.tone ?? "neutral") : null,
      toneEvidence: own.length > 0 ? (tone?.evidence ?? []) : [],
      matches: own,
    };
  });
  return { ...provenance(r), status: "analyzed", brands, decoys, ambiguous };
}

export function analyzeResponses(responses: readonly NormalizedResponse[], catalog: BrandCatalog): BrandAnalysisResult {
  const results = responses.map((r) => analyzeResponse(r, catalog));
  return { responses: results, summary: summarize(results, catalog) };
}

function summarize(results: readonly ResponseBrandAnalysis[], catalog: BrandCatalog): BrandAnalysisSummary {
  const emptyCounts = (): Record<MatchType, number> => ({ website: 0, name: 0, alias: 0, fuzzy: 0 });
  const byBrand = catalog.brands.map((b) => ({
    brand: b.id,
    tier: b.tier,
    responsesMentioning: 0,
    matches: emptyCounts(),
    tones: { recommended: 0, neutral: 0, negative: 0, not_recommended: 0 },
  }));
  const index = new Map(byBrand.map((b) => [b.brand, b]));
  const summary: BrandAnalysisSummary = {
    responses: results.length,
    analyzed: 0,
    notAnalyzed: { error: 0, empty: 0 },
    byBrand,
    decoyResponses: 0,
    ambiguousCandidates: 0,
    fuzzyMatches: 0,
  };
  for (const r of results) {
    if (r.status === "not_analyzed") {
      summary.notAnalyzed[r.reason] += 1;
      continue;
    }
    summary.analyzed += 1;
    if (r.decoys.length > 0) summary.decoyResponses += 1;
    summary.ambiguousCandidates += r.ambiguous.length;
    for (const b of r.brands) {
      const row = index.get(b.brand)!;
      if (b.mentioned) row.responsesMentioning += 1;
      if (b.tone) row.tones[b.tone] += 1;
      for (const m of b.matches) {
        row.matches[m.matchType] += 1;
        if (m.matchType === "fuzzy") summary.fuzzyMatches += 1;
      }
    }
  }
  return summary;
}
