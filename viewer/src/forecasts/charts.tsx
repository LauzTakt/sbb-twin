// Inline SVG charts for the forecast evidence page: thin marks, hairline grid, one axis, values at the tips, a tooltip on
// every mark (hover and keyboard focus) and the numbers in a table view next to each chart (Page.tsx).
import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode } from "react";

export type Kind = "model" | "base" | "truth";
export const COLOUR: Record<Kind, string> = { model: "var(--viz-model)", base: "var(--viz-base)", truth: "var(--viz-truth)" };
const HATCH = "url(#fc-hatch)";

// ---------------------------------------------------------------- tooltip
type TipRow = { kind?: Kind; label: string; value: string };
type TipState = { x: number; y: number; title: string; rows: TipRow[] } | null;
const TipContext = createContext<(t: TipState) => void>(() => undefined);

/** One tooltip for the whole page; marks set it through useTip(). Text goes in as React text (never as HTML). */
export function TipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState>(null);
  let style: CSSProperties | undefined;
  if (tip) {
    const w = 270;
    const h = 36 + tip.rows.length * 20;
    const left = tip.x + 16 + w > window.innerWidth ? tip.x - 16 - w : tip.x + 16;
    const top = tip.y + 16 + h > window.innerHeight ? tip.y - 16 - h : tip.y + 16;
    style = { left: Math.max(8, left), top: Math.max(8, top) };
  }
  return (
    <TipContext.Provider value={setTip}>
      {children}
      {tip && (
        <div className="viz-tip" style={style}>
          <div className="tt">{tip.title}</div>
          {tip.rows.map((r, i) => (
            <div className="tip-row" key={i}>
              {r.kind ? <i className="key" style={{ background: COLOUR[r.kind] }} /> : <i className="key" />}
              <b>{r.value}</b>
              <span>{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </TipContext.Provider>
  );
}
export function useTip() {
  const set = useContext(TipContext);
  return (title: string, rows: TipRow[]) => ({
    tabIndex: 0,
    role: "img",
    "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.value}`).join(", ")}`,
    onPointerMove: (e: PointerEvent<SVGGElement>) => set({ x: e.clientX, y: e.clientY, title, rows }),
    onPointerLeave: () => set(null),
    onFocus: (e: FocusEvent<SVGGElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      set({ x: r.right, y: r.top, title, rows });
    },
    onBlur: () => set(null),
  });
}

/** The hatch every placeholder mark is filled with (one definition per page). */
export function Defs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <pattern id="fc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" style={{ fill: "var(--viz-ph-bg)" }} />
          <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--viz-ph)", strokeWidth: 2.2 }} />
        </pattern>
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------- helpers
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
/** A clean axis: the max rounded up to a step of 1, 2, 2.5 or 5 x 10^n, and the ticks. */
export function niceScale(v: number, n = 4) {
  const top = v > 0 && Number.isFinite(v) ? v : 1;
  const raw = top / n;
  const e = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * e).find((s) => s >= raw - 1e-12) ?? 10 * e;
  const max = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= max + 1e-9; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max, ticks };
}
/** A bar growing right from the baseline: square at the baseline, 4 px rounded data end. */
function hbar(x0: number, y0: number, x1: number, y1: number, r = 4) {
  const w = x1 - x0;
  if (w <= 0.5) return "";
  const rr = Math.min(r, w, (y1 - y0) / 2);
  return `M${x0},${y0}H${x1 - rr}A${rr},${rr} 0 0 1 ${x1},${y0 + rr}V${y1 - rr}A${rr},${rr} 0 0 1 ${x1 - rr},${y1}H${x0}Z`;
}
/** A column growing up from the baseline. */
function vbar(x0: number, x1: number, yTop: number, yBase: number, r = 4) {
  const h = yBase - yTop;
  if (h <= 0.5) return "";
  const rr = Math.min(r, h, (x1 - x0) / 2);
  return `M${x0},${yBase}V${yTop + rr}A${rr},${rr} 0 0 1 ${x0 + rr},${yTop}H${x1 - rr}A${rr},${rr} 0 0 1 ${x1},${yTop + rr}V${yBase}Z`;
}

// ---------------------------------------------------------------- horizontal bars (one row per series, label above)
export type BarRow = { key: string; label: string; value: number; kind: Kind; ci?: [number, number]; marker?: number; markerLabel?: string; note?: string };
export function Bars({ rows, format, tickFormat, max, placeholder, title, markerKind = "model" }: { rows: BarRow[]; format: (v: number) => string; tickFormat?: (v: number) => string; max?: number; placeholder?: boolean; title: string; markerKind?: Kind }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const labelH = 17;
  const bar = 14;
  const rowH = labelH + bar + 11;
  const axisH = 20;
  const valueW = 64;
  const plotW = Math.max(60, width - valueW);
  const top = Math.max(...rows.map((r) => Math.max(r.value, r.ci?.[1] ?? 0, r.marker ?? 0)), 0);
  const { max: m, ticks } = niceScale(max ?? top);
  const x = (v: number) => (Math.max(0, Math.min(v, m)) / m) * plotW;
  const h = rows.length * rowH + axisH;
  const plotBottom = rows.length * rowH - 6;
  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={h} aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t) + 0.5} x2={x(t) + 0.5} y1={0} y2={plotBottom} />
              <text className="t-tick" x={x(t)} y={h - 5} textAnchor={t === 0 ? "start" : t === m ? "end" : "middle"}>
                {(tickFormat ?? format)(t)}
              </text>
            </g>
          ))}
          <line className="axis-line" x1={0.5} x2={0.5} y1={0} y2={plotBottom} />
          {rows.map((r, i) => {
            const y = i * rowH + labelH;
            const tipRows: TipRow[] = [{ kind: r.kind, label: r.label, value: format(r.value) }];
            if (r.ci) tipRows.push({ label: "95 % interval", value: `${format(r.ci[0])} to ${format(r.ci[1])}` });
            if (r.marker !== undefined) tipRows.push({ kind: markerKind, label: r.markerLabel ?? "Predicted", value: format(r.marker) });
            if (r.note) tipRows.push({ label: r.note, value: "" });
            const end = Math.max(x(r.value), r.ci ? x(r.ci[1]) : 0, r.marker !== undefined ? x(r.marker) + 6 : 0);
            return (
              <g key={r.key} className="vmark" {...tip(title, tipRows)}>
                <rect className="hit" x={0} y={i * rowH} width={width} height={rowH} />
                <text className="t-label" x={0} y={i * rowH + 12}>
                  {r.label}
                </text>
                <path className="fill" d={hbar(1, y, Math.max(1, x(r.value)), y + bar)} style={{ fill: placeholder ? HATCH : COLOUR[r.kind] }} />
                {r.ci && (
                  <g>
                    <line className="whisker-halo" x1={x(r.ci[0])} x2={x(r.ci[1])} y1={y + bar / 2} y2={y + bar / 2} />
                    <line className="whisker" x1={x(r.ci[0])} x2={x(r.ci[1])} y1={y + bar / 2} y2={y + bar / 2} />
                    <line className="whisker" x1={x(r.ci[0])} x2={x(r.ci[0])} y1={y + 2} y2={y + bar - 2} />
                    <line className="whisker" x1={x(r.ci[1])} x2={x(r.ci[1])} y1={y + 2} y2={y + bar - 2} />
                  </g>
                )}
                {r.marker !== undefined && <circle className="ring" cx={x(r.marker)} cy={y + bar / 2} r={5} style={{ fill: placeholder ? "var(--viz-ph)" : COLOUR[markerKind] }} />}
                <text className="t-value" x={Math.min(end + 6, width - 2)} y={y + bar / 2 + 4.5} textAnchor={end + 6 > width - valueW / 2 ? "end" : "start"}>
                  {format(r.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- columns with a predicted marker (calibration over time)
export type Column = { key: string; label: string; value: number; marker?: number; n?: number };
export function Columns({ cols, format, placeholder, title, valueLabel, markerLabel }: { cols: Column[]; format: (v: number) => string; placeholder?: boolean; title: string; valueLabel: string; markerLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const left = 40;
  const plotH = 170;
  const topPad = 22;
  const axisH = 34;
  const h = topPad + plotH + axisH;
  const vmax = Math.max(...cols.map((c) => Math.max(c.value, c.marker ?? 0)), 0);
  const { max: m, ticks } = niceScale(vmax, 4);
  const y = (v: number) => topPad + plotH - (Math.max(0, Math.min(v, m)) / m) * plotH;
  const band = Math.max(1, (width - left) / Math.max(1, cols.length));
  const colW = Math.min(24, band * 0.5);
  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={h} aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={left} x2={width} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
              <text className="t-tick" x={left - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          <line className="axis-line" x1={left} x2={width} y1={topPad + plotH + 0.5} y2={topPad + plotH + 0.5} />
          {cols.map((c, i) => {
            const cx = left + band * i + band / 2;
            const capY = Math.min(y(c.value), c.marker !== undefined ? y(c.marker) - 6 : Infinity);
            const rows: TipRow[] = [{ kind: "truth", label: valueLabel, value: format(c.value) }];
            if (c.marker !== undefined) rows.push({ kind: "model", label: markerLabel, value: format(c.marker) });
            if (c.n !== undefined) rows.push({ label: "trains", value: c.n.toLocaleString("en-GB") });
            return (
              <g key={c.key} className="vmark" {...tip(c.label, rows)}>
                <rect className="hit" x={cx - band / 2} y={topPad - 20} width={band} height={plotH + 20} />
                <path className="fill" d={vbar(cx - colW / 2, cx + colW / 2, y(c.value), topPad + plotH)} style={{ fill: placeholder ? HATCH : COLOUR.truth }} />
                {c.marker !== undefined && <circle className="ring" cx={cx} cy={y(c.marker)} r={5} style={{ fill: placeholder ? "var(--viz-ph)" : COLOUR.model }} />}
                <text className="t-value" x={cx} y={capY - 8} textAnchor="middle">
                  {format(c.value)}
                </text>
                <text className="t-axis" x={cx} y={topPad + plotH + 18} textAnchor="middle">
                  {c.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- calibration scatter (predicted vs observed)
export type CalPoint = { bin: string; predicted: number; observed: number; n: number };
export function Calibration({ points, placeholder, title }: { points: CalPoint[]; placeholder?: boolean; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const left = 56;
  const bottom = 40;
  const pad = 10;
  const size = Math.max(160, Math.min(width - left - pad, 340));
  const h = size + bottom + pad;
  const x = (v: number) => left + Math.max(0, Math.min(1, v)) * size;
  const y = (v: number) => pad + size - Math.max(0, Math.min(1, v)) * size;
  const nMax = Math.max(1, ...points.map((p) => p.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={h} aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t) + 0.5} x2={x(t) + 0.5} y1={pad} y2={pad + size} />
              <line className="grid-line" x1={left} x2={left + size} y1={y(t) + 0.5} y2={y(t) + 0.5} />
              <text className="t-tick" x={x(t)} y={pad + size + 15} textAnchor="middle">
                {pct(t)}
              </text>
              <text className="t-tick" x={left - 7} y={y(t) + 4} textAnchor="end">
                {pct(t)}
              </text>
            </g>
          ))}
          <line className="ref-line" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
          <text className="t-tick" x={x(1) - 6} y={y(0) - 8} textAnchor="end">
            diagonal: perfect calibration
          </text>
          <text className="t-axis" x={left + size / 2} y={h - 4} textAnchor="middle">
            Predicted probability
          </text>
          <text className="t-axis" transform={`translate(10 ${pad + size / 2}) rotate(-90)`} textAnchor="middle">
            Observed share
          </text>
          {points.map((p) => {
            const r = 4 + 5 * Math.sqrt(p.n / nMax);
            return (
              <g key={p.bin} className="vmark" {...tip(`Bin ${p.bin}`, [{ kind: "model", label: "predicted", value: pct(p.predicted) }, { kind: "truth", label: "observed", value: pct(p.observed) }, { label: "cases", value: p.n.toLocaleString("en-GB") }])}>
                <circle className="hit" cx={x(p.predicted)} cy={y(p.observed)} r={Math.max(12, r + 4)} />
                <circle className="fill ring" cx={x(p.predicted)} cy={y(p.observed)} r={r} style={{ fill: placeholder ? HATCH : COLOUR.model }} />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- meter: a share against its target
export function Meter({ value, target, placeholder, title }: { value: number; target: number; placeholder?: boolean; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const h = 46;
  const barY = 18;
  const barH = 12;
  const x = (v: number) => Math.max(0, Math.min(1, v)) * (width - 2) + 1;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={h} aria-label={title}>
          <g className="vmark" {...tip(title, [{ kind: "model", label: "of actual ends inside the band", value: pct(value) }, { label: "target (the band's level)", value: pct(target) }])}>
            <rect className="hit" x={0} y={0} width={width} height={h} />
            <rect x={1} y={barY} width={width - 2} height={barH} rx={6} style={{ fill: "var(--cloud)" }} />
            <path className="fill" d={hbar(1, barY, Math.max(2, x(value)), barY + barH, 6)} style={{ fill: placeholder ? HATCH : COLOUR.model }} />
            <line className="target" x1={x(target)} x2={x(target)} y1={barY - 5} y2={barY + barH + 5} />
            <text className="t-tick" x={x(target)} y={barY - 8} textAnchor="middle">
              target {pct(target)}
            </text>
            <text className="t-tick" x={1} y={h - 2}>
              0 %
            </text>
            <text className="t-tick" x={width - 1} y={h - 2} textAnchor="end">
              100 %
            </text>
          </g>
        </svg>
      )}
    </div>
  );
}
