import Link from "next/link";
import DataError from "../_components/DataError";
import { BRAND_COLOR, ENGINE_LABEL, FACT_LABEL, loadDashboard } from "../_lib/dashboard";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const TONE_TEXT = { recommended: "recommends", neutral: "mentions", negative: "criticises", not_recommended: "advises against" } as const;

export default async function Answers({ searchParams }: { searchParams: Search }) {
  const result = loadDashboard();
  if (!result.ok) return <DataError error={result.error} dataDir={result.dataDir} />;
  const { data: d, pipeline: p } = result;
  const q = await searchParams;
  const f = { week: one(q.week), engine: one(q.engine), prompt: one(q.prompt), brand: one(q.brand), tone: one(q.tone), fact: one(q.fact) };

  const analysisById = new Map(p.analysis.responses.map((a) => [a.responseId, a]));
  const factIds = f.fact ? new Set(p.wrongFacts.filter((w) => w.factKey === f.fact).map((w) => w.responseId)) : null;
  const rows = p.input.dataset.responses.filter((r) => {
    if (f.week && String(r.week) !== f.week) return false;
    if (f.engine && r.engine !== f.engine) return false;
    if (f.prompt && r.promptId !== f.prompt) return false;
    if (factIds && !factIds.has(r.id)) return false;
    const a = analysisById.get(r.id)!;
    if (f.brand) {
      if (a.status !== "analyzed") return false;
      const b = a.brands.find((x) => x.brand === f.brand);
      if (!b?.mentioned) return false;
      if (f.tone && b.tone !== f.tone) return false;
    }
    return true;
  });
  const brandName = Object.fromEntries(d.brands.map((b) => [b.id, b.name]));
  const active = Object.values(f).some(Boolean);

  return (
    <section className="section" style={{ borderTop: 0 }} aria-labelledby="answers-title">
      <div className="section-head">
        <span className="num">Answers</span>
        <div>
          <h2 id="answers-title">Every answer the engines gave, read in full.</h2>
          <p>
            Filter by week, engine, question or company. Open an answer to see each company highlighted where it
            is named, the verdict read for it, and any claim that contradicts the facts file.
          </p>
        </div>
      </div>

      <form className="filters" method="get" action="/answers">
        <label>Week
          <select name="week" defaultValue={f.week}>
            <option value="">All weeks</option>
            {d.weeks.map((w) => <option key={w.week} value={w.week}>Week {w.week}{w.partial ? " (partial)" : ""}</option>)}
          </select>
        </label>
        <label>Engine
          <select name="engine" defaultValue={f.engine}>
            <option value="">All engines</option>
            {d.engines.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e] ?? e}</option>)}
          </select>
        </label>
        <label>Question
          <select name="prompt" defaultValue={f.prompt}>
            <option value="">All questions</option>
            {d.promptIds.map((id) => <option key={id} value={id}>{id} · {d.questions[id] ?? ""}</option>)}
          </select>
        </label>
        <label>Mentions company
          <select name="brand" defaultValue={f.brand}>
            <option value="">Any or none</option>
            {d.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          {f.fact && <input type="hidden" name="fact" value={f.fact} />}
          <button className="btn primary" type="submit">Apply</button>
          {active && <Link className="btn" href="/answers" style={{ textDecoration: "none" }}>Reset</Link>}
        </div>
      </form>

      <p className="note" style={{ margin: "18px 0" }} role="status">
        <b>{rows.length}</b> of {p.input.dataset.responses.length} answers
        {f.fact ? <> · stating a wrong {FACT_LABEL[f.fact]?.toLowerCase() ?? f.fact} for Corvane</> : null}
        {f.brand && f.tone ? <> · where the answer {TONE_TEXT[f.tone as keyof typeof TONE_TEXT] ?? f.tone} {brandName[f.brand]}</> : null}
      </p>

      {rows.length === 0 ? (
        <p className="note">No answers match these filters.</p>
      ) : (
        <ul className="answer-list">
          {rows.map((r) => {
            const a = analysisById.get(r.id)!;
            const mentioned = a.status === "analyzed" ? a.brands.filter((b) => b.mentioned).sort((x, y) => x.position! - y.position!) : [];
            return (
              <li key={r.id}>
                <Link href={`/answers/${r.id}`}>
                  <div className="where">
                    W{r.week} · {ENGINE_LABEL[r.engine] ?? r.engine}<br />{r.promptId} · run {r.run ?? "?"}
                  </div>
                  <div className="q">{d.questions[r.promptId] ?? r.promptId}</div>
                  <div className="chips">
                    {a.status !== "analyzed" ? (
                      <span className="chip err">{a.reason === "error" ? `collector ${a.error ?? "error"}` : "empty"} · not analysed</span>
                    ) : mentioned.length === 0 ? (
                      <span className="chip">no company named</span>
                    ) : (
                      mentioned.map((b) => (
                        <span className="chip" key={b.brand}>
                          <i style={{ background: BRAND_COLOR[b.brand] }} />{b.position}. {brandName[b.brand]} · <span className={`tone-${b.tone}`}>{b.tone?.replace("_", " ")}</span>
                        </span>
                      ))
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
