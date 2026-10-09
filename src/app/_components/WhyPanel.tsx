"use client";

import Link from "next/link";
import { useState } from "react";

export interface WhyChange {
  fromWeek: number;
  toWeek: number;
  matchedSlots: number;
  meanChange: number | null;
  verdict: "up" | "down" | "no_clear_change" | "inconclusive";
  reason: string;
  topContributors: Array<{ engine: string; promptId: string; from: number; to: number; change: number; fromResponses: string[]; toResponses: string[] }>;
  gainersWhereThisFell: Array<{ brand: string; meanChange: number; slots: number }>;
}

export default function WhyPanel({ changes, questions, engineLabel, brandName, defaultIndex }: { changes: WhyChange[]; questions: Record<string, string>; engineLabel: Record<string, string>; brandName: Record<string, string>; defaultIndex: number }) {
  const [i, setI] = useState(defaultIndex);
  const c = changes[i]!;
  const clear = c.verdict === "up" || c.verdict === "down";
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Choose a week-on-week change">
        {changes.map((x, k) => (
          <button key={k} role="tab" aria-selected={k === i} onClick={() => setI(k)}>
            W{x.fromWeek}→W{x.toWeek} {x.meanChange === null ? "" : `${x.meanChange > 0 ? "+" : ""}${x.meanChange.toFixed(1)}`}
          </button>
        ))}
      </div>
      <p className="note" style={{ marginTop: 18 }} role="status">
        <b>{clear ? "A clear change." : c.verdict === "inconclusive" ? "Inconclusive." : "Within normal variation."}</b> {c.reason}
        {!clear && c.topContributors.length > 0 && " The slots below moved most, but together they do not establish a trend."}
      </p>
      {c.topContributors.length === 0 ? (
        <p className="note">No matched slot changed between these weeks.</p>
      ) : (
        <ol className="contrib">
          {c.topContributors.map((s) => (
            <li key={`${s.engine}${s.promptId}`}>
              <div className="q">
                “{questions[s.promptId] ?? s.promptId}”
                <small>{s.promptId} · {engineLabel[s.engine] ?? s.engine}</small>
              </div>
              <div className="bar-pair" aria-label={`Corvane slot score went from ${s.from} to ${s.to}`}>
                <span className="track" aria-hidden="true">
                  <span className="from" style={{ width: `${s.from}%` }} />
                  <span className="to" style={{ width: `${s.to}%` }} />
                </span>
                <span>W{c.fromWeek} {s.from.toFixed(0)} → <span style={{ color: "var(--paper)" }}>W{c.toWeek} {s.to.toFixed(0)}</span></span>
                <span className={`delta ${s.change < 0 ? "neg" : "pos"}`}>{s.change > 0 ? "+" : ""}{s.change.toFixed(1)}</span>
              </div>
              <div className="links">
                <span className="muted">W{c.fromWeek}:</span>{" "}
                {s.fromResponses.map((id, k) => <Link key={id} href={`/answers/${id}`}>run {k + 1}</Link>)}
                <span className="muted">W{c.toWeek}:</span>{" "}
                {s.toResponses.map((id, k) => <Link key={id} href={`/answers/${id}`}>run {k + 1}</Link>)}
              </div>
            </li>
          ))}
        </ol>
      )}
      {c.gainersWhereThisFell.length > 0 && (
        <div className="gainers">
          <span className="eyebrow" style={{ alignSelf: "center" }}>Where Corvane fell, these rose</span>
          {c.gainersWhereThisFell.map((g) => (
            <span key={g.brand}>
              {brandName[g.brand] ?? g.brand} <span style={{ color: "var(--paper)" }}>+{g.meanChange.toFixed(1)}</span> <span className="muted">avg over {g.slots} slots</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
