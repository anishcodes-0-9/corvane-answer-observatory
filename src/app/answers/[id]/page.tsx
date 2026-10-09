import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import DataError from "../../_components/DataError";
import { BRAND_COLOR, ENGINE_LABEL, FACT_LABEL, loadDashboard } from "../../_lib/dashboard";

export const dynamic = "force-dynamic";

const TONE_TEXT = { recommended: "Recommended", neutral: "Neutral", negative: "Negative", not_recommended: "Not recommended" } as const;

type Span = { start: number; end: number; kind: "brand" | "decoy" | "claim"; brand?: string; title: string };

/** Splits the text at every highlight boundary so overlapping highlights nest correctly. */
function highlight(text: string, spans: Span[]): ReactNode[] {
  const cuts = [...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    let node: ReactNode = text.slice(a, b);
    const covering = spans.filter((s) => s.start <= a && s.end >= b);
    for (const s of covering.sort((x, y) => (x.kind === "claim" ? -1 : y.kind === "claim" ? 1 : 0)).reverse()) {
      node = (
        <mark className={s.kind === "brand" ? undefined : s.kind} style={s.brand ? ({ ["--c" as string]: BRAND_COLOR[s.brand] } as React.CSSProperties) : undefined} title={s.title}>
          {node}
        </mark>
      );
    }
    out.push(<span key={a}>{node}</span>);
  }
  return out;
}

export default async function AnswerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = loadDashboard();
  if (!result.ok) return <DataError error={result.error} dataDir={result.dataDir} />;
  const { data: d, pipeline: p } = result;
  const r = p.input.dataset.responses.find((x) => x.id === id);
  if (!r) notFound();
  const a = p.analysis.responses.find((x) => x.responseId === id)!;
  const facts = p.wrongFacts.filter((w) => w.responseId === id);
  const brandName = Object.fromEntries(d.brands.map((b) => [b.id, b.name]));

  const spans: Span[] = [];
  if (a.status === "analyzed") {
    for (const b of a.brands) for (const m of b.matches) {
      spans.push({ start: m.start, end: m.end, kind: "brand", brand: b.brand, title: `${brandName[b.brand]} · ${m.matchType}${m.matchType === "fuzzy" ? ` (edit distance ${m.distance})` : ""}` });
    }
    for (const dcy of a.decoys) spans.push({ start: dcy.start, end: dcy.end, kind: "decoy", title: `${dcy.surface}: unrelated company, not counted as ${brandName[dcy.brand]}` });
  }
  for (const w of facts) spans.push({ start: w.start, end: w.end, kind: "claim", title: `Contradicts facts file (${FACT_LABEL[w.factKey] ?? w.factKey})` });

  return (
    <section className="section" style={{ borderTop: 0 }} aria-labelledby="answer-title">
      <p className="links" style={{ marginBottom: 24 }}>
        <Link href="/answers">← All answers</Link>
        <Link href={`/answers?prompt=${r.promptId}&week=${r.week}`}>Same question, week {r.week}</Link>
        <Link href={`/answers?prompt=${r.promptId}&engine=${r.engine}`}>Same question on {ENGINE_LABEL[r.engine] ?? r.engine}, all weeks</Link>
      </p>
      <div className="section-head">
        <span className="num">W{r.week} · {ENGINE_LABEL[r.engine] ?? r.engine} · run {r.run ?? "?"}</span>
        <div>
          <h2 id="answer-title">“{d.questions[r.promptId] ?? r.promptId}”</h2>
          <p className="mono" style={{ fontSize: 12 }}>{r.id} · {r.promptId}{r.collectedAt ? ` · collected ${r.collectedAt.slice(0, 16).replace("T", " ")} UTC` : ""}</p>
        </div>
      </div>

      <div className="answer-layout">
        <div>
          <p className="eyebrow" style={{ marginBottom: 14 }}>Answer text</p>
          {a.status === "analyzed" ? (
            <div className="answer-text">{highlight(r.text, spans)}</div>
          ) : (
            <p className="note">
              <b>No answer text: the collector reported “{a.status === "not_analyzed" && a.error ? a.error : "empty"}”.</b> This
              record is counted in coverage as not analysed, exported to mentions.csv as not mentioned for every company,
              and excluded from scores.
            </p>
          )}
        </div>
        <aside className="side" aria-label="Analysis of this answer">
          {a.status === "analyzed" && (
            <div>
              <h3>Companies, in order named</h3>
              <div className="mention-rows">
                {a.brands.filter((b) => b.mentioned).sort((x, y) => x.position! - y.position!).map((b) => (
                  <div key={b.brand}>
                    <span className="b"><i style={{ background: BRAND_COLOR[b.brand] }} />{b.position}. {brandName[b.brand]}</span>
                    <span className={`tone-${b.tone}`}>{TONE_TEXT[b.tone!]}</span>
                    <span className="muted">{b.matches.length}×</span>
                  </div>
                ))}
                {a.brands.every((b) => !b.mentioned) && <div><span className="muted">No company named</span></div>}
              </div>
              {a.brands.some((b) => b.mentioned && b.toneEvidence.length > 0) && (
                <div style={{ marginTop: 14 }} className="note">
                  {a.brands.filter((b) => b.toneEvidence.length > 0).map((b) => (
                    <div key={b.brand} style={{ marginBottom: 8 }}>
                      <b>{brandName[b.brand]}:</b> final verdict from “{b.toneEvidence[b.toneEvidence.length - 1]!.sentence.trim()}”
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {facts.length > 0 && (
            <div>
              <h3>Contradicts the facts file</h3>
              <div style={{ display: "grid", gap: 12 }}>
                {facts.map((w) => (
                  <div className="claim-card" key={`${w.factKey}${w.start}`}>
                    <b>{FACT_LABEL[w.factKey] ?? w.factKey}:</b> the answer says {w.claimed}; the facts say {w.actual}.
                  </div>
                ))}
              </div>
            </div>
          )}
          {a.status === "analyzed" && a.decoys.length > 0 && (
            <div>
              <h3>Not counted</h3>
              <p className="note">{a.decoys.map((x) => x.surface).join(", ")}: an unrelated company with a similar name.</p>
            </div>
          )}
          <div>
            <h3>Citations ({r.citations.length})</h3>
            <p className="note" style={{ marginTop: 0 }}>Sources the engine listed. They are not counted as mentions.</p>
            <ul className="cites">
              {r.citations.length === 0 ? <li>None listed</li> : r.citations.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
