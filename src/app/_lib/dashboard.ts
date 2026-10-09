/**
 * Server-only view model for the dashboard. It reshapes the output of
 * runPipeline() for display and never re-implements matching, tone, fact or
 * scoring rules.
 */
import { cache } from "react";
import type { BrandTier, ResponseBrandAnalysis } from "../../lib/brandTypes";
import { PipelineError, runPipeline, type PipelineResult } from "../../lib/pipeline";
import type { WeekChange, WeekScore } from "../../lib/scoring";
import type { Tone } from "../../lib/tone";

export const TRACKED = ["corvane", "trakvia", "routelyne", "gridwell"] as const;
export const BRAND_COLOR: Record<string, string> = {
  corvane: "var(--signal)",
  trakvia: "var(--steel)",
  routelyne: "var(--sand)",
  gridwell: "var(--sage)",
  fleetora: "var(--other)",
  novahaul: "var(--other)",
};
export const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  google_ai_overview: "AI Overviews",
};
export const FACT_LABEL: Record<string, string> = {
  hq: "Headquarters",
  founded: "Founding year",
  starting_price_usd: "Starting price",
  integrations: "Integrations",
  "features.dashcams": "Dashcams",
  "features.eld_compliance": "ELD compliance",
  "features.payroll": "Payroll",
  "features.driver_app": "Driver app",
  "features.gps_tracking": "GPS tracking",
  "features.fuel_card_integration": "Fuel-card integration",
  "features.maintenance_alerts": "Maintenance alerts",
};

export type FieldState = Tone | "absent" | "error" | "missing";

export interface BrandView {
  id: string;
  name: string;
  tier: BrandTier;
  tracked: boolean;
  weeks: WeekScore[];
  changes: WeekChange[];
  /** Latest week: share of analysed answers that mention / recommend the brand. */
  latestMentionRate: number | null;
  latestRecommendRate: number | null;
}

export interface FactGroup {
  factKey: string;
  label: string;
  truth: string;
  count: number;
  answers: number;
  engines: Record<string, number>;
  weeks: number[];
  claims: Array<{ text: string; count: number; responseIds: string[] }>;
  topSources: Array<{ domain: string; count: number }>;
}

export interface Gap {
  promptId: string;
  question: string;
  runs: number;
  recommended: Array<{ brand: string; name: string }>;
}

export interface DashboardData {
  brands: BrandView[];
  weeks: Array<{ week: number; dates: string; observed: number; expected: number; partial: boolean; missingEngines: string[] }>;
  latestWeek: number;
  questions: Record<string, string>;
  field: Array<{ week: number; engine: number; prompt: number; run: number; state: FieldState }>;
  engines: string[];
  promptIds: string[];
  totals: { records: number; analysed: number; notAnalysed: number; missingSlots: number };
  factGroups: FactGroup[];
  wrongFactCount: number;
  gaps: Gap[];
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function dateRange(isoDates: string[]): string {
  if (isoDates.length === 0) return "dates unavailable";
  const sorted = [...isoDates].sort();
  const a = new Date(sorted[0]!);
  const b = new Date(sorted[sorted.length - 1]!);
  if (a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)) return MONTH_YEAR.format(a);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return sameMonth ? `${DAY.format(a)}–${MONTH_YEAR.format(b)}` : `${MONTH_YEAR.format(a).replace(/ \d{4}$/, "")} – ${MONTH_YEAR.format(b)}`;
}

