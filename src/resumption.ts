// Post-resumption train risk (contract section 2, research/post_resumption). When a disruption ends ("Service
// resumed": a twin disruption resumes, or a real SBB alert on a section is withdrawn), the regular trains due at its
// named stations in the next hour are scored once: the historical chance that SBB's operating record still shows one
// of those stops cancelled, risk = sigmoid(a + b * leadMinutes / 60), shown as a band (cut on the raw risk) with the
// share of such trains that really lost a stop in the 2026 test (the model under-predicts the first quarter hour, so
// bands and observed shares are shown, not precise percentages).
// Advice for staff and the assistant only: it never changes the effective timetable or the planner, and an official
// cancellation or skipped stop (the effective timetable) always wins over it.
import type { ForecastTrain, Resumption } from "./contracts/forecasts.ts";
import { disruptions } from "./disruptions.ts";
import { dayTrips, liveTimes } from "./engine.ts";
import { stationIndex, stops, type Trip } from "./timetable.ts";
import { isScenario } from "./scenario.ts";
import { clear, publish } from "./mqtt.ts";
import { loaded } from "./forecastModels.ts";

const WINDOW_MS = 60 * 60_000; // trains whose first named stop is within the hour after the notice
const SPAN_MS = 120 * 60_000; // at most two hours between the two named stops
const LATE_MS = 2 * 60_000; // a backdated notice: trains that left before it was received are history, not forecast
const GRACE_MS = 5 * 60_000; // a forecast stays this long after its last train's last named stop
const REFRESH_MS = 10_000; // official status of the listed trains

type Row = { trip: Trip; at: number[] }; // the trip and the indexes of its named stops, in time order
const held = new Map<string, { forecast: Resumption; rows: Row[] }>();
const scored = new Set<string>(); // disruptions already scored: once, when the resumption is received
let lastRefresh = 0;
const topicOf = (id: string) => `forecasts/post-resumption/${id}`;
const place = (k: number) => ({ id: stops[k].id, name: stops[k].name });
const plannedAt = (trip: Trip, i: number) => (i === 0 ? trip.dep[i] : trip.arr[i]); // planned arrival, else departure

function model() {
  const m = loaded("resumption");
  if (!m.data) return undefined;
  // observed share per band in the forward test (scorecard calibrationByBand), when the scorecard has it
  const card = loaded("resumptionCard").data;
  const observed = new Map((card?.calibrationByBand ?? []).map((b) => [b.bin, b.observed]));
  const bands = [...m.data.bands].sort((x, y) => y.min - x.min).map((b) => ({ label: b.label, min: b.min, observed: observed.get(b.label) ?? null }));
  return { ...m.data, bands, placeholder: m.source !== "real" };
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

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

export type Subject = { id: string; kind: "sbb" | "twin"; where: string; ends: string[]; resumedAt: number };
function issue(s: Subject, t: number): { forecast: Resumption; rows: Row[] } | undefined {
  const m = model();
  if (!m) return undefined;
  const ends = [...new Set(s.ends)].map(stationIndex).filter((k): k is number => k !== undefined);
  const rows = roster(ends, s.resumedAt, Math.max(s.resumedAt, t - LATE_MS));
  const bandOf = (risk: number) => m.bands.find((b) => risk >= b.min) ?? m.bands[m.bands.length - 1];
  const trains = rows.map((r): ForecastTrain => {
    const first = plannedAt(r.trip, r.at[0]);
    const risk = sigmoid(m.a + (m.b * (first - s.resumedAt)) / 60_000 / 60);
    const band = bandOf(risk); // on the raw risk, as the contract says (24.6 % is "check", not "check first")
    return {
      trainId: r.trip.trainId,
      line: r.trip.line,
      category: r.trip.cat,
      headsign: r.trip.head,
      station: place(r.trip.stops[r.at[0]]),
      plannedTime: first,
      leadMinutes: Math.round(((first - s.resumedAt) / 60_000) * 10) / 10,
      calls: r.at.map((i) => ({ station: place(r.trip.stops[i]), plannedTime: plannedAt(r.trip, i) })),
      risk: Math.round(risk * 1000) / 1000,
      band: band.label,
      bandObserved: band.observed,
      officialStatus: officialStatus(r, t),
    };
  });
  const forecast: Resumption = {
    v: 1,
    kind: s.kind,
    disruptionId: s.id,
    where: s.where,
    resumedAt: s.resumedAt,
    issuedAt: t,
    updatedAt: t,
    expiresAt: expiry(rows, s.resumedAt, t),
    endpoints: ends.map(place),
    windowMinutes: WINDOW_MS / 60_000,
    modelVersion: m.version,
    placeholder: m.placeholder,
    formula: "risk = 1 / (1 + exp(-(a + b * leadMinutes / 60)))",
    coefficients: { a: m.a, b: m.b },
    bands: m.bands,
    trains,
    note: "Historical risk that a train due soon after a resumption still loses one of these stops in SBB's records. Advice to check the train, never a cancellation: an official cancellation always wins.",
  };
  return { forecast, rows };
}

/** Score a resumption once (a twin disruption that resumed, a real alert withdrawn). */
export function resumed(s: Subject, t = Date.now()) {
  if (scored.has(s.id)) return;
  scored.add(s.id);
  if (t - s.resumedAt >= WINDOW_MS) return; // restored after the hour was over: nothing left to forecast
  const h = issue(s, t);
  if (!h) return;
  held.set(s.id, h);
  publish(topicOf(s.id), h.forecast, { retain: true, qos: 1 });
  console.log(`[forecast] ${s.where} resumed: ${h.forecast.trains.length} trains to check`);
}

/** Every tick: score a twin disruption once when it resumes; refresh the official status of listed trains; expire. */
export function resumptionTick(t = Date.now()) {
  for (const d of disruptions.values()) {
    if (!isScenario(d) || scored.has(d.id)) continue;
    const at = d.scenario.resumedAt;
    if (at === undefined || at > t) continue;
    resumed({ id: d.id, kind: "twin", where: d.where, ends: [d.scenario.a, d.scenario.b].filter((x): x is string => Boolean(x)), resumedAt: at }, t);
  }
  if (t - lastRefresh < REFRESH_MS) return;
  lastRefresh = t;
  for (const [id, h] of [...held]) {
    const f = h.forecast;
    if (t >= f.expiresAt) {
      dropResumption(id);
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

export const resumptions = () => [...held.values()].map((h) => h.forecast).sort((x, y) => y.resumedAt - x.resumedAt);
export const resumptionOf = (disruptionId: string) => held.get(disruptionId)?.forecast;
/** Resumptions whose named stations include one of these station ids (the passenger brief for a place). */
export const resumptionsAt = (ids: Set<string>) => resumptions().filter((f) => f.endpoints.some((e) => ids.has(e.id)));
/** Withdraw one forecast (its disruption was deleted) or all of them (back to reality). */
export function dropResumption(disruptionId: string) {
  if (held.delete(disruptionId)) clear(topicOf(disruptionId));
}
export function dropAllResumptions() {
  for (const id of [...held.keys()]) dropResumption(id);
}
