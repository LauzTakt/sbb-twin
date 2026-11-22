// "How good are the forecasts?": the evidence behind the twin's forecasts, for judges. Everything comes from the
// scorecards in research/<model>/scorecard.json (out-of-time tests, re-runnable scripts) and from the twin's live
// shadow log (each disruption's first prediction, scored when it ends). A placeholder scorecard is shown as such and
// its numbers never appear as results. Each comparison carries its verdict from the 95 % interval: better, level
// (the interval includes zero) or worse, so nothing is claimed that the test does not show.
import { ArrowLeft, Map as MapIcon, Monitor, Moon, Sun, TrainFront, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ForecastsResponse, Metric, ModelInfo, Scorecard, ScorecardEntry, ScorecardsResponse, ShadowEntry, ShadowResponse } from "../forecastTypes";
import { applyPageTheme, onSystemThemeChange, readPref, resolveTheme, savePref, shownTheme, switchMs, systemTheme, type Pref, type Theme } from "../theme";
import { Bars, Calibration, Columns, Defs, Meter, TipLayer, type BarRow, type CalPoint } from "./charts";

// ---------------------------------------------------------------- formatting
const NB = " ";
const NNB = " "; // a narrow no-break space before the percent sign
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}${NNB}%`;
const signed = (v: number, d = 4) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
/** An interval, with as many decimals as its smaller end needs. */
const interval = (a: number, b: number, unit: "brier" | "share" | "min" = "brier") => {
  if (unit === "share") return `${signed(a * 100, 0)} to ${signed(b * 100, 0)}${NB}points`;
  if (unit === "min") return `${signed(a, 0)} to ${signed(b, 0)}${NB}min`;
  const d = Math.min(Math.abs(a) || 1, Math.abs(b) || 1) < 0.001 ? 4 : 3;
  return `${signed(a, d)} to ${signed(b, d)}`;
};
/** Axis ticks without trailing zeros (0, 0.1, 0.25). */
const tick = (v: number) => String(Number(v.toFixed(4)));
const brier = (v: number) => v.toFixed(3);
const minutes = (v: number) => `${Math.round(v)}${NB}min`;
const TZ = "Europe/Zurich";
const hm = (ms: number) => new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const sameDay = (a: number, b: number) => new Date(a).toLocaleDateString("en-GB", { timeZone: TZ }) === new Date(b).toLocaleDateString("en-GB", { timeZone: TZ });
const when = (ms: number) => (sameDay(ms, Date.now()) ? hm(ms) : `${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: TZ })}, ${hm(ms)}`);
const stamp = (iso: string) => {
  const d = Date.parse(iso);
  return Number.isNaN(d) ? iso : new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2024-03..2025-12" -> "March 2024 to December 2025" */
const period = (p?: string) => {
  const m = p?.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
  if (!m) return p;
  return m[1] === m[3] ? `${MONTHS[Number(m[2]) - 1]} to ${MONTHS[Number(m[4]) - 1]} ${m[3]}` : `${MONTHS[Number(m[2]) - 1]} ${m[1]} to ${MONTHS[Number(m[4]) - 1]} ${m[3]}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hours = (min: number) => (min >= 90 ? `${(min / 60).toFixed(1)}${NB}h` : `${Math.round(min)}${NB}min`);

/** Names of the series a scorecard compares (the model against baselines). */
const SERIES: Record<string, string> = {
  model: "Model",
  operator: "SBB's announced end",
  operator_point: "SBB's announced end, as yes or no",
  operator_latest: "SBB's latest announced end",
  operator_latest_point: "SBB's latest announced end, as yes or no",
  model_updated: "Model with the latest announcement",
  cause: "History of the same cause",
  prior: "Historical rate",
  prior_median: "Historical median",
  baseline: "Historical rate",
  other_family_discrete_hazard: "Other model family (discrete hazard)",
  operator_plus_median_correction: "Announced end + correction",
  operator_learned_residual_didac: "Announced end + learned residual",
  chosen_point_rule: "Recommended: announced end + correction",
  model_conformal: "Model's band, as used live",
  model_raw: "Model's band before calibration",
  history: "Past incident counts",
  trains: "Trains per day",
  train_km: "Train-km",
  km: "Track length",
  length: "Track length",
  traffic: "Train traffic",
};
const series = (k: string) => SERIES[k] ?? cap(k.replace(/_/g, " "));
/** A series name inside a sentence ("SBB's" keeps its capitals). */
const lower = (k: string) => {
  const s = series(k);
  return s.startsWith("SBB") ? s : s.charAt(0).toLowerCase() + s.slice(1);
};
/** The comparisons drawn as bars; any other value stays in the table under the chart. */
const MAIN = ["model", "chosen_point_rule", "model_conformal", "operator", "cause", "prior", "baseline", "history", "train_km", "trains", "km", "length", "traffic"];
const MODEL_NAMES: Record<string, string> = { duration: "Duration", post_resumption: "Trains after a resumption", section_risk: "Section risk map" };
const isPh = (e?: ScorecardEntry) => !!e && (e.source === "placeholder" || e.scorecard?.placeholder === true);
const usable = (e?: ScorecardEntry): e is ScorecardEntry & { scorecard: Scorecard } => !!e && e.source !== "missing" && !!e.scorecard;
const horizonOf = (name: string) => Number(name.match(/(\d+)\s*min/i)?.[1] ?? NaN);
const kOf = (name: string) => Number(name.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] ?? NaN);
const inH = (min: number) => (min % 60 === 0 ? `${min / 60}${NB}h` : `${min}${NB}min`);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------- verdicts from the 95 % intervals
type Verdict = { other: string; lo: number; hi: number; result: "better" | "level" | "worse"; justBarely: boolean };
/**
 * The interval of the model's gain over one baseline, oriented so that above zero means the model is better. A
 * scorecard states whether its intervals are model minus baseline or the improvement (baseline minus model); when it
 * does not, the sign of the interval is matched with the sign of the difference of the two values.
 */
