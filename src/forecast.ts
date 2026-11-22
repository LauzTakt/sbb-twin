// Post-resumption train risk. When a disruption ends ("Service resumed", by POST /disruptions/{id}/end or at its
// announced end), the regular trains due at its named stations in the next hour are scored once: the historical chance
// that SBB's operating record still shows one of those stops cancelled. The model and its two forward-year tests are in
// research/post_resumption (README.md, scorecard.json).
// A forecast is advice for staff and the assistant. It never changes the effective timetable or the planner, and an
// official cancellation or skipped stop (the effective timetable) always wins over it.
import { disruptions, type Disruption, type Scenario } from "./disruptions.ts";
import { dayTrips, liveTimes } from "./engine.ts";
import { stationIndex, stops, type Trip } from "./timetable.ts";
import { isScenario } from "./scenario.ts";
import { clear, publish } from "./mqtt.ts";

/** The frozen fit of the 2026 fold: risk = sigmoid(a + b * leadMinutes / 60). */
export const MODEL = {
  version: "post-resumption-risk/1",
  formula: "risk = 1 / (1 + exp(-(a + b * leadMinutes / 60)))",
  coefficients: { a: -0.962943, b: -1.635479 },
  source:
    "research/post_resumption/scorecard.json, fold 2024-25 -> 2026: fit on 1,997 train runs after 2024-25 VIA resumptions; " +
    "on 769 runs after Jan-Oct 2026 resumptions its Brier score was 0.15615 against 0.16492 for the historical rate",
};
/** Observed share of runs with a cancelled named stop, by quarter hour after the notice (2024-03..2026-10, 2,766 runs). */
export const HISTORY = [
  { minutes: "0-15", runs: 711, cancelled: 213 },
  { minutes: "15-30", runs: 699, cancelled: 103 },
  { minutes: "30-45", runs: 693, cancelled: 75 },
  { minutes: "45-60", runs: 663, cancelled: 75 },
].map((q) => ({ ...q, share: Math.round((q.cancelled / q.runs) * 1000) / 1000 }));
const WINDOW_MS = 60 * 60_000; // trains whose first named stop is within the hour after the notice
const SPAN_MS = 120 * 60_000; // at most two hours between the two named stops
const LATE_MS = 2 * 60_000; // a backdated notice: trains that left before it was received are history, not forecast
const GRACE_MS = 5 * 60_000; // a forecast stays this long after its last train's last named stop
const REFRESH_MS = 10_000; // official status of the listed trains

export type Band = "check first" | "check" | "low";
export const bandOf = (percent: number): Band => (percent >= 25 ? "check first" : percent >= 12 ? "check" : "low");
type Place = { id: string; name: string };
export type ForecastTrain = {
  trainId: string;
  line: string;
  category: string;
  headsign: string;
  station: Place; // its first named stop after the notice
  plannedTime: number;
  leadMinutes: number;
  calls: { station: Place; plannedTime: number }[]; // every named stop of this run
  risk: number;
  riskPercent: number;
  band: Band;
  officialStatus: "scheduled" | "cancelled" | "skipped"; // the effective timetable now: an official change wins
};
export type Forecast = {
  v: 1;
  kind: "post-resumption";
  disruptionId: string;
  where: string;
  resumedAt: number;
  issuedAt: number;
  updatedAt: number;
  expiresAt: number;
  endpoints: Place[];
  windowMinutes: number;
  modelVersion: string;
  formula: string;
  coefficients: { a: number; b: number };
  coefficientsSource: string;
  history: typeof HISTORY;
  trains: ForecastTrain[];
  note: string;
};

type Row = { trip: Trip; at: number[] }; // the trip and the indexes of its named stops, in time order
const held = new Map<string, { forecast: Forecast; rows: Row[] }>();
const scored = new Set<string>(); // disruptions already scored: once, when the resumption is received
let lastRefresh = 0;
const topicOf = (id: string) => `forecasts/post-resumption/${id}`;
const place = (k: number): Place => ({ id: stops[k].id, name: stops[k].name });
const plannedAt = (trip: Trip, i: number) => (i === 0 ? trip.dep[i] : trip.arr[i]); // planned arrival, else departure
export const riskAt = (leadMinutes: number) => 1 / (1 + Math.exp(-(MODEL.coefficients.a + (MODEL.coefficients.b * leadMinutes) / 60)));

/** Regular trains (no replacement buses, no extra trains) calling once at every named station, with the first of those
 *  stops in [from, resumedAt + 1 h) and at most 2 h between them. */
function roster(ends: number[], resumedAt: number, from: number): Row[] {
  const rows: (Row & { first: number })[] = [];
  if (!ends.length) return [];
  const until = resumedAt + WINDOW_MS;
  for (const trip of dayTrips()) {
    if (trip.cat === "EV" || trip.cat === "EXT") continue;
    const n = trip.stops.length;
    if (trip.dep[0] >= until || trip.arr[n - 1] < from) continue;
    const at: number[] = [];
    for (const k of ends) {
      let found = -1;
      let count = 0;
      for (let i = 0; i < n; i++) if (trip.stops[i] === k) (found = i), count++;
      if (count !== 1) break;
      at.push(found);
    }
    if (at.length !== ends.length) continue;
    at.sort((x, y) => x - y);
    const first = plannedAt(trip, at[0]);
    if (plannedAt(trip, at[at.length - 1]) - first > SPAN_MS || first < from || first >= until) continue;
    rows.push({ trip, at, first });
  }
  return rows.sort((x, y) => x.first - y.first).map(({ trip, at }) => ({ trip, at }));
}

