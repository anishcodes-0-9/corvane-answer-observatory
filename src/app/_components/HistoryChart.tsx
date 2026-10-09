"use client";

import { useState } from "react";

export interface HistoryWeek { week: number; dates: string; observed: number; expected: number; partial: boolean; missingEngines: string[] }
export interface HistorySeries { id: string; name: string; color: string; values: Array<number | null>; swing: Array<number | null> }

const W = 1000;
const H = 400;
const PAD = { l: 46, r: 24, t: 24, b: 58 };

export default function HistoryChart({ weeks, series, engineLabel }: { weeks: HistoryWeek[]; series: HistorySeries[]; engineLabel: Record<string, string> }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(10, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const yMax = Math.min(100, Math.ceil((max + 5) / 10) * 10);
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * (i + 0.5)) / weeks.length;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / yMax);
  const colW = (W - PAD.l - PAD.r) / weeks.length;
  const ticks = Array.from({ length: yMax / 10 + 1 }, (_, i) => i * 10).filter((t) => t % 20 === 0 || yMax <= 40);

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly visibility scores for ${series.map((s) => s.name).join(", ")}. Axis from 0 to ${yMax} on a 0 to 100 scale.`}>
        <defs>
          <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#e3c77d" strokeOpacity="0.16" strokeWidth="2" />
          </pattern>
        </defs>
        {weeks.map((w, i) =>
          w.partial ? (
            <g key={`p${w.week}`}>
              <rect className="partial-band" x={x(i) - colW / 2} y={PAD.t} width={colW} height={H - PAD.t - PAD.b} />
              <text x={x(i)} y={PAD.t + 14} textAnchor="middle" style={{ fill: "var(--sand)" }}>
                PARTIAL · {w.observed}/{w.expected}
              </text>
            </g>
          ) : null,
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "axis" : "grid"} x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text x={PAD.l - 10} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        {weeks.map((w, i) => (
          <g key={`l${w.week}`}>
            <text x={x(i)} y={H - PAD.b + 22} textAnchor="middle" style={{ fill: "var(--paper-2)" }}>W{w.week}</text>
            <text x={x(i)} y={H - PAD.b + 38} textAnchor="middle">{w.dates.replace(/ \d{4}$/, "")}</text>
          </g>
        ))}
        {[...series].reverse().map((s) => {
          const isClient = s.id === "corvane";
          const segs: Array<{ a: number; b: number; dashed: boolean }> = [];
          for (let i = 1; i < s.values.length; i++) {
            if (s.values[i - 1] === null || s.values[i] === null) continue;
            segs.push({ a: i - 1, b: i, dashed: Boolean(weeks[i]?.partial || weeks[i - 1]?.partial) });
          }
          return (
            <g key={s.id}>
              {segs.map((g) => (
                <line key={g.a} x1={x(g.a)} y1={y(s.values[g.a]!)} x2={x(g.b)} y2={y(s.values[g.b]!)} stroke={s.color} strokeWidth={isClient ? 2.6 : 1.4} strokeDasharray={g.dashed ? "5 5" : undefined} strokeOpacity={isClient ? 1 : 0.85} />
              ))}
              {s.values.map((v, i) =>
                v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={isClient ? 5 : 3.5} fill={weeks[i]!.partial ? "var(--ink)" : s.color} stroke={s.color} strokeWidth={1.6} />
                ),
              )}
              {isClient && s.values[s.values.length - 1] !== null && (
                <text x={x(s.values.length - 1) + 12} y={y(s.values[s.values.length - 1]!) + 4} style={{ fill: s.color, fontSize: 13 }}>
                  {s.values[s.values.length - 1]!.toFixed(1)}
                </text>
              )}
            </g>
          );
        })}
        {weeks.map((w, i) => (
          <g
            key={`h${w.week}`}
            className="week-hit"
            tabIndex={0}
            role="button"
            aria-label={`Week ${w.week}: ${series.map((s) => `${s.name} ${s.values[i] ?? "no data"}`).join(", ")}. ${w.observed} of ${w.expected} slots observed.`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <rect className="hit" x={x(i) - colW / 2} y={PAD.t} width={colW} height={H - PAD.t - PAD.b} fill="transparent" />
            {active === i && <line x1={x(i)} x2={x(i)} y1={PAD.t} y2={H - PAD.b} stroke="var(--rule-strong)" />}
          </g>
        ))}
      </svg>
      {active !== null && (
        <div className="tip" style={{ left: `${Math.min(78, Math.max(2, (x(active) / W) * 100 + 2))}%`, top: 10 }}>
          <h4>Week {weeks[active]!.week}</h4>
          <div className="muted" style={{ marginBottom: 8 }}>
            {weeks[active]!.dates} · {weeks[active]!.observed}/{weeks[active]!.expected} slots
            {weeks[active]!.partial && <span style={{ color: "var(--sand)" }}> · partial{weeks[active]!.missingEngines.length ? ` (no ${weeks[active]!.missingEngines.map((e) => engineLabel[e] ?? e).join(", ")})` : ""}</span>}
          </div>
          {series.map((s) => (
            <div className="row" key={s.id}>
              <i style={{ background: s.color }} />
              <span>{s.name}</span>
              <span style={{ color: "var(--paper)" }}>{s.values[active] === null ? "no data" : s.values[active]!.toFixed(1)}</span>
            </div>
          ))}
          {series[0]!.swing[active] !== null && (
            <div className="muted" style={{ marginTop: 8 }}>
              Run-to-run swing ({series[0]!.name}): {series[0]!.swing[active]!.toFixed(1)} pts
            </div>
          )}
        </div>
      )}
    </div>
  );
}