function domainOf(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

export type DashboardResult = { ok: true; data: DashboardData; pipeline: PipelineResult } | { ok: false; error: string; dataDir: string };

export const loadDashboard = cache((): DashboardResult => {
  const dataDir = process.env.DATA_DIR ?? "./data";
  let pipeline: PipelineResult;
  try {
    pipeline = runPipeline({ dataDir });
  } catch (e) {
    return { ok: false, error: e instanceof PipelineError ? e.message : (e as Error).message, dataDir };
  }
  return { ok: true, data: buildView(pipeline), pipeline };
});

function buildView(p: PipelineResult): DashboardData {
  const { input, catalog, analysis, scores, wrongFacts, facts } = p;
  const responses = input.dataset.responses;
  const expected = input.expected;
  const byId = new Map(analysis.responses.map((a) => [a.responseId, a]));
  const latestWeek = Math.max(...scores.weeks.filter((w) => responses.some((r) => r.week === w)));
  const questions = Object.fromEntries(input.dataset.prompts.map((q) => [q.id, q.question]));

  const analysedIn = (week: number) =>
    responses.filter((r) => r.week === week).map((r) => byId.get(r.id)!).filter((a): a is ResponseBrandAnalysis & { status: "analyzed" } => a.status === "analyzed");

  const latest = analysedIn(latestWeek);
  const brands: BrandView[] = catalog.brands.map((b) => {
    const s = scores.brands.find((x) => x.brand === b.id)!;
    const rows = latest.map((a) => a.brands.find((x) => x.brand === b.id)!);
    return {
      id: b.id,
      name: b.name,
      tier: b.tier,
      tracked: (TRACKED as readonly string[]).includes(b.id),
      weeks: s.weeks,
      changes: s.changes,
      latestMentionRate: latest.length ? rows.filter((r) => r.mentioned).length / latest.length : null,
      latestRecommendRate: latest.length ? rows.filter((r) => r.tone === "recommended").length / latest.length : null,
    };
  });

  const first = scores.brands[0]!;
  const weeks = first.weeks.map((w) => ({
    week: w.week,
    dates: dateRange(responses.filter((r) => r.week === w.week && r.collectedAt).map((r) => r.collectedAt!)),
    observed: w.observedSlots,
    expected: w.expectedSlots,
    partial: w.partial,
    missingEngines: w.missingEngines,
  }));

  // One point per expected question × engine × run per week, coloured by Corvane's tone.
  const field: DashboardData["field"] = [];
  const recordAt = new Map(responses.map((r) => [`${r.week}|${r.engine}|${r.promptId}|${r.run}`, r]));
  for (const week of scores.weeks) {
    expected.engines.forEach((engine, ei) => {
      expected.promptIds.forEach((promptId, pi) => {
        for (const run of expected.runs) {
          const r = recordAt.get(`${week}|${engine}|${promptId}|${run}`);
          let state: FieldState = "missing";
          if (r) {
            const a = byId.get(r.id)!;
            if (a.status !== "analyzed") state = "error";
            else {
              const c = a.brands.find((x) => x.brand === "corvane")!;
              state = c.mentioned && c.tone ? c.tone : "absent";
            }
          }
          field.push({ week, engine: ei, prompt: pi, run, state });
        }
      });
    });
  }

  // Wrong-fact groups, with the sources cited by the answers that made the claims.
  const corvaneFacts = facts.get("corvane")!;
  const truthFor = (key: string): string => {
    if (key === "hq") return corvaneFacts.hq ? `${corvaneFacts.hq.city}${corvaneFacts.hq.state ? `, ${corvaneFacts.hq.state}` : ""}` : "unknown";
    if (key === "founded") return String(corvaneFacts.founded);
    if (key === "starting_price_usd") return `$${corvaneFacts.startingPriceUsd} ${corvaneFacts.priceUnit ?? ""}`.trim();
    if (key === "integrations") return corvaneFacts.integrations.join(", ");
    if (key.startsWith("features.")) {
      const name = (FACT_LABEL[key] ?? key.slice(9)).toLowerCase().replace(/^eld\b/, "ELD");
      return corvaneFacts.features[key.slice(9)] ? `Corvane offers ${name}` : `Corvane does not offer ${name}`;
    }
    return "";
  };
  const responseById = new Map(responses.map((r) => [r.id, r]));
  const groups = new Map<string, FactGroup>();
  for (const w of wrongFacts) {
    const r = responseById.get(w.responseId)!;
    const g = groups.get(w.factKey) ?? {
      factKey: w.factKey, label: FACT_LABEL[w.factKey] ?? w.factKey, truth: truthFor(w.factKey),
      count: 0, answers: 0, engines: {}, weeks: [], claims: [], topSources: [],
    };
    g.count += 1;
    g.engines[r.engine] = (g.engines[r.engine] ?? 0) + 1;
    if (!g.weeks.includes(r.week)) g.weeks.push(r.week);
    const claim = g.claims.find((c) => c.text === w.claimText);
    if (claim) {
      claim.count += 1;
      if (!claim.responseIds.includes(w.responseId)) claim.responseIds.push(w.responseId);
    } else g.claims.push({ text: w.claimText, count: 1, responseIds: [w.responseId] });
    groups.set(w.factKey, g);
  }
  for (const g of groups.values()) {
    const ids = new Set(g.claims.flatMap((c) => c.responseIds));
    g.answers = ids.size;
    g.weeks.sort((a, b) => a - b);
    g.claims.sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1));
    const domains = new Map<string, number>();
    for (const id of ids) for (const c of responseById.get(id)!.citations) {
      const d = domainOf(c);
      if (d) domains.set(d, (domains.get(d) ?? 0) + 1);
    }
    g.topSources = [...domains].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1)).slice(0, 3);
  }
  const factGroups = [...groups.values()].sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));

  // Questions where Corvane is absent from every analysed answer in the latest
  // week while a tracked competitor is recommended in at least one of them.
  const gaps: Gap[] = [];
  for (const promptId of expected.promptIds) {
    const runs = latest.filter((a) => a.promptId === promptId);
    if (runs.length === 0) continue;
    const corvaneSeen = runs.some((a) => a.brands.find((b) => b.brand === "corvane")!.mentioned);
    if (corvaneSeen) continue;
    const rec = TRACKED.filter((t) => t !== "corvane" && runs.some((a) => a.brands.find((b) => b.brand === t)?.tone === "recommended"));
    if (rec.length === 0) continue;
    gaps.push({ promptId, question: questions[promptId] ?? promptId, runs: runs.length, recommended: rec.map((t) => ({ brand: t, name: catalog.brands.find((b) => b.id === t)!.name })) });
  }

  const analysedCount = analysis.responses.filter((a) => a.status === "analyzed").length;
  return {
    brands,
    weeks,
    latestWeek,
    questions,
    field,
    engines: expected.engines,
    promptIds: expected.promptIds,
    totals: {
      records: responses.length,
      analysed: analysedCount,
      notAnalysed: responses.length - analysedCount,
      missingSlots: weeks.reduce((n, w) => n + (w.expected - w.observed), 0),
    },
    factGroups,
    wrongFactCount: wrongFacts.length,
    gaps,
  };
}
