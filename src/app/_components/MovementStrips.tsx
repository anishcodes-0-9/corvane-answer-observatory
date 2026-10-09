"use client";

import { useState } from "react";

export interface StripChange {
  fromWeek: number;
  toWeek: number;
  matchedSlots: number;
  meanChange: number | null;
  interval: { low: number; high: number } | null;
  verdict: "up" | "down" | "no_clear_change" | "inconclusive";
  reason: string;
}
export interface StripBrand { id: string; name: string; color: string; changes: StripChange[] }

const VERDICT_TEXT = { up: "Rose", down: "Fell", no_clear_change: "No clear change", inconclusive: "Inconclusive" } as const;

export default function MovementStrips({ brands, partialWeeks }: { brands: StripBrand[]; partialWeeks: number[] }) {
  const cols = brands[0]?.changes ?? [];
  const last = cols.length - 1;
  const [sel, setSel] = useState<{ b: number; c: number }>({ b: 0, c: last });
  const extent = Math.max(30, ...brands.flatMap((b) => b.changes.flatMap((c) => (c.interval ? [Math.abs(c.interval.low), Math.abs(c.interval.high)] : c.meanChange !== null ? [Math.abs(c.meanChange)] : []))));
  const dom = Math.ceil(extent / 10) * 10;
  const sx = (v: number) => 50 + (v / dom) * 46;
  const current = brands[sel.b]?.changes[sel.c];

  return (
    <div>
      <p className="scroll-hint" aria-hidden="true">Swipe sideways for every week-on-week change →</p>
      <div className="strips" style={{ ["--cols" as string]: cols.length }} role="grid" aria-label="Week-on-week change with 95% intervals">
        <div className="hd" role="columnheader">Company</div>
        {cols.map((c) => (
          <div className="hd" role="columnheader" key={c.toWeek}>
            W{c.fromWeek}→W{c.toWeek}
            {partialWeeks.includes(c.toWeek) || partialWeeks.includes(c.fromWeek) ? <span style={{ color: "var(--sand)" }}> · partial</span> : null}
          </div>
        ))}
        {brands.map((b, bi) => (
          <div key={b.id} role="row" style={{ display: "contents" }}>
            <div className="bn" role="rowheader"><i style={{ background: b.color }} />{b.name}</div>
            {b.changes.map((c, ci) => {
              const pressed = sel.b === bi && sel.c === ci;
              const clear = c.verdict === "up" || c.verdict === "down";
              const tone = c.verdict === "down" ? "var(--tone-not)" : clear ? "var(--paper)" : "var(--muted)";
              return (
                <button
                  key={ci}
                  className="cell"
                  role="gridcell"
                  aria-pressed={pressed}
                  aria-label={`${b.name}, week ${c.fromWeek} to ${c.toWeek}: ${VERDICT_TEXT[c.verdict]}. ${c.reason}`}
                  onClick={() => setSel({ b: bi, c: ci })}
                  onMouseEnter={() => setSel({ b: bi, c: ci })}
                  onFocus={() => setSel({ b: bi, c: ci })}
                >
                  <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
                    <line x1="50" x2="50" y1="2" y2="32" stroke="var(--rule-strong)" vectorEffect="non-scaling-stroke" />
                    {c.interval ? (
                      <line x1={sx(c.interval.low)} x2={sx(c.interval.high)} y1="17" y2="17" stroke={tone} strokeWidth={clear ? 3 : 1.5} vectorEffect="non-scaling-stroke" />
                    ) : (
                      <line x1="8" x2="92" y1="17" y2="17" stroke="var(--sand)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                    )}
                    {c.meanChange !== null && (
                      <line x1={sx(c.meanChange)} x2={sx(c.meanChange)} y1="9" y2="25" stroke={c.verdict === "inconclusive" ? "var(--sand)" : clear ? tone : "var(--paper-2)"} strokeWidth={clear ? 3 : 2} vectorEffect="non-scaling-stroke" />
                    )}
                  </svg>
                  <div className="cap">
                    <b style={{ color: clear ? tone : undefined }}>{c.meanChange === null ? "—" : `${c.meanChange > 0 ? "+" : ""}${c.meanChange.toFixed(1)}`}</b>
                    <span>n={c.matchedSlots}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="detail-line" aria-live="polite">
        {current && (
          <>
            <strong>{brands[sel.b]!.name}, W{current.fromWeek}→W{current.toWeek}: {VERDICT_TEXT[current.verdict]}.</strong> {current.reason}
          </>
        )}
      </p>
      <div className="legend" aria-hidden="true">
        <span><i style={{ background: "var(--paper)", height: 3 }} />95% interval clear of zero</span>
        <span><i style={{ background: "var(--muted)" }} />Interval includes zero</span>
        <span><i style={{ background: "repeating-linear-gradient(90deg, var(--sand) 0 2px, transparent 2px 5px)" }} />Too few matched slots</span>
        <span>Scale ±{dom} points · centre line = no change</span>
      </div>
    </div>
  );
}