function verdicts(m: Metric, notes: string): Verdict[] {
  const out: Verdict[] = [];
  const said = `${typeof m.note === "string" ? m.note : ""} ${notes}`.toLowerCase();
  for (const [key, ci] of Object.entries(m.ci95 ?? {})) {
    const mm = key.match(/^model_vs_(.+)$/);
    if (!mm || mm[1].endsWith("_weekblock") || !Array.isArray(ci)) continue;
    const other = mm[1];
    const a = num(m.values?.model);
    const b = num(m.values?.[other]);
    let modelMinus: boolean;
    if (said.includes("baseline minus model") || said.includes("is the improvement")) modelMinus = false;
    else if (said.includes("model minus baseline")) modelMinus = true;
    else if (a !== undefined && b !== undefined && a !== b) modelMinus = Math.sign((ci[0] + ci[1]) / 2) === Math.sign(a - b);
    else modelMinus = true;
    // as model minus baseline, then as the gain
    const d: [number, number] = modelMinus ? [ci[0], ci[1]] : [-ci[1], -ci[0]];
    const gain: [number, number] = m.lowerIsBetter ? [-d[1], -d[0]] : d;
    const result = gain[0] > 0 ? "better" : gain[1] < 0 ? "worse" : "level";
    const near = Math.min(Math.abs(gain[0]), Math.abs(gain[1]));
    out.push({ other, lo: gain[0], hi: gain[1], result, justBarely: result !== "level" && near < 0.1 * (gain[1] - gain[0]) });
  }
  return out;
}
/** "Better than A (only just) and B; level with C." */
function verdictSentence(vs: Verdict[]) {
  const list = (xs: Verdict[]) => {
    const names = xs.map((v) => `${lower(v.other)}${v.justBarely ? " (only just)" : ""}`);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  };
  const better = vs.filter((v) => v.result === "better");
  const level = vs.filter((v) => v.result === "level");
  const worse = vs.filter((v) => v.result === "worse");
  const parts = [better.length ? `Better than ${list(better)}` : "", level.length ? `${better.length ? "level" : "Level"} with ${list(level)}` : "", worse.length ? `${better.length || level.length ? "worse" : "Worse"} than ${list(worse)}` : ""].filter(Boolean);
  return parts.length ? `${parts.join("; ")}.` : "";
}

