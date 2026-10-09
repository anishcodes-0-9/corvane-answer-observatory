import Link from "next/link";
import AnswerField from "./_components/AnswerField";
import DataError from "./_components/DataError";
import HistoryChart from "./_components/HistoryChart";
import MovementStrips from "./_components/MovementStrips";
import WhyPanel from "./_components/WhyPanel";
import { BRAND_COLOR, ENGINE_LABEL, TRACKED, loadDashboard } from "./_lib/dashboard";

export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const signed = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(1)}`);
const VERDICT = { up: "Clear rise", down: "Clear fall", no_clear_change: "No clear change", inconclusive: "Inconclusive" } as const;
const SYMBOL = { up: "↗", down: "↘", no_clear_change: "→", inconclusive: "?" } as const;

export default function Overview() {
  const result = loadDashboard();
  if (!result.ok) return <DataError error={result.error} dataDir={result.dataDir} />;
  const d = result.data;
  const brand = (id: string) => d.brands.find((b) => b.id === id)!;
  const corvane = brand("corvane");
  const latestIdx = corvane.weeks.findIndex((w) => w.week === d.latestWeek);
  const latest = corvane.weeks[latestIdx]!;
  const period = d.weeks.find((w) => w.week === d.latestWeek)!;
  const change = corvane.changes.find((c) => c.toWeek === d.latestWeek) ?? null;
  const prevPeriod = change ? d.weeks.find((w) => w.week === change.fromWeek) : undefined;
  const rivals = TRACKED.filter((t) => t !== "corvane").map(brand);
  const leader = [...TRACKED].map(brand).sort((a, b) => (b.weeks[latestIdx]!.score ?? -1) - (a.weeks[latestIdx]!.score ?? -1))[0]!;
  const partialWeeks = d.weeks.filter((w) => w.partial).map((w) => w.week);
  const brandName = Object.fromEntries(d.brands.map((b) => [b.id, b.name]));
  const fieldPartial = (() => {
    const w = d.weeks.find((x) => x.partial && x.missingEngines.length > 0);
    if (!w) return null;
    const e = d.engines.indexOf(w.missingEngines[0]!);
    return { week: w.week, engine: e, text: `No ${ENGINE_LABEL[w.missingEngines[0]!] ?? w.missingEngines[0]} answers` };
  })();
  const biggest = corvane.changes.reduce((best, c, i) => (Math.abs(c.meanChange ?? 0) > Math.abs(corvane.changes[best]!.meanChange ?? 0) ? i : best), corvane.changes.length - 1);

  return (
    <>
      {/* 00 — Opening composition */}
      <section className="hero" aria-labelledby="headline">
        <AnswerField points={d.field} weeks={d.weeks.map((w) => w.week)} prompts={d.promptIds.length} partialLabel={fieldPartial} />
        <div className="hero-top rise">
          <div className="period">
            <span className="eyebrow">AI visibility · Week {d.latestWeek} of {d.weeks.length}</span>
            <span className="badge"><span className="dot" />{period.dates}</span>
            <span className={`badge${period.partial ? " partial" : ""}`}>{period.observed}/{period.expected} question × engine slots</span>
            {prevPeriod?.partial && <span className="badge partial">Compared with W{prevPeriod.week}: partial, {prevPeriod.missingEngines.map((e) => ENGINE_LABEL[e] ?? e).join(", ")} missing</span>}
          </div>
        </div>

        <div className="hero-copy">
          <h1 id="headline" className="rise d1">
            AI engines mention <em>Corvane</em> in {pct(corvane.latestMentionRate)} of answers, and recommend it in {pct(corvane.latestRecommendRate)}.
          </h1>
          <p className="lede rise d2">
            Fifteen buyer questions, three AI engines, two runs each: every answer read for who is named, in what
            order, with what verdict, and what it gets wrong. This week{" "}
            {leader.id === "corvane" ? "Corvane has the highest score of the four tracked companies" : `${leader.name} scores higher than Corvane (${leader.weeks[latestIdx]!.score?.toFixed(1)} vs ${latest.score?.toFixed(1)})`}
            ; differences between companies are descriptive, not tested.
          </p>
        </div>

        <div className="field-legend rise d3">
          Each point is one AI answer. Height and colour: how that answer treats Corvane.
          <div className="keys">
            <span className="k"><i style={{ background: "#ff5b2e" }} />Recommends</span>
            <span className="k"><i style={{ background: "#c9c4b8" }} />Mentions</span>
            <span className="k"><i style={{ background: "#d49a4a" }} />Criticises</span>
            <span className="k"><i style={{ background: "#c4503c" }} />Advises against</span>
            <span className="k"><i style={{ background: "#4a4943" }} />Absent</span>
            <span className="k"><i style={{ border: "1px solid #6a675f" }} />Not collected</span>
          </div>
        </div>

        <div className="hero-foot rise d3">
          <div className="score-block">
            <div className="score-big" aria-label={`Corvane visibility score ${latest.score ?? "unavailable"} out of 100`}>
              {latest.score === null ? "—" : latest.score.toFixed(1)}<small>/100</small>
            </div>
            <div className="score-meta">
              <span className="eyebrow">Corvane visibility score · W{d.latestWeek}</span>
              {change ? (
                <span className={`verdict ${change.verdict}`}>
                  <span className="sym" aria-hidden="true">{SYMBOL[change.verdict]}</span>
                  {VERDICT[change.verdict]} since W{change.fromWeek}: {signed(change.meanChange)} pts on {change.matchedSlots} matched slots
                  {change.interval ? ` · 95% interval ${signed(change.interval.low)} to ${signed(change.interval.high)}` : ""}
                </span>
              ) : (
                <span className="verdict inconclusive">No earlier week to compare</span>
              )}
              <a href="#facts" className="mono" style={{ fontSize: 13, color: "var(--tone-not)" }}>
                {d.wrongFactCount} answers state wrong facts about Corvane →
              </a>
            </div>
          </div>
          <div className="rivals" aria-label="Tracked competitors this week">
            {rivals.map((r) => {
              const c = r.changes.find((x) => x.toWeek === d.latestWeek);
              return (
                <div className="rival" key={r.id}>
                  <div className="name"><span className="swatch" style={{ background: BRAND_COLOR[r.id] }} />{r.name}</div>
                  <div className="val">{r.weeks[latestIdx]!.score?.toFixed(1) ?? "—"}</div>
                  <div className="sub">{c ? `${VERDICT[c.verdict].toLowerCase()} · ${signed(c.meanChange)}` : "no comparison"}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 01 — Standing over time */}
      <section className="section" aria-labelledby="s1">
        <div className="section-head">
          <span className="num">01 — Standing</span>
          <div>
            <h2 id="s1">Six weeks of visibility, with the gaps left visible.</h2>
            <p>
              Score out of 100 for the four tracked companies. Hollow points and dashed lines mark a partial week,
              scored only on the slots that were collected; a week with no answers would leave a gap, never a zero.
            </p>
          </div>
        </div>
        <HistoryChart
          weeks={d.weeks}
          engineLabel={ENGINE_LABEL}
          series={TRACKED.map((id) => {
            const b = brand(id);
            return { id, name: b.name, color: BRAND_COLOR[id]!, values: b.weeks.map((w) => w.score), swing: b.weeks.map((w) => w.runToRunSwing) };
          })}
        />
        <div className="legend">
          {TRACKED.map((id) => (
            <span key={id}><i style={{ background: BRAND_COLOR[id], height: id === "corvane" ? 3 : 2 }} />{brand(id).name}</span>
          ))}
          <span><i style={{ background: "repeating-linear-gradient(45deg, rgb(227 199 125 / .5) 0 2px, transparent 2px 5px)", height: 10 }} />Partial week</span>
        </div>
      </section>

      {/* 02 — Movement */}
      <section className="section" aria-labelledby="s2">
        <div className="section-head">
          <span className="num">02 — Movement</span>
          <div>
            <h2 id="s2">What moved, and whether it moved more than chance.</h2>
            <p>
              Each cell compares a week with the one before on the question × engine slots observed in both (n). The
              bar is a 95% interval for the average change; only bars clear of the centre line count as real
              movement. Select a cell to read it.
            </p>
          </div>
        </div>
        <MovementStrips
          partialWeeks={partialWeeks}
          brands={TRACKED.map((id) => ({ id, name: brand(id).name, color: BRAND_COLOR[id]!, changes: brand(id).changes }))}
        />
      </section>

      {/* 03 — Why */}
      <section className="section" aria-labelledby="s3">
        <div className="section-head">
          <span className="num">03 — Why it moved</span>
          <div>
            <h2 id="s3">The questions and engines behind Corvane&apos;s movement.</h2>
            <p>
              For each change, the matched slots that moved most, with both runs of the original answers one click
              away. Where Corvane fell, the competitors whose scores rose in those same slots.
            </p>
          </div>
        </div>
        <WhyPanel
          changes={corvane.changes}
          questions={d.questions}
          engineLabel={ENGINE_LABEL}
          brandName={brandName}
          defaultIndex={biggest}
        />
      </section>

      {/* 04 — Wrong facts */}
      <section className="section" id="facts" aria-labelledby="s4">
        <div className="section-head">
          <span className="num">04 — Wrong facts</span>
          <div>
            <h2 id="s4">{d.wrongFactCount} answers tell buyers something untrue about Corvane.</h2>
            <p>
              Only explicit claims that contradict the facts file are flagged; claims it does not cover are
              unverified, not wrong. Grouped by fact, with the most-cited sources in those answers.
            </p>
          </div>
        </div>
        {d.factGroups.length === 0 ? (
          <p className="note">No answer contradicts the facts file.</p>
        ) : (
          <div className="facts">
            {d.factGroups.map((g) => (
              <article className="fact" key={g.factKey}>
                <div className="count">{g.count}<small>{g.count === 1 ? "answer" : "answers"}</small></div>
                <h3>{g.label}</h3>
                <blockquote>“{g.claims[0]!.text}”</blockquote>
                <div className="truth">Fact: <b>{g.truth}</b></div>
                <div className="meta">
                  {Object.entries(g.engines).map(([e, n]) => `${ENGINE_LABEL[e] ?? e} ${n}`).join(" · ")} · weeks {g.weeks.join(", ")}
                  {g.topSources.length > 0 && <><br />Cited in these answers: {g.topSources.map((s) => s.domain).join(", ")}</>}
                </div>
                <div className="links">
                  {g.claims.flatMap((c) => c.responseIds).slice(0, 4).map((id, k) => <Link key={id} href={`/answers/${id}`}>answer {k + 1}</Link>)}
                  {g.answers > 4 && <Link href={`/answers?fact=${encodeURIComponent(g.factKey)}`}>all {g.answers} →</Link>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 05 — Market */}
      <section className="section" aria-labelledby="s5">
        <div className="section-head">
          <span className="num">05 — Market, week {d.latestWeek}</span>
          <div>
            <h2 id="s5">Everyone the engines named this week.</h2>
            <p>The four tracked companies, then the two others the brief asks us to detect but not track in depth.</p>
          </div>
        </div>
        <table className="market">
          <thead>
            <tr><th>Company</th><th>Score</th><th>Mentioned in</th><th className="hide-sm">Recommended in</th><th className="hide-sm">Change vs W{change?.fromWeek ?? "—"}</th></tr>
          </thead>
          <tbody>
            {d.brands.map((b) => {
              const c = b.changes.find((x) => x.toWeek === d.latestWeek);
              return (
                <tr key={b.id} className={b.tracked ? "" : "other"}>
                  <td className="brand"><i style={{ background: BRAND_COLOR[b.id] }} />{b.name}{!b.tracked && <span className="eyebrow" style={{ marginLeft: 10 }}>detected</span>}</td>
                  <td>{b.weeks[latestIdx]!.score?.toFixed(1) ?? "—"}</td>
                  <td><span className="meter"><span style={{ width: pct(b.latestMentionRate) }} /></span>{pct(b.latestMentionRate)}</td>
                  <td className="hide-sm">{pct(b.latestRecommendRate)}</td>
                  <td className="hide-sm">{c ? `${signed(c.meanChange)} · ${VERDICT[c.verdict].toLowerCase()}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <caption className="note">Rates are shares of the {d.weeks.find((w) => w.week === d.latestWeek)!.observed > 0 ? "analysed" : ""} answers collected in week {d.latestWeek}.</caption>
        </table>
      </section>

      {/* 06 — Suggested next steps */}
      <section className="section" aria-labelledby="s6">
        <div className="section-head">
          <span className="num">06 — Suggested next steps</span>
          <div>
            <h2 id="s6">What to do about it.</h2>
            <p>Suggestions drawn directly from the findings above. They are prompts for the team, not validated recommendations.</p>
          </div>
        </div>
        <ol className="actions">
          {d.factGroups.slice(0, 3).map((g) => (
            <li key={g.factKey}>
              <div>
                <h3>Correct the record: {g.label}.</h3>
                <p>
                  {g.answers} answers say “{g.claims[0]!.text.replace(/[.\s]+$/, "")}”; the facts file says {g.truth}. Make the
                  correct answer unmissable on corvanefleet.com
                  {(() => {
                    const others = g.topSources.filter((s) => !s.domain.endsWith("corvanefleet.com")).map((s) => s.domain);
                    return others.length > 0 ? `, and check what ${others.join(", ")} say, since these answers cite them` : "";
                  })()}
                  .
                </p>
              </div>
            </li>
          ))}
          {d.gaps.slice(0, 3).map((gap) => (
            <li key={gap.promptId}>
              <div>
                <h3>Answer “{gap.question}” directly.</h3>
                <p>
                  In week {d.latestWeek}, Corvane appears in none of the {gap.runs} answers to this question, while{" "}
                  {gap.recommended.map((r) => r.name).join(" and ")} {gap.recommended.length > 1 ? "are" : "is"} recommended.
                  Content that addresses it head-on is the most direct way to be considered.
                </p>
              </div>
            </li>
          ))}
          <li>
            <div>
              <h3>Read week-to-week swings with care.</h3>
              <p>
                {corvane.changes.filter((c) => c.verdict === "no_clear_change" || c.verdict === "inconclusive").length} of{" "}
                {corvane.changes.length} week-on-week changes for Corvane are within normal run-to-run variation
                {partialWeeks.length > 0 ? `, and week ${partialWeeks.join(", ")} is partial` : ""}. Act on the
                fact errors and question gaps above, not on a single week&apos;s number.
              </p>
            </div>
          </li>
        </ol>
      </section>

      {/* 07 — Method */}
      <section className="section" aria-labelledby="s7">
        <div className="section-head">
          <span className="num">07 — How the score works</span>
          <div><h2 id="s7">One number, explained.</h2></div>
        </div>
        <div className="method">
          <div>
            <h3>Points per answer</h3>
            <p>Each answer earns the company points for how it treats it. A product choice, not a validated weight.</p>
            <div className="points">
              <span>Recommends</span><span>100</span><span>Mentions, no judgement</span><span>50</span>
              <span>Criticises</span><span>25</span><span>Advises against</span><span>0</span><span>Not mentioned</span><span>0</span>
            </div>
          </div>
          <div>
            <h3>Slots and weeks</h3>
            <p>A slot is one question on one engine in one week, averaged over its two runs. Timeouts are left out, and a slot with no answer is missing, never zero.</p>
          </div>
          <div>
            <h3>Comparing weeks</h3>
            <p>Changes use only slots observed in both weeks, so missing data cannot create a drop. A 95% interval decides whether the change exceeds run-to-run variation.</p>
          </div>
          <div>
            <h3>Coverage</h3>
            <p>
              {d.totals.records} answers collected, {d.totals.analysed} analysed, {d.totals.notAnalysed} timed out.
              {d.totals.missingSlots > 0 ? ` ${d.totals.missingSlots} question × engine slots were never collected.` : ""}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