/** The effective timetable now for those stops: cancelled (a short turn, a cancelled line or trip), skipped, or scheduled. */
function officialStatus(r: Row, t: number): ForecastTrain["officialStatus"] {
  const lt = liveTimes(r.trip, t);
  if (lt.cancelled || r.at.some((i) => i > lt.lastServed || i < lt.firstServed)) return "cancelled";
  if (r.at.some((i) => lt.skipped[i])) return "skipped";
  return "scheduled";
}
/** After the last train's last named stop (its live time when it runs late), plus a few minutes. */
function expiry(rows: Row[], resumedAt: number, t: number) {
  let last = resumedAt + WINDOW_MS;
  for (const r of rows) {
    const i = r.at[r.at.length - 1];
    const lt = liveTimes(r.trip, t);
    last = Math.max(last, plannedAt(r.trip, i), i === 0 ? lt.dep[i] : lt.arr[i]);
  }
  return Math.round(last + GRACE_MS);
}

function issue(d: Disruption & { scenario: Scenario }, resumedAt: number, t: number): { forecast: Forecast; rows: Row[] } {
  const sc = d.scenario;
  const ends = [...new Set([sc.a, sc.b].filter((x): x is string => Boolean(x)))].map(stationIndex).filter((k): k is number => k !== undefined);
  const rows = roster(ends, resumedAt, Math.max(resumedAt, t - LATE_MS));
  const trains = rows.map((r): ForecastTrain => {
    const first = plannedAt(r.trip, r.at[0]);
    const leadMinutes = Math.round(((first - resumedAt) / 60_000) * 10) / 10;
    const risk = riskAt((first - resumedAt) / 60_000);
    const riskPercent = Math.round(risk * 100);
    return {
      trainId: r.trip.trainId,
      line: r.trip.line,
      category: r.trip.cat,
      headsign: r.trip.head,
      station: place(r.trip.stops[r.at[0]]),
      plannedTime: first,
      leadMinutes,
      calls: r.at.map((i) => ({ station: place(r.trip.stops[i]), plannedTime: plannedAt(r.trip, i) })),
      risk: Math.round(risk * 1000) / 1000,
      riskPercent,
      band: bandOf(riskPercent),
      officialStatus: officialStatus(r, t),
    };
  });
  const forecast: Forecast = {
    v: 1,
    kind: "post-resumption",
    disruptionId: d.id,
    where: d.where,
    resumedAt,
    issuedAt: t,
    updatedAt: t,
    expiresAt: expiry(rows, resumedAt, t),
    endpoints: ends.map(place),
    windowMinutes: WINDOW_MS / 60_000,
    modelVersion: MODEL.version,
    formula: MODEL.formula,
    coefficients: MODEL.coefficients,
    coefficientsSource: MODEL.source,
    history: HISTORY,
    trains,
    note: "Historical risk that a train due soon after a resumption still loses one of these stops in SBB's records. Advice to check the train, never a cancellation: an official cancellation always wins.",
  };
  return { forecast, rows };
}

/** Every tick: score a disruption once when it resumes; refresh the official status of listed trains; expire. */
export function forecastTick(t = Date.now()) {
  for (const d of disruptions.values()) {
    if (!isScenario(d) || scored.has(d.id)) continue;
    const resumedAt = d.scenario.resumedAt;
    if (resumedAt === undefined || resumedAt > t) continue;
    scored.add(d.id);
    if (t - resumedAt >= WINDOW_MS) continue; // restored after the hour was over: nothing left to forecast
    const h = issue(d, resumedAt, t);
    held.set(d.id, h);
    publish(topicOf(d.id), h.forecast, { retain: true, qos: 1 });
    console.log(`[forecast] ${d.where} resumed: ${h.forecast.trains.length} trains to check`);
  }
  if (t - lastRefresh < REFRESH_MS) return;
  lastRefresh = t;
  for (const [id, h] of [...held]) {
    const f = h.forecast;
    if (t >= f.expiresAt) {
      dropForecast(id);
      continue;
    }
    let changed = false;
    h.rows.forEach((r, i) => {
      const s = officialStatus(r, t);
      if (s !== f.trains[i].officialStatus) (f.trains[i] = { ...f.trains[i], officialStatus: s }), (changed = true);
    });
    const exp = expiry(h.rows, f.resumedAt, t);
    if (Math.abs(exp - f.expiresAt) >= 60_000) (f.expiresAt = exp), (changed = true);
    if (changed) {
      h.forecast = { ...f, updatedAt: t };
      publish(topicOf(id), h.forecast, { retain: true, qos: 1 });
    }
  }
}

export const forecastList = () => [...held.values()].map((h) => h.forecast).sort((x, y) => y.resumedAt - x.resumedAt);
export const forecastOf = (disruptionId: string) => held.get(disruptionId)?.forecast;
/** Forecasts whose named stations include one of these station ids (the passenger brief for a place). */
export const forecastsAt = (ids: Set<string>) => forecastList().filter((f) => f.endpoints.some((e) => ids.has(e.id)));
/** Withdraw one forecast (its disruption was deleted) or all of them (back to reality). */
export function dropForecast(disruptionId: string) {
  if (held.delete(disruptionId)) clear(topicOf(disruptionId));
}
export function dropAllForecasts() {
  for (const id of [...held.keys()]) dropForecast(id);
}