// ---------------------------------------------------------------- building blocks
function Panel({ title, hint, placeholder, children, className }: { title: string; hint?: string; placeholder?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={["panel", placeholder ? "placeholder" : "", className ?? ""].filter(Boolean).join(" ")}>
      <h3>
        {title} {placeholder && <span className="chip ph">Placeholder</span>}
      </h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  );
}
function Banner() {
  return (
    <div className="banner" role="note">
      <TriangleAlert size={18} />
      <span>
        <b>Placeholder: the trained model has not landed yet; these numbers only show the layout.</b>
        Hatched marks are made-up values. The page switches to the real scorecard as soon as it is published.
      </span>
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Numbers({ head, rows, label = "Show the numbers" }: { head: string[]; rows: (string | number)[][]; label?: string }) {
  return (
    <details className="numbers">
      <summary>{label}</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} className={i ? "num" : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={j ? "num" : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
function LegendRow({ items }: { items: { kind: "sw" | "dot"; colour: string; label: string; ph?: boolean }[] }) {
  return (
    <div className="legend-row">
      {items.map((i) => (
        <span key={i.label}>
          <i className={`${i.kind}${i.ph ? " ph" : ""}`} style={i.ph ? undefined : { background: i.colour }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
const mainKeys = (m: Metric) => {
  const keys = Object.keys(m.values ?? {}).filter((k) => num(m.values[k]) !== undefined);
  const shown = MAIN.filter((k) => keys.includes(k));
  return shown.length ? shown : keys;
};

/** One metric: the model's bar and each baseline's, the verdict from the intervals, every value in the table. */
function MetricPanel({ metric, title, hint, format, max, placeholder, tickFormat, notes, unit = "brier", keys, accent = "model", verdict, rename }: { metric: Metric; title: string; hint: string; format: (v: number) => string; max?: number; placeholder: boolean; tickFormat?: (v: number) => string; notes: string; unit?: "brier" | "share" | "min"; keys?: string[]; accent?: string; verdict?: string; rename?: Record<string, string> }) {
  const shown = keys ?? mainKeys(metric);
  const rows: BarRow[] = shown.map((k) => ({ key: k, label: rename?.[k] ?? series(k), value: metric.values[k], kind: k === accent || (accent === "model" && k === "model_conformal") ? "model" : "base", ci: Array.isArray(metric.ci95?.[k]) ? metric.ci95![k] : undefined }));
  const vs = verdicts(metric, notes).filter((v) => shown.includes(v.other));
  const all = Object.keys(metric.values ?? {}).filter((k) => num(metric.values[k]) !== undefined);
  const gains = verdicts(metric, notes);
  const sentence = verdict ?? (vs.length ? verdictSentence(vs) : "");
  return (
    <Panel title={title} hint={hint} placeholder={placeholder}>
      <Bars rows={rows} format={format} tickFormat={tickFormat} max={max} placeholder={placeholder} title={metric.name} />
      {!placeholder && sentence && <p className="verdict">{sentence}</p>}
      <Numbers
        head={["Series", "Value", "Gain of the model, 95 % interval"]}
        rows={all.map((k) => {
          const g = gains.find((v) => v.other === k);
          return [series(k), format(metric.values[k]), g ? `${interval(g.lo, g.hi, unit)} (${g.result})` : ""];
        })}
      />
    </Panel>
  );
}
/** Metrics with no chart of their own: one row each, every series as a column. */
function AlsoChecked({ title, metrics, format, placeholder }: { title: string; metrics: Metric[]; format: (v: number, m: Metric) => string; placeholder: boolean }) {
  const cols = [...new Set(metrics.flatMap((m) => Object.keys(m.values ?? {}).filter((k) => num(m.values[k]) !== undefined)))];
  const order = [...MAIN.filter((k) => cols.includes(k)), ...cols.filter((k) => !MAIN.includes(k))];
  const counted = metrics.some((m) => num(m.n) !== undefined);
  return (
    <Panel title={title} className="gap" placeholder={placeholder}>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Check</th>
              {counted && <th className="num">Cases</th>}
              {order.map((k) => (
                <th key={k} className="num">
                  {series(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.name}>
                <td>
                  {m.name}
                  {typeof m.note === "string" && <small>{m.note}</small>}
                </td>
                {counted && <td className="num">{num(m.n) ?? ""}</td>}
                {order.map((k) => (
                  <td key={k} className="num">
                    {num(m.values?.[k]) !== undefined ? format(m.values[k], m) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
function Examples({ rows, placeholder, caption, head = ["Case", "Announced", "Predicted", "Actual"] }: { rows: NonNullable<Scorecard["examples"]>; placeholder: boolean; caption: string; head?: string[] }) {
  return (
    <Panel title={caption} placeholder={placeholder} className="gap">
      <div className="table-card">
        <table>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.title}
                  {(typeof r.cause === "string" || typeof r.start === "string") && <small>{[r.cause, typeof r.start === "string" ? `first notice ${r.start}` : ""].filter(Boolean).join(" · ")}</small>}
                </td>
                <td>{r.announced}</td>
                <td>{r.predicted}</td>
                <td>{r.actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
function Source({ s }: { s: Scorecard }) {
  const d = s.data ?? {};
  const counts = [num(d.incidentsTrain) ? `${Number(d.incidentsTrain).toLocaleString("en-GB")} incidents to train` : "", num(d.incidentsTest) ? `${Number(d.incidentsTest).toLocaleString("en-GB")} to test` : ""].filter(Boolean).join(", ");
  const parts = [counts, typeof d.source === "string" ? `Data: ${d.source}` : "", s.generatedAt ? `Scorecard generated ${stamp(s.generatedAt)}` : ""].filter(Boolean);
  return <p className="source">{parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ")}</p>;
}
const notesOf = (s: Scorecard) => (s.notes ?? []).join(" ");

// ---------------------------------------------------------------- headline tiles
type Tile = { key: string; label: string; value: string; unit?: string; sub: string; placeholder: boolean; real: boolean };
const brierMain = (s: Scorecard) => s.metrics.filter((m) => /brier/i.test(m.name) && !/\|/.test(m.name)).sort((a, b) => (horizonOf(a.name) || 0) - (horizonOf(b.name) || 0));
function coverageTile(e?: ScorecardEntry): Tile | null {
  if (!usable(e)) return null;
  const m = e.scorecard.metrics.find((x) => /coverage/i.test(x.name));
  const key = m ? (num(m.values.model_conformal) !== undefined ? "model_conformal" : num(m.values.model) !== undefined ? "model" : Object.keys(m.values)[0]) : undefined;
  if (!m || !key) return null;
  const v = m.values[key];
  const target = num(m.target) ?? (kOf(m.name) / 100 || 0.8);
  const ci = Array.isArray(m.ci95?.[key]) ? m.ci95![key] : undefined;
  const width = num((m.medianWidthMin as Record<string, number> | undefined)?.[key]);
  const n = num(m.n);
  return {
    key: "coverage",
    label: `How long a disruption lasts: share of ${n ? `the ${n} test disruptions` : "test disruptions"} that ended inside the model's ${pct(target)} band`,
    value: pct(v),
    sub: [`target ${pct(target)}`, ci ? `95${NNB}% interval ${pct(ci[0])} to ${pct(ci[1])}` : "", width ? `the band is wide: median ${hours(width)}` : ""].filter(Boolean).join("; "),
    placeholder: isPh(e),
    real: e.source === "real",
  };
}
function durationTile(e?: ScorecardEntry): Tile | null {
  if (!usable(e)) return null;
  const list = brierMain(e.scorecard);
  const notes = notesOf(e.scorecard);
  // the first horizon where the gain over SBB's announcement is real; otherwise 2 h
  const pick = list.find((m) => verdicts(m, notes).some((v) => v.other === "operator" && v.result === "better")) ?? list.find((m) => horizonOf(m.name) === 120) ?? list[0];
  if (!pick || num(pick.values.model) === undefined) return null;
  const base = num(pick.values.operator) !== undefined ? "operator" : Object.keys(pick.values).find((k) => k !== "model");
  if (!base) return null;
  const gain = (pick.values[base] - pick.values.model) / pick.values[base];
  const v = verdicts(pick, notes).find((x) => x.other === base);
  const h = horizonOf(pick.name);
  return {
    key: "duration",
    label: `Still disrupted ${Number.isFinite(h) ? `${inH(h)} after the first notice` : "later"}? Brier score of the model vs ${lower(base)}`,
    value: pct(Math.abs(gain)),
    unit: gain >= 0 ? "lower" : "higher",
    sub: `${brier(pick.values.model)} vs ${brier(pick.values[base])}${v ? `; ${v.result === "better" ? (v.justBarely ? "a real gain, only just: the interval barely clears zero" : "a real gain") : v.result === "level" ? "within noise" : "worse"}` : ""}`,
    placeholder: isPh(e),
    real: e.source === "real",
  };
}
function pointTile(e?: ScorecardEntry): Tile | null {
  if (!usable(e)) return null;
  const m = e.scorecard.metrics.find((x) => /absolute error/i.test(x.name) && num(x.values.chosen_point_rule) !== undefined);
  if (!m) return null;
  const corr = (typeof m.note === "string" ? m.note : "").match(/\+\s*([\d.]+)\s*min/)?.[1];
  const op = num(m.values.operator);
  const md = num(m.values.model);
  return {
    key: "point",
    label: `The end time shown: ${corr ? `SBB's announced end + ${corr}${NB}min` : "the announced end + a correction"}, mean error on ${num(m.n) ? `${m.n} ` : ""}test disruptions`,
    value: `${Math.round(m.values.chosen_point_rule)}`,
    unit: "min",
    sub: [op !== undefined ? `${Math.round(op)}${NB}min for the raw announcement` : "", md !== undefined ? `${Math.round(md)}${NB}min for the model's median` : ""].filter(Boolean).join(", ") + "; chosen on 2025, not on the test year",
    placeholder: isPh(e),
    real: e.source === "real",
  };
}
function resumptionTile(e?: ScorecardEntry): Tile | null {
  if (!usable(e)) return null;
  const m = e.scorecard.metrics.find((x) => x.ci95 && Object.keys(x.ci95).length && num(x.values.model) !== undefined);
  if (!m) return null;
  const base = Object.keys(m.values).find((k) => k !== "model");
  if (!base) return null;
  const gain = (m.values[base] - m.values.model) / m.values[base];
  const v = verdicts(m, notesOf(e.scorecard)).find((x) => x.other === base);
  const year = m.name.match(/(\d{4}) test/)?.[1];
  return {
    key: "post_resumption",
    label: `Trains to check after "Service resumed": Brier score vs the ${lower(base)}${year ? `, ${year} test` : ""}`,
    value: pct(Math.abs(gain), 1),
    unit: gain >= 0 ? "lower" : "higher",
    sub: `${m.values.model.toFixed(4)} vs ${m.values[base].toFixed(4)}${v ? `; ${v.result === "better" ? "a real gain in both test years" : v.result === "level" ? "within noise" : "worse"}` : ""}`,
    placeholder: isPh(e),
    real: e.source === "real",
  };
}
const recallMetrics = (s: Scorecard) => s.metrics.filter((m) => (/recall/i.test(m.name) || /incidents in the top/i.test(m.name)) && !/validation/i.test(m.name)).sort((a, b) => (kOf(a.name) || 0) - (kOf(b.name) || 0));
function riskTile(e?: ScorecardEntry): Tile | null {
  if (!usable(e)) return null;
  const list = recallMetrics(e.scorecard);
  const m = list.find((x) => kOf(x.name) === 10) ?? list[0];
  if (!m || num(m.values.model) === undefined) return null;
  const vs = verdicts(m, notesOf(e.scorecard));
  const exposure = ["trains", "traffic", "km", "length", "train_km"].find((k) => num(m.values[k]) !== undefined);
  const level = vs.filter((v) => v.result !== "better");
  const k = kOf(m.name);
  return {
    key: "section_risk",
    label: `Risk map: share of the test year's disruptions on the top ${Number.isFinite(k) ? `${k}${NNB}%` : ""} of segments`,
    value: pct(m.values.model),
    sub: [exposure ? `vs ${pct(m.values[exposure])} ranking by ${lower(exposure)}` : "", ...level.map((v) => `${v.result} with ${lower(v.other)} (${pct(m.values[v.other])})`.replace("level with", "only level with"))].filter(Boolean).join("; "),
    placeholder: isPh(e),
    real: e.source === "real",
  };
}
/** A headline number. A placeholder scorecard's number is never shown here: the tile says the model is not in yet. */
function TileView({ t, hero }: { t: Tile; hero?: boolean }) {
  if (t.placeholder)
    return (
      <div className="tile placeholder">
        <span className="label">{t.label}</span>
        <span className="value pending">Not trained yet</span>
        <span className="sub">The number appears here when the trained model's scorecard lands.</span>
        <span className="chip ph">Placeholder</span>
      </div>
    );
  return (
    <div className={["tile", hero ? "hero" : ""].filter(Boolean).join(" ")}>
      <span className="label">{t.label}</span>
      <span className="value">
        {t.value}
        {t.unit && <small>{t.unit}</small>}
      </span>
      {t.sub && <span className="sub">{t.sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- sections
function DurationSection({ e }: { e?: ScorecardEntry }) {
  if (!usable(e)) return <Empty>The duration model's scorecard is not published yet (research/duration/scorecard.json).</Empty>;
  const s = e.scorecard;
  const ph = isPh(e);
  const notes = notesOf(s);
  const main = brierMain(s);
  const later = s.metrics.filter((m) => /brier/i.test(m.name) && /\|/.test(m.name));
  const coverage = s.metrics.find((m) => /coverage/i.test(m.name));
  const errors = s.metrics.filter((m) => /absolute error/i.test(m.name));
  const mainError = errors.find((m) => num(m.values.chosen_point_rule) !== undefined) ?? errors[0];
  const others = s.metrics.filter((m) => !main.includes(m) && !later.includes(m) && m !== coverage && !errors.includes(m));
  const shared = Math.max(0, ...main.flatMap((m) => mainKeys(m).map((k) => m.values[k])));
  const cal = (s.calibration ?? []).filter((c) => Number.isFinite(c.predicted) && Number.isFinite(c.observed) && c.predicted <= 1 && c.observed <= 1) as CalPoint[];
  const covKey = coverage ? (num(coverage.values.model_conformal) !== undefined ? "model_conformal" : num(coverage.values.model) !== undefined ? "model" : Object.keys(coverage.values)[0]) : undefined;
  const nominal = coverage ? num(coverage.target) ?? (kOf(coverage.name) / 100 || 0.8) : 0.8;
  const planned = s.planned as { nTest?: number; shareEndedWithin30MinOfAnnounced?: number; maeOperatorMin?: number; maeModelMin?: number } | undefined;
  // the end time the twin shows: SBB's announced end + a fixed correction (the rule with the lower error), said plainly
  const correction = mainError && typeof mainError.note === "string" ? mainError.note.match(/\+\s*([\d.]+)\s*min/)?.[1] : undefined;
  let errorVerdict: string | undefined;
  if (mainError && num(mainError.values.chosen_point_rule) !== undefined && num(mainError.values.operator) !== undefined) {
    const vm = verdicts(mainError, notes).find((v) => v.other === "operator");
    errorVerdict = `Lowest error in the test year: ${minutes(mainError.values.chosen_point_rule)} against ${minutes(mainError.values.operator)} for the raw announcement (no interval published for this pair).${num(mainError.values.model) !== undefined && vm ? ` The model's median, ${minutes(mainError.values.model)}, is ${vm.result === "level" ? "level with" : vm.result === "better" ? "better than" : "worse than"} the announcement.` : ""}`;
  }
  return (
    <>
      {ph ? <Banner /> : <p className="lead">{s.headline}</p>}
      {main.length > 0 && (
        <div className="grid c3">
          {main.map((m) => {
            const h = horizonOf(m.name);
            return <MetricPanel key={m.name} metric={m} notes={notes} title={Number.isFinite(h) ? `Still disrupted ${inH(h)} after the first notice?` : m.name} hint={`Brier score of the probability, lower is better${num(m.n) ? `; ${m.n} disruptions` : ""}`} format={brier} tickFormat={tick} max={shared} placeholder={ph} />;
          })}
        </div>
      )}
      <div className="grid c21 gap">
        {cal.length > 0 ? (
          <Panel title="Calibration" hint="When the model gives a probability, how often the disruption was in fact still on. Dots on the diagonal are well calibrated; a bigger dot holds more cases (few per bin: read the trend, not single dots)." placeholder={ph}>
            <Calibration points={cal} placeholder={ph} title="Calibration of the duration model" />
            <Numbers head={["Predicted", "Mean predicted", "Observed", "Cases"]} rows={cal.map((c) => [c.bin, pct(c.predicted), pct(c.observed), c.n])} />
          </Panel>
        ) : (
          <Empty>No calibration table in this scorecard.</Empty>
        )}
        <div className="grid">
          {coverage && covKey && (
            <Panel title="Is the 80 % band honest?" hint={`How often the actual end fell inside the model's ${pct(nominal)} band. Close to ${pct(nominal)} is honest; far below means the band is too narrow.`} placeholder={ph}>
              <div className="meter-value">
                {pct(coverage.values[covKey])}
                <small>of actual ends inside the band</small>
              </div>
              <Meter value={coverage.values[covKey]} target={nominal} placeholder={ph} title="Interval coverage" />
              <p className="note">
                {[
                  Array.isArray(coverage.ci95?.[covKey]) ? `95${NNB}% interval ${pct(coverage.ci95![covKey][0])} to ${pct(coverage.ci95![covKey][1])}.` : "",
                  num(coverage.values.model_raw) !== undefined && covKey !== "model_raw" ? `Before the conformal calibration the band covered ${pct(coverage.values.model_raw)}.` : "",
                  num((coverage.medianWidthMin as Record<string, number> | undefined)?.[covKey]) ? `The band is wide: median ${hours((coverage.medianWidthMin as Record<string, number>)[covKey])}.` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            </Panel>
          )}
          {mainError && (
            <MetricPanel
              metric={mainError}
              notes={notes}
              title="Which end time to show?"
              hint={`Mean absolute error of the end time, lower is better${num(mainError.n) ? `; ${mainError.n} disruptions with an announced end` : ""}. ${correction ? `The rule adds ${correction}${NB}min, the training years' median overrun, to SBB's announced end; it was picked on 2025, before the test.` : ""}`}
              format={minutes}
              tickFormat={tick}
              placeholder={ph}
              unit="min"
              accent="chosen_point_rule"
              rename={{ model: "Model's median end" }}
              keys={["chosen_point_rule", "operator", "model"].filter((k) => num(mainError.values[k]) !== undefined)}
              verdict={errorVerdict}
            />
          )}
        </div>
      </div>
      {planned && num(planned.nTest) !== undefined && (
        <p className="lead gap">
          Planned works are rare in the test year ({planned.nTest} cases): their announced end was kept within 30{NB}min in {pct(planned.shareEndedWithin30MinOfAnnounced ?? 0)} of them
          {num(planned.maeOperatorMin) !== undefined && num(planned.maeModelMin) !== undefined ? `; mean error ${Math.round(planned.maeModelMin!)}${NB}min for the model vs ${Math.round(planned.maeOperatorMin!)}${NB}min for the announcement` : ""}. Too few to claim more.
        </p>
      )}
      {later.length > 0 && (
        <AlsoChecked
          title="Later in a disruption: forecasts made 30 or 60 minutes after the first notice, for those still on (Brier, lower is better)"
          metrics={later.map((m) => {
            const x = m.name.match(/^Brier at (\d+) min \| still open at (\d+) min$/i);
            return x ? { ...m, name: `Still on ${inH(Number(x[1]))} after the notice? Forecast at ${x[2]}${NB}min` } : m;
          })}
          format={(v) => v.toFixed(3)}
          placeholder={ph}
        />
      )}
      {[...errors.filter((m) => m !== mainError), ...others].length > 0 && <AlsoChecked title="Also checked" metrics={[...errors.filter((m) => m !== mainError), ...others]} format={(v, m) => (/error|min\)/i.test(m.name) ? `${v.toFixed(1)}` : v.toFixed(3))} placeholder={ph} />}
      {s.examples && s.examples.length > 0 && <Examples rows={s.examples.slice(0, 6)} placeholder={ph} caption="Real examples from the test year, forecast at the first notice" />}
      <Source s={s} />
    </>
  );
}

type BandCal = { bin: string; predicted: number; observed: number; n: number };
function ResumptionSection({ e }: { e?: ScorecardEntry }) {
  if (!usable(e)) return <Empty>The post-resumption scorecard is not published yet (research/post_resumption/scorecard.json).</Empty>;
  const s = e.scorecard;
  const ph = isPh(e);
  const notes = notesOf(s);
  const main = s.metrics.filter((m) => m.ci95 && Object.keys(m.ci95).length);
  const rest = s.metrics.filter((m) => !main.includes(m));
  const max = Math.max(0, ...s.metrics.flatMap((m) => Object.values(m.values ?? {}).filter((v) => typeof v === "number")));
  const bands = (Array.isArray(s.calibrationByBand) ? s.calibrationByBand : []) as BandCal[];
  const quarters = (s.calibration ?? []).filter((c) => Number.isFinite(c.observed));
  const first = quarters[0];
  const acceptance = s.acceptance as { rule?: string; passed?: boolean } | undefined;
  const short = (bin: string) => bin.replace(/\s*after the notice$/i, "");
  return (
    <>
      {ph ? <Banner /> : <p className="lead">{s.headline}</p>}
      {acceptance?.rule && (
        <p className="lead">
          <span className={`chip ${acceptance.passed ? "ok" : "ph"}`}>{acceptance.passed ? "Acceptance rule passed" : "Acceptance rule not met"}</span> {cap(acceptance.rule)}.
        </p>
      )}
      {main.length > 0 && (
        <div className="grid c2">
          {main.map((m) => {
            // "Brier score, 2026 test (trained on 2024-25): 769 runs after 123 resumptions" -> a short title, the rest as a hint
            const parts = m.name.match(/^Brier score,\s*(\d{4}) test\s*\(trained on ([^)]+)\):\s*(.+)$/i);
            const title = parts ? `${parts[1]} test` : m.name;
            const hint = parts ? `Trained on ${parts[2]}; ${parts[3]}. Brier score, lower is better.` : "Brier score, lower is better.";
            return <MetricPanel key={m.name} metric={m} notes={notes} title={title} hint={hint} format={(v) => v.toFixed(3)} tickFormat={tick} max={max} placeholder={ph} />;
          })}
        </div>
      )}
      <div className="grid c2 gap">
        {bands.length > 0 && (
          <Panel title="Do the bands separate? Observed share by band" hint="Share of trains that still lost a stop on the section, by the band the model put them in (2026 test). The dot is the model's average probability in that band." placeholder={ph}>
            <LegendRow items={[{ kind: "sw", colour: "var(--viz-truth)", label: "Observed share", ph }, { kind: "dot", colour: "var(--viz-model)", label: "Model's average probability" }]} />
            <Bars rows={bands.map((b) => ({ key: b.bin, label: `${cap(b.bin)} · ${b.n.toLocaleString("en-GB")} trains`, value: b.observed, kind: "truth", marker: b.predicted, markerLabel: "Model's average probability" }))} format={(v) => pct(v)} placeholder={ph} title="Observed share by band" />
            <p className="note">The bands are what the console shows: staff read the band and its observed share, not a precise percentage.</p>
            <Numbers head={["Band", "Trains", "Observed", "Model average"]} rows={bands.map((b) => [cap(b.bin), b.n, pct(b.observed, 1), pct(b.predicted, 1)])} />
          </Panel>
        )}
        {quarters.length > 0 && (
          <Panel title="By quarter hour after the notice" hint="Observed share of trains that lost a stop, and the model's average probability, by how soon the train was due after the notice (2026 test)." placeholder={ph}>
            <LegendRow items={[{ kind: "sw", colour: "var(--viz-truth)", label: "Observed share", ph }, { kind: "dot", colour: "var(--viz-model)", label: "Model's average probability" }]} />
            <Columns cols={quarters.map((q) => ({ key: q.bin, label: short(q.bin), value: q.observed, marker: q.predicted, n: q.n }))} format={(v) => pct(v)} placeholder={ph} title="Calibration by quarter hour" valueLabel="observed share" markerLabel="model's average probability" />
            {first && first.observed - first.predicted > 0.05 && (
              <p className="note warn-text">
                The model under-predicts the first quarter hour: {pct(first.predicted)} predicted, {pct(first.observed)} observed. Read the bands and the observed shares, not the exact percentages.
              </p>
            )}
            <Numbers head={["Due after the notice", "Trains", "Observed", "Model average"]} rows={quarters.map((q) => [short(q.bin), q.n, pct(q.observed, 1), pct(q.predicted, 1)])} />
          </Panel>
        )}
      </div>
      {rest.length > 0 && <AlsoChecked title="Also checked" metrics={rest} format={(v) => v.toFixed(4)} placeholder={ph} />}
      {s.examples && s.examples.length > 0 && <Examples rows={s.examples.slice(0, 6)} placeholder={ph} caption="One real resumption from the test year, train by train" />}
      <Source s={s} />
    </>
  );
}

function RiskSection({ e }: { e?: ScorecardEntry }) {
  if (!usable(e)) return <Empty>The section risk scorecard is not published yet (research/section_risk/scorecard.json).</Empty>;
  const s = e.scorecard;
  const ph = isPh(e);
  const notes = notesOf(s);
  const recall = recallMetrics(s);
  const others = s.metrics.filter((m) => !recall.includes(m));
  const max = Math.max(0, ...recall.flatMap((m) => [...mainKeys(m).map((k) => m.values[k]), ...(Array.isArray(m.ci95?.model) ? [m.ci95!.model[1]] : [])]));
  const bands = (s.calibration ?? []).filter((c) => Number.isFinite(c.predicted) && Number.isFinite(c.observed));
  const nSeg = num(s.data?.segments);
  return (
    <>
      {ph ? <Banner /> : <p className="lead">{s.headline}</p>}
      {recall.length > 0 && (
        <div className="grid c3">
          {recall.map((m) => {
            const k = kOf(m.name);
            return (
              <MetricPanel
                key={m.name}
                metric={m}
                notes={notes}
                title={Number.isFinite(k) ? `Top ${k}${NNB}% of segments` : m.name}
                hint={`Share of the test year's disruptions on the segments ranked riskiest on the training years${nSeg && Number.isFinite(k) ? ` (${Math.round((nSeg * k) / 100)} of ${nSeg.toLocaleString("en-GB")})` : ""}. Higher is better; the whisker is the model's 95${NNB}% interval.`}
                format={(v) => pct(v)}
                max={Math.min(1, max * 1.05)}
                placeholder={ph}
                unit="share"
              />
            );
          })}
        </div>
      )}
      <div className="grid c12 gap">
        {bands.length > 0 && (
          <Panel title="Expected and observed disruptions by rank" hint="Disruptions the training-years rates expected in the test period, and how many happened, by rank band." placeholder={ph}>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Segments</th>
                    <th className="num">Segments</th>
                    <th className="num">Expected</th>
                    <th className="num">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((b) => (
                    <tr key={b.bin}>
                      <td>{cap(b.bin.replace(/^segments\s*/i, ""))}</td>
                      <td className="num">{b.n.toLocaleString("en-GB")}</td>
                      <td className="num">{b.predicted.toFixed(1)}</td>
                      <td className="num">{b.observed.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        {s.examples && s.examples.length > 0 && (
          <Panel title="The riskiest segments" placeholder={ph}>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Segment</th>
                    <th>Length, traffic</th>
                    <th>Model</th>
                    <th>Disruptions</th>
                  </tr>
                </thead>
                <tbody>
                  {s.examples.slice(0, 6).map((r) => (
                    <tr key={r.id}>
                      <td>{r.title}</td>
                      <td>{r.announced}</td>
                      <td>{r.predicted}</td>
                      <td>{r.actual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
      {others.length > 0 && <AlsoChecked title="Also checked: how much track each top set covers, and the 2025 validation" metrics={others} format={(v) => pct(v)} placeholder={ph} />}
      <p className="lead gap">
        <a className="action" href="/?risk=1">
          <MapIcon size={16} /> Open the risk map
        </a>
      </p>
      <Source s={s} />
    </>
  );
}

function shadowRow(x: ShadowEntry) {
  const p = x.prediction;
  const announced = x.announcedEnd ? `${x.qualifier === "at_least" ? "at least " : ""}${when(x.announcedEnd)}` : "none";
  // a placeholder model's prediction is not a forecast: never shown as one
  const predicted = x.placeholder ? "placeholder model, not shown" : p?.median ? `${when(p.median)}${p.low && p.high ? ` (${hm(p.low)}–${hm(p.high)})` : ""}` : x.planned ? "planned work, outside the model" : "no prediction";
  const actual = x.endedAt ? when(x.endedAt) : x.endSource === "offline" ? "ended while the twin was offline" : "still on";
  let result = "";
  if (x.score && !x.placeholder) {
    const parts = [x.score.inBand === null ? "" : x.score.inBand ? "inside the band" : "outside the band", x.score.errorMin !== null ? `off by ${Math.round(Math.abs(x.score.errorMin))}${NB}min` : ""];
    if (x.score.operatorErrorMin !== null) parts.push(`announcement off by ${Math.round(Math.abs(x.score.operatorErrorMin))}${NB}min`);
    result = parts.filter(Boolean).join(", ");
  }
  return { announced, predicted, actual, result };
}
function ShadowSection({ shadow }: { shadow?: ShadowResponse }) {
  if (!shadow) return <Empty>Waiting for the twin's shadow log.</Empty>;
  const total = shadow.open + shadow.scored + shadow.unscored;
  const sc = shadow.score;
  const horizons = sc ? Object.keys(sc.brier).sort((a, b) => Number(a) - Number(b)) : [];
  const max = sc ? Math.max(0, ...Object.values(sc.brier), ...Object.values(sc.operatorBrier ?? {})) : 0;
  // weeks of planned works carry no prediction: list the disruptions the model speaks about first
  const withPrediction = shadow.entries.filter((x) => !x.planned || x.prediction);
  const entries = [...withPrediction, ...shadow.entries.filter((x) => !withPrediction.includes(x))].slice(0, 8);
  const plannedOnly = shadow.entries.length - withPrediction.length;
  const covered = sc?.coverage ?? null;
  return (
    <>
      <p className="lead">
        The twin writes down its prediction the first time it sees a disruption (a real SBB alert or one registered in the twin) and scores it when service resumes: no hindsight, no retraining.
        {shadow.since ? ` Recording since ${when(shadow.since)}.` : ""}
      </p>
      <div className="tiles four">
        <TileView t={{ key: "n", label: "Disruptions predicted live", value: String(total), sub: `${shadow.open} still running`, placeholder: false, real: true }} />
        <TileView t={{ key: "s", label: "Ended and scored", value: String(shadow.scored), sub: shadow.unscored ? `${shadow.unscored} ended while the twin was offline, not scored` : "scored at the moment service resumed", placeholder: false, real: true }} />
        <TileView t={{ key: "c", label: "Actual end inside the 80 % band", value: covered === null ? "–" : pct(covered), sub: sc ? `of ${sc.n} scored` : "nothing scored yet", placeholder: false, real: true }} />
        <TileView
          t={{
            key: "e",
            label: "Median error of the end",
            value: sc?.medianAbsErrorMin == null ? "–" : `${Math.round(sc.medianAbsErrorMin)}`,
            unit: sc?.medianAbsErrorMin == null ? undefined : "min",
            sub: sc?.operatorMedianAbsErrorMin == null ? "predicted end vs the actual end" : `the announcement: ${Math.round(sc.operatorMedianAbsErrorMin)}${NB}min (${sc.operatorN} with an announced end)`,
            placeholder: false,
            real: true,
          }}
        />
      </div>
      {sc && sc.n > 0 && horizons.length > 0 ? (
        <div className="grid c3">
          {horizons.map((h) => {
            const rows: BarRow[] = [{ key: "model", label: series("model"), value: sc.brier[h], kind: "model" }];
            if (sc.operatorBrier?.[h] !== undefined) rows.push({ key: "operator", label: series("operator"), value: sc.operatorBrier[h], kind: "base" });
            return (
              <Panel key={h} title={`Still disrupted ${inH(Number(h))} after first seen?`} hint={`Live Brier score over ${sc.n} ended ${sc.n === 1 ? "disruption" : "disruptions"}, lower is better`}>
                <Bars rows={rows} format={brier} tickFormat={tick} max={max} title={`Live Brier at ${h} min`} />
              </Panel>
            );
          })}
        </div>
      ) : (
        <Empty>No disruption has ended since recording started, so there is no live score yet. The first one appears here when service resumes on a predicted disruption.</Empty>
      )}
      {(shadow.placeholderEntries > 0 || plannedOnly > 0) && (
        <p className="source">
          {shadow.placeholderEntries > 0 ? `${shadow.placeholderEntries} ${shadow.placeholderEntries === 1 ? "entry was" : "entries were"} recorded with a placeholder model: not shown as predictions and not counted in the score. ` : ""}
          {plannedOnly > 0 ? `${plannedOnly} planned ${plannedOnly === 1 ? "work is" : "works are"} recorded without a prediction (outside what the model was trained on).` : ""}
        </p>
      )}
      {entries.length > 0 && (
        <Panel title="Latest predictions" className="gap">
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Disruption</th>
                  <th>First seen</th>
                  <th>Announced end</th>
                  <th>Predicted end (80 % band)</th>
                  <th>Actual end</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((x) => {
                  const r = shadowRow(x);
                  return (
                    <tr key={x.id}>
                      <td>
                        {x.title}
                        <small>{[x.where && x.where !== x.title ? x.where : "", x.kind === "sbb" ? "SBB alert" : "registered in the twin", x.planned ? "planned work" : ""].filter(Boolean).join(" · ")}</small>
                      </td>
                      <td className="num">{when(x.firstSeenAt)}</td>
                      <td>{r.announced}</td>
                      <td>{r.predicted}</td>
                      <td>{r.actual}</td>
                      <td>{r.result}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

function Limits({ cards }: { cards?: ScorecardsResponse }) {
  const notes: { model: string; text: string; ph: boolean }[] = [];
  for (const k of ["duration", "post_resumption", "section_risk"] as const) {
    const e = cards?.[k];
    if (!usable(e)) continue;
    for (const n of e.scorecard.notes ?? []) notes.push({ model: MODEL_NAMES[k], text: n, ph: isPh(e) });
  }
  const ours = [
    "Forecasts are advice for staff and passengers. They never change the twin's effective timetable, the journey planner or a train's status, and an official cancellation always wins over a band.",
    "Real SBB alerts carry only a coarse cause code. The twin reads the cause from the alert's text when it can (\"This is due to ...\"); otherwise the cause group is \"other\".",
    "When an alert has no start time, the twin uses the moment it first saw it, so the elapsed time is underestimated for alerts that were on before the twin started.",
    "An SBB alert that disappears from the feed counts as resumed at the poll where it was missing (the feed is read every 3 minutes).",
    "The live shadow test holds a few disruptions a day; read its numbers as indicative until dozens have ended.",
  ];
  return (
    <ul className="limits">
      {notes.map((n, i) => (
        <li key={`n${i}`}>
          <b>
            {n.model}
            {n.ph ? " (placeholder)" : ""}:
          </b>{" "}
          {n.text}
        </li>
      ))}
      {ours.map((t, i) => (
        <li key={`o${i}`}>
          <b>Live use:</b> {t}
        </li>
      ))}
    </ul>
  );
}

const versionLabel = (v?: string) => {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return /^\d/.test(v) ? `v${v}` : v;
};
function Badges({ models, cards }: { models?: ForecastsResponse["models"]; cards?: ScorecardsResponse }) {
  const list = (["duration", "post_resumption", "section_risk"] as const).map((k) => {
    const m: Partial<ModelInfo> = models?.[k] ?? { source: cards?.[k]?.source };
    const source = m.source ?? "missing";
    return { k, name: MODEL_NAMES[k], version: source === "real" ? versionLabel(m.version) : "", source };
  });
  return (
    <div className="badges">
      {list.map((b) => (
        <span key={b.k} className={`badge ${b.source}`}>
          <i />
          <b>{b.name}</b>
          {b.version && <span>{b.version}</span>}
          <span>{b.source === "real" ? "trained" : b.source === "placeholder" ? "placeholder" : "not published"}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the page
export function Page() {
  const [pref, setPref] = useState<Pref>(readPref);
  const [theme, setTheme] = useState<Theme>(shownTheme);
  const [cards, setCards] = useState<ScorecardsResponse>();
  const [shadow, setShadow] = useState<ShadowResponse>();
  const [live, setLive] = useState<ForecastsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setTheme(resolveTheme(pref));
    if (pref === "system") return onSystemThemeChange(() => setTheme(systemTheme()));
  }, [pref]);
  useEffect(() => applyPageTheme(theme, switchMs()), [theme]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [c, s, f] = await Promise.all([
          get<ScorecardsResponse>("/api/forecasts/scorecards"),
          get<ShadowResponse>("/api/forecasts/shadow").catch(() => undefined),
          get<ForecastsResponse>("/api/forecasts").catch(() => undefined),
        ]);
        if (!alive) return;
        setCards(c);
        if (s) setShadow(s);
        if (f) setLive(f);
        setError(undefined);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const tiles = [coverageTile(cards?.duration), durationTile(cards?.duration), pointTile(cards?.duration), resumptionTile(cards?.post_resumption), riskTile(cards?.section_risk)].filter((t): t is Tile => t !== null);
  const heroAt = tiles.findIndex((t) => t.real && !t.placeholder);
  const ordered = heroAt >= 0 ? [tiles[heroAt], ...tiles.filter((_, i) => i !== heroAt)] : tiles;
  const shadowTotal = shadow ? shadow.open + shadow.scored + shadow.unscored : null;
  const tested = (["duration", "post_resumption", "section_risk"] as const).map((k) => live?.models[k]).find((m) => m?.source === "real" && m.testedOn && m.trainedOn);
  const fitted = tested?.trainedOn ? period(tested.trainedOn) : "March 2024 to December 2025";
  const testedOn = tested?.testedOn ? period(tested.testedOn) : "January to October 2026";
  const liveCount = live?.disruptions.length;

  return (
    <TipLayer>
      <div className="fcp">
        <Defs />
        <header className="bar">
          <div className="brand">
            <span className="mark">
              <TrainFront size={19} />
            </span>
            sbb-twin <span className="crumb">Forecasts</span>
          </div>
          <div className="top">
            <a className="back" href="/">
              <ArrowLeft size={15} />
              <span>Back to the console</span>
            </a>
            <div className="theme" role="group" aria-label="Colours">
              {([["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "Like the system"]] as const).map(([p, Icon, label]) => (
                <button key={p} aria-pressed={pref === p} title={label} aria-label={label} onClick={() => (savePref(p), setPref(p))}>
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>
        </header>
        <main className="page">
          <h1>How good are the forecasts?</h1>
          <p className="subtitle">
            Each model was fitted on data from {fitted} and tested once, out of time, on {testedOn}: disruptions it never saw. Every number comes from a script in research/ that anyone can re-run, and each comparison says whether its 95{NNB}% interval shows a real difference.
            {liveCount !== undefined ? ` Right now the twin is following ${liveCount} active ${liveCount === 1 ? "disruption" : "disruptions"}.` : ""}
          </p>
          <Badges models={live?.models} cards={cards} />
          {!cards && (error ? <Empty>The forecast service did not answer ({error}). Retrying every 30 seconds.</Empty> : <Empty>Loading the scorecards.</Empty>)}
          {cards && (
            <>
              <div className="tiles">
                {ordered.map((t, i) => (
                  <TileView key={t.key} t={t} hero={i === 0 && heroAt >= 0} />
                ))}
                <TileView t={{ key: "shadow", label: "Live shadow test: disruptions predicted by the twin since it started recording", value: shadowTotal === null ? "–" : String(shadowTotal), sub: shadow ? `${shadow.scored} ended and scored, ${shadow.open} still running` : "waiting for the shadow log", placeholder: false, real: true }} />
              </div>
              <section className="block" id="duration">
                <header>
                  <h2>How long will a disruption last?</h2>
                  <span className="meta">research/duration</span>
                </header>
                <DurationSection e={cards.duration} />
              </section>
              <section className="block" id="post-resumption">
                <header>
                  <h2>Which trains to check after "Service resumed"?</h2>
                  <span className="meta">research/post_resumption</span>
                </header>
                <ResumptionSection e={cards.post_resumption} />
              </section>
              <section className="block" id="section-risk">
                <header>
                  <h2>Where do disruptions concentrate?</h2>
                  <span className="meta">research/section_risk</span>
                </header>
                <RiskSection e={cards.section_risk} />
              </section>
              <section className="block" id="shadow">
                <header>
                  <h2>Live shadow test</h2>
                  <span className="meta">GET /api/forecasts/shadow</span>
                </header>
                <ShadowSection shadow={shadow} />
              </section>
              <section className="block" id="limits">
                <header>
                  <h2>Honest limits</h2>
                </header>
                <Limits cards={cards} />
              </section>
              <footer className="page-foot">
                {(["duration", "post_resumption", "section_risk"] as const).map((k) => {
                  const e = cards[k];
                  return (
                    <div key={k}>
                      {MODEL_NAMES[k]}: <code>{e.file}</code> · {e.source === "real" ? "trained model" : e.source === "placeholder" ? "placeholder, not a result" : "not published"}
                      {e.scorecard?.generatedAt ? ` · generated ${stamp(e.scorecard.generatedAt)}` : ""}
                    </div>
                  );
                })}
              </footer>
            </>
          )}
        </main>
      </div>
    </TipLayer>
  );
}
