// Scenario disruptions: we create a disruption (a cause on a section or station, an effect state that evolves) and the
// control centre's decisions on it (measures, each with its own effective time). Everything else follows from that
// record, deterministically:
//   - the engine's physics (interrupted: no train traverses the section's tracks; limited: slow running on them),
//   - the effective timetable (src/disruptions.ts tripChanges: short turns with cancelled onward calls, holds with
//     their forecast departure, cancelled lines and trains), read by step(), liveTimes(), boards, train info and the
//     journey planner,
//   - replacement buses (EV) as real trips in the effective timetable,
//   - the public bulletin (a new version on every change) and the public incident.
import { createHash, randomUUID } from "node:crypto";
import { CAUSES, causeOf, MEASURES, proposal, type DurationType, type EffectState, type MeasureType } from "./catalogue.ts";
import { disruptions, effective, incidents, InputError, tripChanges, type Bulletin, type BulletinMessage, type Disruption, type Incident, type Measure, type Scenario, type TripChange } from "./disruptions.ts";
import { dayTrips, liveTimes, removeExtraTrips, setExtraTrips, timetableDate, trains } from "./engine.ts";
import { stationIndex, stops, type Trip } from "./timetable.ts";
import { edgeSpans, edgesGeometry, edgesWithin, metres, pathBetween, sectionEdges } from "./geometry.ts";
import { clear, publish } from "./mqtt.ts";
import { aiEnabled, writeBulletin, type BulletinFacts, type Lang } from "./bulletinAI.ts";
import { config } from "./config.ts";
import { serviceOrigin, zurich } from "./time.ts";

const HOLD_MAX_MIN = 20;
const BUS_HORIZON_MS = 2 * 3600_000; // unknown end: buses are scheduled two hours ahead, rolling
const name = (id: string) => stops[stationIndex(id) ?? -1]?.name ?? id;
const hhmm = (ms: number) => zurich(ms).time.slice(0, 5);
const fraction = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 2 ** 32;
export const isScenario = (d: Disruption): d is Disruption & { scenario: Scenario } => Boolean(d.scenario);
const scenarios = () => [...disruptions.values()].filter(isScenario);

// ---------------------------------------------------------------- input helpers
/** Epoch ms from a number (epoch ms), "HH:MM" (today, Swiss time) or nothing (fallback). */
export function parseTime(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const date = timetableDate() || zurich(Date.now()).date;
      return serviceOrigin(date) + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
    }
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
    throw new InputError(`Not a time: "${v}" (epoch ms, HH:MM or ISO)`);
  }
  return fallback;
}
const durationTypeOf = (v: unknown, fallback: DurationType): DurationType => {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).toUpperCase();
  if (s === "UNTIL") return "UNTIL";
  if (s === "AT_LEAST" || s === "UNTIL_AT_LEAST") return "UNTIL_AT_LEAST";
  if (s === "UNKNOWN" || s === "NONE") return "UNKNOWN";
  throw new InputError(`durationType must be UNTIL, UNTIL_AT_LEAST or UNKNOWN`);
};

// ---------------------------------------------------------------- where: the section's tracks and stations
/** Every way trains run between A and B today (the legs between their calls at A and B, parallel alignments
 *  included): the tracks closed, the stations inside, and the stopping pattern for a replacement bus. */
function resolveSection(a: number, b: number) {
  const segs: { seq: number[]; len: number }[] = [];
  const seen = new Set<string>();
  for (const trip of dayTrips()) {
    if (trip.cat === "EV") continue;
    const s = Array.from(trip.stops);
    const i = s.indexOf(a);
    const j = s.indexOf(b);
    if (i < 0 || j < 0 || Math.abs(i - j) > 12) continue;
    const seq = i < j ? s.slice(i, j + 1) : s.slice(j, i + 1).reverse();
    const key = seq.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    let len = 0;
    for (let k = 0; k < seq.length - 1; k++) len += pathBetween(stops[seq[k]], stops[seq[k + 1]]).len;
    segs.push({ seq, len });
  }
  const edges = sectionEdges(stops[a], stops[b]);
  if (!segs.length) {
    if (!edges.size) throw new InputError("No trains run between these stations today and no track joins them");
    return { edges, inside: [] as number[], busStops: [a, b] };
  }
  const min = Math.min(...segs.map((x) => x.len));
  const ok = segs.filter((x) => x.len <= 1.6 * min + 2000);
  const inside = new Set<number>();
  for (const { seq } of ok) {
    for (let k = 0; k < seq.length - 1; k++) for (const sp of edgeSpans(pathBetween(stops[seq[k]], stops[seq[k + 1]]))) if (sp.ref) edges.add(Math.abs(sp.ref));
    for (const x of seq.slice(1, -1)) inside.add(x);
  }
  const busStops = ok.reduce((best, x) => (x.seq.length > best.seq.length ? x : best), ok[0]).seq;
  return { edges, inside: [...inside], busStops };
}

// Does the leg between two consecutive calls run on the disruption's tracks (or touch a station inside it)?
const hitMemo = new Map<string, Map<string, boolean>>();
function hits(d: Disruption & { scenario: Scenario }, s1: number, s2: number) {
  let memo = hitMemo.get(d.id);
  if (!memo) hitMemo.set(d.id, (memo = new Map()));
  const key = `${s1}>${s2}`;
  let h = memo.get(key);
  if (h === undefined) {
    const sc = d.scenario;
    const ids = [stops[s1].id, stops[s2].id];
    h = ids.some((id) => sc.inside.includes(id)) || (sc.b === undefined && ids.includes(sc.a)) || edgeSpans(pathBetween(stops[s1], stops[s2])).some((sp) => sp.ref !== 0 && d.edges.has(Math.abs(sp.ref)));
    memo.set(key, h);
  }
  return h;
}

const catRank = (line: string) => {
  const c = line.match(/^[A-Z]+/)?.[0] ?? "";
  return ["EC", "ICE", "TGV", "RJX", "NJ", "EN"].includes(c) ? 0 : ["IC", "ICN"].includes(c) ? 1 : ["IR", "IRE", "IRN"].includes(c) ? 2 : c === "RE" ? 3 : c === "R" ? 4 : ["S", "SN"].includes(c) ? 5 : 6;
};
const byLine = (a: string, b: string) => catRank(a) - catRank(b) || a.localeCompare(b, "en", { numeric: true });
/** The lines of today's trains that run through the disruption. */
function linesThrough(d: Disruption & { scenario: Scenario }) {
  const out = new Set<string>();
  for (const trip of dayTrips()) {
    if (trip.cat === "EV" || out.has(trip.line)) continue;
    for (let k = 0; k < trip.stops.length - 1; k++)
      if (hits(d, trip.stops[k], trip.stops[k + 1])) {
        out.add(trip.line);
        break;
      }
  }
  const named = [...out].filter((l) => /\d/.test(l));
  return (named.length ? named : [...out]).sort(byLine);
}

// ---------------------------------------------------------------- state over time
type StateAt = { state: EffectState | "resumed"; until: number | null; durationType: DurationType; kmh: number; cancelShare: number; at: number };
/** The disruption at time `at` as decided now: its effect, expected end, and the one-track settings. */
export function stateAt(d: Disruption & { scenario: Scenario }, at: number, now = Date.now()): StateAt {
  const sc = d.scenario;
  const out: StateAt = { state: sc.initial, until: sc.until, durationType: sc.durationType, kmh: 40, cancelShare: 0, at };
  if (sc.resumedAt !== undefined && at >= sc.resumedAt) return { ...out, state: "resumed" };
  for (const m of [...sc.measures].sort((x, y) => x.at - y.at)) {
    if (m.announcedAt > now || m.at > at) continue;
    if (m.type === "partial_resumption") {
      out.state = "limited";
      if (m.params.kmh !== undefined) out.kmh = Number(m.params.kmh) || 40;
    }
    else if (m.type === "interruption") out.state = "interrupted";
    else if (m.type === "one_track_open") {
      out.state = "limited";
      out.kmh = Number(m.params.kmh ?? 40) || 40;
      out.cancelShare = Math.max(0, Math.min(1, Number(m.params.cancelShare ?? 0.5)));
    } else if (m.type === "prognosis") {
      out.until = (m.params.until as number | null) ?? null;
      out.durationType = m.params.durationType as DurationType;
    } else if (m.type === "resume") return { ...out, state: "resumed" };
  }
  if (out.until !== null && at >= out.until) out.state = "resumed"; // the announced end is reached
  return out;
}
/** When service is expected back (the announced end, or a scheduled resume), null when unknown. */
export function expectedEnd(d: Disruption & { scenario: Scenario }, now = Date.now()) {
  const st = stateAt(d, now, now);
  let end = st.until;
  for (const m of d.scenario.measures) if (m.type === "resume" && m.announcedAt <= now && m.at >= now) end = end === null ? m.at : Math.min(end, m.at);
  return end;
}
const announced = (d: Disruption & { scenario: Scenario }, type: MeasureType, now: number) => d.scenario.measures.filter((m) => m.type === type && m.announcedAt <= now);
const sideOf = (sc: Scenario, k: number) => {
  if (sc.b === undefined) return "A";
  const a = stops[stationIndex(sc.a)!];
  const b = stops[stationIndex(sc.b)!];
  const s = stops[k];
  return metres(s.lon, s.lat, a.lon, a.lat) <= metres(s.lon, s.lat, b.lon, b.lat) ? "A" : "B";
};

// ---------------------------------------------------------------- the effective timetable
let lastRecompute = 0;
// trips that run through a disruption, with their first leg on it (the timetable only changes when buses are added)
const touching = new Map<string, { trips: Trip[]; list: { trip: Trip; first: number }[] }>();
function candidates(d: Disruption & { scenario: Scenario }, trips: Trip[]) {
  const hit = touching.get(d.id);
  if (hit && hit.trips === trips) return hit.list;
  const list: { trip: Trip; first: number }[] = [];
  for (const trip of trips) {
    if (trip.cat === "EV") continue;
    for (let k = 0; k < trip.stops.length - 1; k++)
      if (hits(d, trip.stops[k], trip.stops[k + 1])) {
        list.push({ trip, first: k });
        break;
      }
  }
  touching.set(d.id, { trips, list });
  return list;
}
/** Rebuild every trip change from the scenario disruptions (committed short turns stay as they are). */
export function recompute(t = Date.now()) {
  const t0 = performance.now();
  lastRecompute = t;
  effective.generation++;
  tripChanges.clear();
  const all = scenarios();
  for (const d of all) {
    for (const [key, cut] of Object.entries(d.scenario.committed)) tripChanges.set(key, { by: d.id, cut, reason: "short_turn", committed: true });
    for (const [key, startAt] of Object.entries(d.scenario.committedStart ?? {})) tripChanges.set(key, { by: d.id, startAt, reason: "short_turn", committed: true });
  }
  const trips = dayTrips();
  for (const d of all) {
    if (d.endedAt) continue;
    const sc = d.scenario;
    const end = expectedEnd(d, t);
    const horizon = t + 6 * 3600_000;
    for (const { trip, first } of candidates(d, trips)) {
      if (tripChanges.has(trip.key)) continue;
      const n = trip.stops.length;
      if (trip.arr[n - 1] < t - 3600_000 || trip.dep[0] > horizon) continue;
      const lt = liveTimes(trip, t);
      if (lt.cancelled) continue;
      const tr = lt.train;
      if (tr && tr.leg >= 0 && hits(d, trip.stops[tr.leg], trip.stops[tr.leg + 1])) continue; // inside: it stops on the line
      let k = -1;
      for (let i = Math.max(first, lt.from); i < n - 1; i++)
        if (hits(d, trip.stops[i], trip.stops[i + 1])) {
          k = i;
          break;
        }
      if (k < 0) continue; // already through
      const atStation = Boolean(tr && tr.leg < 0 && tr.call === k);
      const D = Math.max(lt.dep[k], t);
      if (!atStation && lt.dep[k] < sc.start - 60_000) continue; // it passes before the disruption starts
      const st = stateAt(d, D, t);
      if (st.state === "resumed") continue; // it gets there after service resumed
      const from = (m: Measure) => D >= m.at && (m.withdrawAt === undefined || D < m.withdrawAt);
      const side = sideOf(sc, trip.stops[k]);
      // a cut at its origin: when it continues beyond the section, it starts there instead (the unit that turned back)
      const notStarted = !tr || (tr.leg < 0 && Number.isNaN(tr.actDep[tr.call]) && tr.call === 0);
      let after = k;
      while (after < n - 1 && hits(d, trip.stops[after], trip.stops[after + 1])) after++;
      const cutAt = (reason: TripChange["reason"]) => tripChanges.set(trip.key, k === 0 && notStarted && after < n - 1 ? { by: d.id, startAt: after, reason } : { by: d.id, cut: k, reason });
      const cancelled = announced(d, "cancel_lines", t).some((m) => from(m) && ((m.params.lines as string[]) ?? []).includes(trip.line));
      if (cancelled) {
        cutAt("cancel_lines");
        continue;
      }
      if (st.state === "interrupted") {
        const wait = end === null ? Infinity : end - D;
        const hold = announced(d, "hold", t).filter(from).at(-1);
        const maxWait = Number(hold?.params.maxWaitMin ?? HOLD_MAX_MIN) * 60_000;
        const turn = announced(d, "short_turn", t).some((m) => from(m) && (m.params.at === undefined || m.params.at === "both" || m.params.at === side));
        if (turn && wait > maxWait) cutAt("short_turn");
        else tripChanges.set(trip.key, { by: d.id, holdAt: k, holdUntil: end ?? undefined, reason: "hold" });
      } else if (st.cancelShare > 0 && fraction(trip.trainId) < st.cancelShare) cutAt("one_track_open");
    }
  }
  const ms = performance.now() - t0;
  if (ms > Number(process.env.SCENARIO_WARN_MS ?? 150)) console.warn(`[scenario] effective timetable took ${Math.round(ms)} ms`);
}

// ---------------------------------------------------------------- replacement buses
function busTimes(seq: number[]) {
  // road distance = straight line x 1.3, at 50 km/h on average (at least 1 minute per hop); 1 minute at each stop
  return seq.slice(1).map((s, k) => Math.max(60, Math.round((metres(stops[seq[k]].lon, stops[seq[k]].lat, stops[s].lon, stops[s].lat) * 1.3) / (50 / 3.6) / 30) * 30) * 1000);
}
/** Straight distance between the section ends, km. */
export const sectionKm = (sc: Scenario) => {
  const a = stops[stationIndex(sc.a) ?? -1];
  const b = stops[stationIndex(sc.b ?? "") ?? -1];
  return a && b ? metres(a.lon, a.lat, b.lon, b.lat) / 1000 : 0;
};
const BUS_MAX_KM = 40; // real replacement buses bridge short gaps between neighbouring stations
const busWarning = (km: number) => `Section of ${Math.round(km)} km: a replacement bus would not cover this in real operations`;
function departures(m: Measure, side: "A" | "B", from: number, until: number) {
  const out: number[] = [];
  const pattern = (side === "A" ? m.params.minutesA : m.params.minutesB) as number[] | undefined;
  if (Array.isArray(pattern) && pattern.length) {
    const hour = Math.floor(from / 3600_000) * 3600_000;
    for (let h = hour; h < until; h += 3600_000) for (const mm of [...pattern].sort((x, y) => x - y)) {
      const x = h + mm * 60_000;
      if (x >= from && x < until) out.push(x);
    }
    // whole hours in UTC equal whole hours in Swiss time (offsets are whole hours)
  } else {
    const every = Math.max(5, Number(m.params.everyMin ?? 15)) * 60_000;
    const first = Math.ceil((m.at + Math.max(0, Number(m.params.firstInMin ?? 15)) * 60_000) / 60_000) * 60_000;
    for (let x = first; x < until; x += every) if (x >= from) out.push(x);
  }
  return out;
}
function makeBus(d: Disruption, m: Measure, seq: number[], side: "A" | "B", dep0: number): Trip {
  const hops = busTimes(seq);
  const n = seq.length;
  const arr = new Float64Array(n);
  const dep = new Float64Array(n);
  let x = dep0;
  arr[0] = dep[0] = x;
  for (let k = 1; k < n; k++) {
    x += hops[k - 1];
    arr[k] = x;
    dep[k] = k < n - 1 ? (x += 60_000) : x;
  }
  const serviceDate = (timetableDate() || zurich(dep0).date).replaceAll("-", "");
  const tag = `${d.id.slice(2)}-${m.id.slice(2)}-${side}${hhmm(dep0).replace(":", "")}`;
  return { key: `${serviceDate}/EV-${tag}`, trainId: `${serviceDate}_EV-${tag}`, tripId: `EV-${tag}`, serviceDate, cat: "EV", line: "EV", head: stops[seq[n - 1]].name, stops: Int32Array.from(seq), arr, dep };
}
const busTrips = new Map<string, Trip[]>(); // disruption id -> its buses
/** The disruption's replacement buses: departures from each decision until withdrawal or reopening (rolling when the
 *  end is unknown). Buses that already left stay; future ones follow the latest decisions. */
function refreshBuses(d: Disruption & { scenario: Scenario }, t: number) {
  const sc = d.scenario;
  const seq = sc.busStops.map((id) => stationIndex(id)).filter((x): x is number => x !== undefined);
  const prev = busTrips.get(d.id) ?? [];
  const keep = prev.filter((trip) => trip.dep[0] <= t || trains.has(trip.key));
  const keys = new Set(keep.map((trip) => trip.key));
  const next = [...keep];
  if (!d.endedAt && seq.length >= 2) {
    const end = expectedEnd(d, t);
    for (const m of announced(d, "replacement_bus", t)) {
      if (m.params.sought || m.params.blocked) continue; // still being organised, or a section too long for a bus
      const until = Math.min(m.withdrawAt ?? Infinity, end ?? t + BUS_HORIZON_MS, t + 6 * 3600_000);
      for (const side of ["A", "B"] as const) {
        const route = side === "A" ? seq : [...seq].reverse();
        for (const x of departures(m, side, Math.max(t, m.at), until)) {
          const trip = makeBus(d, m, route, side, x);
          if (keys.has(trip.key)) continue;
          keys.add(trip.key);
          next.push(trip);
        }
      }
    }
  }
  next.sort((x, y) => x.dep[0] - y.dep[0]);
  busTrips.set(d.id, next);
  setExtraTrips(d.id, next);
}
/** First departures of a bus decision from each end (for the bulletin). */
/** First departures of a bus decision from each end, as they are in the effective timetable (for the bulletin). */
function firstBuses(d: Disruption & { scenario: Scenario }, m: Measure) {
  const tag = `-${m.id.slice(2)}-`;
  const mine = (busTrips.get(d.id) ?? []).filter((trip) => trip.key.includes(tag));
  const from = (id: string) => mine.filter((trip) => stops[trip.stops[0]].id === id).map((trip) => trip.dep[0]).sort((x, y) => x - y);
  return { A: from(d.scenario.a), B: from(d.scenario.b ?? "") };
}

// ---------------------------------------------------------------- bulletins
const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const T = {
  en: {
    title: (state: EffectState | "resumed", place: string) => `${state === "resumed" ? "Service resumed" : state === "interrupted" ? "Interrupted service" : "Limited service"}: ${place}`,
    where: (a: string, b?: string) => (b ? `between ${a} and ${b}` : `at ${a}`),
    head: (state: EffectState, where: string) => `${state === "interrupted" ? "Interrupted" : "Limited"} train service ${where}.`,
    cause: (clause: string) => `This is due to ${clause}.`,
    duration: (type: DurationType, until: number | null) => (until === null || type === "UNKNOWN" ? "The duration of the restriction is not known." : type === "UNTIL" ? `The restriction lasts until approx. ${hhmm(until)}.` : `The restriction lasts at least until ${hhmm(until)}.`),
    lines: (lines: string[]) => (lines.length ? (lines.length === 1 ? `Line ${lines[0]} is affected.` : `Lines ${joinAnd(lines)} are affected.`) : null),
    allow: "Allow for delays and cancellations.",
    none: "No trains are running.",
    oneTrack: (kmh: number) => `Trains run on one track at reduced speed (${kmh} km/h).`,
    bus: (where: string) => `Passengers travelling ${where} should use the replacement bus service (EV).`,
    sought: (where: string) => `Replacement buses (EV) are being organized ${where}. Please allow for longer waiting times.`,
    resumed: (where: string) => `The train service ${where} has been resumed.\nAllow for further delays and occasional cancellations.`,
  },
};
const L = T.en;

function messages(d: Disruption & { scenario: Scenario }, t: number): BulletinMessage[] {
  const sc = d.scenario;
  const A = name(sc.a);
  const B = sc.b ? name(sc.b) : undefined;
  const where = L.where(A, B);
  const out: BulletinMessage[] = [];
  for (const m of sc.measures) {
    if (m.announcedAt > t) continue;
    const from = m.at > m.announcedAt + 60_000 ? ` from ${hhmm(m.at)}` : "";
    if (m.type === "replacement_bus" && m.params.sought) {
      out.push({ ts: m.announcedAt, title: "Replacement bus", text: `Replacement buses (EV) are being organized ${where}. Long waiting times are to be expected.` });
    } else if (m.type === "replacement_bus") {
      if (m.params.blocked) continue; // never announced: no bus runs
      const f = firstBuses(d, m);
      const pattern = (Array.isArray(m.params.minutesA) || Array.isArray(m.params.minutesB)) && f.A.length > 0;
      const mins = (xs: unknown) => joinAnd(((xs as number[]) ?? []).map((x) => `:${String(x).padStart(2, "0")}`));
      const via = sc.busStops.slice(1, -1).map(name);
      const route = `Replacement buses (EV) run ${where}${via.length ? `, calling at ${joinAnd(via)}` : ""}.`;
      const times = pattern
        ? `Departures from ${A} at ${mins(m.params.minutesA)} and from ${B} at ${mins(m.params.minutesB)} past each hour.`
        : f.A.length && f.B.length
          ? `First departures from ${A} at ${hhmm(f.A[0])} and from ${B} at ${hhmm(f.B[0])}, then every ${Number(m.params.everyMin ?? 15)} minutes.`
          : "";
      out.push({ ts: m.announcedAt, title: "Replacement bus", text: [route, times, "Please allow for longer travel times."].filter(Boolean).join(" ") });
      if (m.withdrawAt !== undefined && (m.withdrawnAnnouncedAt ?? m.announcedAt) <= t && !m.params.replaced)
        out.push({ ts: m.withdrawnAnnouncedAt ?? m.announcedAt, title: "Replacement bus", text: `The replacement buses ${where} stop running at ${hhmm(m.withdrawAt)}.` });
    } else if (m.type === "prognosis") {
      const until = m.params.until as number | null;
      const text = until === null || m.params.durationType === "UNKNOWN" ? "No reopening time is known yet." : m.params.durationType === "UNTIL" ? `The restriction is expected to last until approx. ${hhmm(until)}.` : `The restriction is expected to last at least until ${hhmm(until)}.`;
      out.push({ ts: m.announcedAt, title: "Recovery prognosis", text });
    } else if (m.type === "one_track_open" || m.type === "partial_resumption") {
      const share = Number(m.params.cancelShare ?? 0);
      const kmh = Number(m.params.kmh ?? 40);
      const text = m.type === "one_track_open" ? `One track ${where} is open again${from}. Trains run at reduced speed (${kmh} km/h).${share > 0 ? ` Some trains are cancelled ${where}.` : ""}` : `Trains can run ${where} again with restrictions${from}.`;
      out.push({ ts: m.announcedAt, title: "Partial takeover", text });
    } else if (m.type === "interruption") out.push({ ts: m.announcedAt, title: "Interruption", text: `No trains can run ${where}${from}.` });
    else if (m.type === "short_turn") {
      const at = m.params.at === "A" ? [A] : m.params.at === "B" && B ? [B] : B ? [A, B] : [A];
      out.push({ ts: m.announcedAt, title: "Impact on train services", text: `Trains end their journey at ${joinAnd(at)}${from}; their remaining stops are cancelled.` });
    } else if (m.type === "hold") out.push({ ts: m.announcedAt, title: "Impact on train services", text: `Trains wait ${B ? `at ${A} and ${B}` : `before ${A}`} until the line reopens.` });
    else if (m.type === "cancel_lines") {
      const lines = ((m.params.lines as string[]) ?? []).slice().sort(byLine);
      out.push({ ts: m.announcedAt, title: "Cancellations", text: `${lines.length === 1 ? `Line ${lines[0]} is` : `Lines ${joinAnd(lines)} are`} cancelled ${where}${from}.` });
    } else if (m.type === "resume") {
      if (m.at > t) out.push({ ts: m.announcedAt, title: "Traffic can resume", text: `Trains can run ${where} again from ${hhmm(m.at)}.` });
      else out.push({ ts: Math.max(m.announcedAt, m.at), title: "End of disruption", text: `The disruption ${where} is over. Allow for further delays and occasional cancellations.` });
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/** When limited, the lines still affected: those of the trains the disruption still cuts (as SBB lists them). */
function linesCut(d: Disruption & { scenario: Scenario }) {
  const out = new Set<string>();
  for (const { trip } of candidates(d, dayTrips())) {
    const ch = tripChanges.get(trip.key);
    if (ch && ch.by === d.id && (ch.cut !== undefined || ch.startAt !== undefined) && !ch.committed) out.add(trip.line);
  }
  return [...out].filter((l) => d.scenario.lines.includes(l)).sort(byLine);
}
/** The public bulletin as it reads at time t (deterministic: the same record gives the same text). */
export function render(d: Disruption & { scenario: Scenario }, t: number): Omit<Bulletin, "version" | "ts" | "source"> {
  const sc = d.scenario;
  const A = name(sc.a);
  const B = sc.b ? name(sc.b) : undefined;
  const where = L.where(A, B);
  const place = B ? `${A} - ${B}` : A;
  const st = stateAt(d, t, t);
  const lines = st.state === "limited" ? linesCut(d) : sc.lines;
  const base = { id: d.id, lang: "en" as const, lines: lines.length ? lines : sc.lines, messages: messages(d, t) };
  if (st.state === "resumed") return { ...base, lifecycle: "ENDED", title: L.title("resumed", place), description: L.resumed(where) };
  const cause = causeOf(sc.cause.code);
  const bus = busState(d, t);
  const description = [
    L.head(st.state, where),
    L.cause(cause?.clause.en ?? sc.cause.label.toLowerCase()),
    L.duration(st.durationType, st.until),
    L.lines(base.lines),
    L.allow,
    st.state === "interrupted" ? L.none : announced(d, "one_track_open", t).some((m) => m.at <= t) ? L.oneTrack(st.kmh) : null,
    bus === "running" && B ? L.bus(where) : bus === "sought" && B ? L.sought(where) : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { ...base, lifecycle: "INFO", title: L.title(st.state, place), description };
}

/** Replacement buses now: running (or decided, first departure within 30 min), still being organised, or none. */
function busState(d: Disruption & { scenario: Scenario }, t: number): "running" | "sought" | null {
  const live = announced(d, "replacement_bus", t).filter((m) => !m.params.blocked && m.at <= t + 30 * 60_000 && (m.withdrawAt === undefined || m.withdrawAt > t));
  return live.some((m) => !m.params.sought) ? "running" : live.length ? "sought" : null;
}
export const latestBulletin = (d: Disruption & { scenario: Scenario }) => d.scenario.bulletins.at(-1) ?? null;
const severityOf = (s: StateAt["state"]): Incident["severity"] => (s === "interrupted" ? "critical" : s === "limited" ? "major" : "info");

/** The public face of a scenario disruption: its latest bulletin as an incident (incidents/{id}). */
function publicIncident(d: Disruption & { scenario: Scenario }, b: Bulletin, t: number): Incident {
  const sc = d.scenario;
  const st = stateAt(d, t, t);
  const prev = incidents.get(d.id);
  return {
    id: d.id,
    title: b.title,
    description: b.description,
    severity: severityOf(st.state),
    type: "disruption",
    reasonCode: sc.cause.code,
    scope: d.scope,
    where: d.where,
    geometry: d.geometry,
    disruptionId: d.id,
    source: "control",
    createdAt: prev?.createdAt ?? sc.start,
    updatedAt: t,
    cause: sc.cause,
    effect: st.state === "resumed" ? "resumed" : st.state,
    lines: b.lines,
    durationType: st.durationType,
    until: st.until,
    lifecycle: b.lifecycle,
    bulletinVersion: b.version,
    messages: b.messages,
    replacementBus: busState(d, t) === "running",
  };
}

/** Publish a new bulletin version when the text changed. Returns it, or undefined if nothing changed. */
function bulletin(d: Disruption & { scenario: Scenario }, t: number) {
  const r = render(d, t);
  const last = latestBulletin(d);
  const same = last && last.title === r.title && (last.template ?? last.description) === r.description && last.lifecycle === r.lifecycle && JSON.stringify(last.messages) === JSON.stringify(r.messages) && last.lines.join() === r.lines.join();
  if (same) return undefined;
  const b: Bulletin = { ...r, version: (last?.version ?? 0) + 1, ts: t, source: "template", template: r.description };
  publishVersion(d, b, t);
  if (aiEnabled()) void reword(d, b, facts(d, t, b));
  return b;
}
/** The facts a bulletin states (what the model may say, and must say). */
export function facts(d: Disruption & { scenario: Scenario }, t: number, b: Bulletin): BulletinFacts {
  const sc = d.scenario;
  const st = stateAt(d, t, t);
  const bus = busState(d, t);
  return {
    state: st.state,
    section: { a: name(sc.a), b: sc.b ? name(sc.b) : null },
    cause: causeOf(sc.cause.code)?.clause.en ?? sc.cause.label.toLowerCase(),
    durationType: st.durationType,
    until: st.until === null ? null : hhmm(st.until),
    lines: st.state === "resumed" ? [] : b.lines,
    noTrains: st.state === "interrupted",
    oneTrackKmh: st.state === "limited" && announced(d, "one_track_open", t).some((m) => m.at <= t) ? st.kmh : null,
    replacementBus: bus,
    busStops: sc.busStops.map(name),
  };
}
/** Haiku's wording of the same facts, published as the next version once it passed validation (never blocks). */
async function reword(d: Disruption & { scenario: Scenario }, b: Bulletin, f: BulletinFacts) {
  // the translations are prepared at the same time, so a request in DE/FR/IT is answered from the cache
  for (const lang of ["de", "fr", "it"] as const) void writeBulletin(f, b.description, lang, config.bulletinBackgroundMs);
  const r = await writeBulletin(f, b.description, "en", config.bulletinBackgroundMs);
  if (r.source !== "ai" || r.text === b.description) return;
  if (latestBulletin(d) !== b || !disruptions.has(d.id)) return; // something changed meanwhile: that version gets its own
  const t = Date.now();
  publishVersion(d, { ...b, version: b.version + 1, ts: t, description: r.text, source: "ai" }, t);
}
/** Translated bulletin (DE/FR/IT) or Haiku's EN, waited for up to the timeout; the template when it fails. */
export async function bulletinIn(d: Disruption & { scenario: Scenario }, lang: Lang) {
  const b = latestBulletin(d);
  if (!b) return null;
  const template = b.template ?? b.description;
  if (lang === "en") return b;
  const sc = d.scenario;
  const place = sc.b ? `${name(sc.a)} - ${name(sc.b)}` : name(sc.a);
  const st = stateAt(d, Date.now(), Date.now());
  const r = await writeBulletin(facts(d, Date.now(), b), template, lang);
  if (r.source !== "ai") return { ...b, requestedLang: lang, translationError: r.errors[0] ?? null };
  return { ...b, lang, title: TITLES[lang](st.state, place), description: r.text, source: "ai" as const, messages: b.messages };
}
const TITLES: Record<Exclude<Lang, "en">, (s: StateAt["state"], place: string) => string> = {
  de: (s, p) => (s === "resumed" ? `Aufgehoben: Unterbruch ${p}` : s === "interrupted" ? `Unterbruch ${p}` : `Einschränkung ${p}`),
  fr: (s, p) => (s === "resumed" ? `Trafic rétabli: ${p}` : s === "interrupted" ? `Interruption ${p}` : `Restriction ${p}`),
  it: (s, p) => (s === "resumed" ? `Circolazione ripristinata: ${p}` : s === "interrupted" ? `Interruzione ${p}` : `Limitazioni ${p}`),
};
function publishVersion(d: Disruption & { scenario: Scenario }, b: Bulletin, t: number) {
  d.scenario.bulletins.push(b);
  if (d.scenario.bulletins.length > 60) d.scenario.bulletins.splice(0, d.scenario.bulletins.length - 60);
  publish(`bulletins/${d.id}`, { v: 1, ...b }, { retain: true, qos: 1 });
  const inc = publicIncident(d, b, t);
  incidents.set(inc.id, inc);
  publish(`incidents/${inc.id}`, { v: 1, ...inc, status: d.endedAt ? "ended" : "active" }, { retain: true, qos: 1 });
}

// ---------------------------------------------------------------- the per-second update
const sigs = new Map<string, string>();
let lastBuses = 0;
/** Called every tick before the engine moves the trains (and after every control change, with force). */
export function scenarioTick(t = Date.now(), force = false) {
  let dirty = force;
  for (const d of scenarios()) {
    const sc = d.scenario;
    if (d.endedAt && sc.resumedAt === undefined) {
      // ended by another path (end of the announced time, release, release-all): that is the resumption
      sc.resumedAt = d.endedAt;
    }
    const st = stateAt(d, t, t);
    if (st.state === "resumed" && sc.resumedAt === undefined) {
      const r = sc.measures.find((m) => m.type === "resume" && m.announcedAt <= t && m.at <= t);
      sc.resumedAt = r?.at ?? st.until ?? t;
    }
    if (sc.resumedAt !== undefined && !d.endedAt) d.endedAt = sc.resumedAt;
    if (!d.endedAt) {
      d.effect = st.state === "interrupted" ? "section_closure" : "speed_restriction";
      d.params.maxKmh = st.kmh;
    }
    d.endsAt = d.endedAt ? d.endedAt : expectedEnd(d, t);
    for (const [key, ch] of tripChanges) {
      if (!ch.committed || ch.by !== d.id) continue;
      if (ch.cut !== undefined) sc.committed[key] = ch.cut;
      else if (ch.startAt !== undefined) (sc.committedStart ??= {})[key] = ch.startAt;
    }
    const sig = `${st.state}|${d.endsAt}|${sc.measures.length}|${sc.measures.map((m) => `${m.withdrawAt ?? ""}${m.at <= t ? 1 : 0}`).join()}|${Object.keys(sc.committed).length}|${Object.keys(sc.committedStart ?? {}).length}`;
    if (sigs.get(d.id) !== sig) {
      sigs.set(d.id, sig);
      dirty = true;
    }
  }
  if (dirty || t - lastRecompute >= 5000) recompute(t);
  if (dirty || t - lastBuses >= 60_000) {
    lastBuses = t;
    for (const d of scenarios()) refreshBuses(d, t);
  }
  const changed: Bulletin[] = [];
  for (const d of scenarios()) {
    const b = bulletin(d, t);
    if (b) changed.push(b);
  }
  return changed;
}

/** Forget a scenario disruption's derived state (its buses, bulletin and incident topics, trip changes). */
export function forget(id: string) {
  busTrips.delete(id);
  removeExtraTrips(id);
  hitMemo.delete(id);
  touching.delete(id);
  sigs.delete(id);
  for (const [key, ch] of [...tripChanges]) if (ch.by === id) tripChanges.delete(key);
  clear(`bulletins/${id}`);
  if (incidents.get(id)?.source === "control") {
    incidents.delete(id);
    clear(`incidents/${id}`);
  }
}
/** Sync all: every scenario's buses and timetable changes go. */
export function forgetAll() {
  for (const id of [...busTrips.keys()]) forget(id);
  removeExtraTrips();
  tripChanges.clear();
  hitMemo.clear();
  touching.clear();
  sigs.clear();
}

// ---------------------------------------------------------------- control actions
type MeasureInput = { type?: unknown; at?: unknown; effectiveAt?: unknown; inMin?: unknown; params?: Record<string, unknown>; [k: string]: unknown };
function measureFrom(d: Disruption & { scenario: Scenario }, input: MeasureInput, now: number): Measure {
  const type = String(input.type ?? "") as MeasureType;
  const def = MEASURES.find((m) => m.type === type);
  if (!def) throw new InputError(`Unknown measure "${type}" (one of ${MEASURES.map((m) => m.type).join(", ")})`);
  const { type: _t, at: rawAt, inMin: _i, effectiveAt, params: nested, announcedAt: ann, label: _l, why: _w, probability: _p, ...flat } = input;
  const params: Record<string, unknown> = { ...flat, ...(nested ?? {}) };
  // short_turn {at: "A" | "B" | "both"} names the side; its effective time then comes as effectiveAt (or inMin)
  let when = effectiveAt ?? rawAt;
  if (type === "short_turn" && typeof rawAt === "string" && ["A", "B", "both"].includes(rawAt)) {
    params.at = rawAt;
    when = effectiveAt;
  }
  const at = input.inMin !== undefined ? now + Number(input.inMin) * 60_000 : parseTime(when, now);
  const announcedAt = parseTime(ann, now);
  if (type === "replacement_bus" && !d.scenario.b) throw new InputError("A replacement bus needs a section (from, to)");
  if (type === "replacement_bus" && !params.sought && params.force !== true && sectionKm(d.scenario) > BUS_MAX_KM) {
    params.blocked = true; // registered, but no bus is generated (POST it again with force: true to run one anyway)
    d.scenario.warnings = [...new Set([...(d.scenario.warnings ?? []), busWarning(sectionKm(d.scenario))])];
  }
  if (type === "cancel_lines") {
    const lines = Array.isArray(params.lines) ? params.lines.map(String) : typeof params.lines === "string" ? params.lines.split(/[\s,]+/).filter(Boolean) : [];
    if (!lines.length) throw new InputError("cancel_lines needs lines, e.g. [\"S2\", \"S25\"]");
    params.lines = lines;
  }
  if (type === "short_turn" && params.at !== undefined && !["A", "B", "both"].includes(String(params.at))) throw new InputError('short_turn "at" is "A", "B" or "both"');
  if (type === "prognosis") {
    const until = params.minutes !== undefined ? now + Number(params.minutes) * 60_000 : params.until === null ? null : parseTime(params.until, NaN);
    const durationType = durationTypeOf(params.durationType, until === null || Number.isNaN(until) ? "UNKNOWN" : d.scenario.durationType === "UNKNOWN" ? "UNTIL" : d.scenario.durationType);
    params.until = durationType === "UNKNOWN" || until === null || Number.isNaN(until) ? null : Math.ceil(until / 60_000) * 60_000;
    params.durationType = durationType;
    delete params.minutes;
  }
  let withdrawAt: number | undefined;
  if (params.withdrawAt !== undefined) {
    withdrawAt = parseTime(params.withdrawAt, now);
    delete params.withdrawAt;
  }
  return { id: `m-${randomUUID().slice(0, 6)}`, type, at, announcedAt, params, ...(withdrawAt !== undefined ? { withdrawAt, withdrawnAnnouncedAt: announcedAt } : {}) };
}

export type ScenarioInput = { cause?: unknown; scope?: unknown; effect?: unknown; minutes?: unknown; until?: unknown; durationType?: unknown; start?: unknown; measures?: unknown; applyProposal?: unknown; note?: unknown; linkedTrain?: string };
/** Create a scenario disruption (with its initial measures). */
export function createScenario(input: ScenarioInput, now = Date.now()) {
  const cause = causeOf(String(input.cause ?? ""));
  if (!cause) throw new InputError(`Unknown cause "${String(input.cause)}" (one of ${CAUSES.map((c) => c.code).join(", ")})`);
  const scope = input.scope as Disruption["scope"] | undefined;
  if (!scope || (scope.kind !== "section" && scope.kind !== "station")) throw new InputError("scope is {kind: \"section\", from, to} or {kind: \"station\", station}");
  const effect = (input.effect ?? cause.effect) as EffectState;
  if (effect !== "interrupted" && effect !== "limited") throw new InputError('effect is "interrupted" or "limited"');
  const start = parseTime(input.start, now);
  let durationType = durationTypeOf(input.durationType, cause.durationType);
  let until: number | null = null;
  if (durationType !== "UNKNOWN") {
    if (input.until !== undefined && input.until !== null) until = parseTime(input.until, now);
    else until = start + Number(input.minutes ?? cause.minutes) * 60_000;
  }
  if (until !== null) until = Math.ceil(until / 60_000) * 60_000;
  if (until !== null && until <= now) throw new InputError("The end must be in the future");
  let edges: Set<number>;
  let inside: number[] = [];
  let busStops: number[] = [];
  let a: number;
  let b: number | undefined;
  if (scope.kind === "section") {
    a = stationIndex(scope.from) ?? -1;
    b = stationIndex(scope.to) ?? -1;
    if (a < 0 || b < 0 || a === b) throw new InputError("A section needs two different known stations");
    ({ edges, inside, busStops } = resolveSection(a, b));
  } else {
    a = stationIndex(scope.station) ?? -1;
    if (a < 0) throw new InputError("Unknown station");
    edges = edgesWithin(stops[a].lat, stops[a].lon, 0.5);
  }
  const sc: Scenario = {
    cause: { code: cause.code, label: cause.label },
    initial: effect,
    start,
    durationType,
    until,
    measures: [],
    lines: [],
    a: stops[a].id,
    ...(b !== undefined ? { b: stops[b].id } : {}),
    inside: inside.map((k) => stops[k].id),
    busStops: busStops.map((k) => stops[k].id),
    committed: {},
    bulletins: [],
    proposal: { measures: [], note: "" },
    ...(input.linkedTrain ? { linkedTrain: input.linkedTrain } : {}),
  };
  const d: Disruption & { scenario: Scenario } = {
    id: `d-${randomUUID().slice(0, 8)}`,
    type: "scenario",
    label: cause.label,
    reasonCode: cause.code,
    effect: effect === "interrupted" ? "section_closure" : "speed_restriction",
    scope,
    where: b !== undefined ? `${stops[a].name} – ${stops[b].name}` : stops[a].name,
    params: { maxKmh: 40 },
    startedAt: start,
    endsAt: until,
    note: input.note ? String(input.note) : undefined,
    edges,
    station: b === undefined ? a : undefined,
    geometry: scope.kind === "section" ? edgesGeometry(edges) : { type: "Point", coordinates: [stops[a].lon, stops[a].lat] },
    affected: new Set(),
    scenario: sc,
  };
  sc.lines = linesThrough(d);
  sc.proposal = proposal(cause, effect, until === null ? null : (until - now) / 60_000);
  const km = sectionKm(sc);
  if (km > BUS_MAX_KM) {
    sc.warnings = [busWarning(km)];
    sc.proposal.measures = sc.proposal.measures.filter((m) => m.type !== "replacement_bus");
  }
  if (Array.isArray(input.measures)) for (const m of input.measures) sc.measures.push(measureFrom(d, m as MeasureInput, now));
  if (input.applyProposal === true) for (const p of sc.proposal.measures) sc.measures.push(measureFrom(d, p, now));
  disruptions.set(d.id, d);
  scenarioTick(now, true);
  return d;
}

export function addMeasure(d: Disruption & { scenario: Scenario }, input: MeasureInput, now = Date.now()) {
  if (d.endedAt) throw new InputError("This disruption has ended");
  const m = measureFrom(d, input, now);
  d.scenario.measures.push(m);
  scenarioTick(now, true);
  return m;
}
export function acceptProposal(d: Disruption & { scenario: Scenario }, now = Date.now()) {
  if (d.endedAt) throw new InputError("This disruption has ended");
  const added = d.scenario.proposal.measures.map((p) => measureFrom(d, p, now));
  d.scenario.measures.push(...added);
  scenarioTick(now, true);
  return added;
}
export function withdrawMeasure(d: Disruption & { scenario: Scenario }, measureId: string, at: unknown, now = Date.now(), replaced = false) {
  const m = d.scenario.measures.find((x) => x.id === measureId);
  if (!m) throw new InputError("Unknown measure");
  if (replaced) m.params.replaced = true; // superseded by a newer decision: no separate withdrawal message
  if (m.at > now && m.announcedAt <= now && at === undefined) d.scenario.measures.splice(d.scenario.measures.indexOf(m), 1); // not in effect yet: dropped
  else if (["partial_resumption", "interruption", "prognosis", "resume"].includes(m.type) && m.at <= now) throw new InputError("This decision already took effect");
  else {
    m.withdrawAt = parseTime(at, now);
    m.withdrawnAnnouncedAt = now;
  }
  scenarioTick(now, true);
  return m;
}
export function setState(d: Disruption & { scenario: Scenario }, effect: unknown, at: unknown, now = Date.now()) {
  if (effect === "limited") return addMeasure(d, { type: "partial_resumption", at }, now);
  if (effect === "interrupted") return addMeasure(d, { type: "interruption", at }, now);
  if (effect === "resumed" || effect === "ended") return addMeasure(d, { type: "resume", at }, now);
  throw new InputError('effect is "interrupted", "limited" or "resumed"');
}
export const resume = (d: Disruption & { scenario: Scenario }, at: unknown, now = Date.now()) => addMeasure(d, { type: "resume", at }, now);

// ---------------------------------------------------------------- payload
const measureStatus = (m: Measure, t: number) => {
  if (m.announcedAt > t) return "scheduled";
  if (m.withdrawAt !== undefined && m.withdrawAt <= t) return "withdrawn";
  if (m.at > t) return "planned";
  return ["partial_resumption", "interruption", "prognosis", "resume"].includes(m.type) ? "done" : "active";
};
/** What the scenario adds to a disruption payload. */
export function scenarioFields(d: Disruption & { scenario: Scenario }, t = Date.now()) {
  const sc = d.scenario;
  const st = stateAt(d, t, t);
  const b = latestBulletin(d);
  let cut = 0;
  let held = 0;
  let late = 0;
  for (const ch of tripChanges.values()) if (ch.by === d.id) ch.cut !== undefined ? cut++ : ch.startAt !== undefined ? late++ : held++;
  return {
    kind: "scenario",
    cause: sc.cause,
    effect: st.state,
    mechanism: d.effect,
    durationType: st.durationType,
    until: st.until,
    expectedEnd: d.endedAt ? null : expectedEnd(d, t),
    start: sc.start,
    section: { a: { id: sc.a, name: name(sc.a) }, b: sc.b ? { id: sc.b, name: name(sc.b) } : null, inside: sc.inside.map((id) => ({ id, name: name(id) })) },
    busRoute: sc.busStops.map((id) => ({ id, name: name(id) })),
    measures: sc.measures.map((m) => ({ ...m, label: MEASURES.find((x) => x.type === m.type)?.label ?? m.type, status: measureStatus(m, t), state: measureStatus(m, t) })),
    proposal: sc.proposal,
    lines: sc.lines,
    lifecycle: b?.lifecycle ?? "INFO",
    bulletinVersion: b?.version ?? 0,
    bulletin: b,
    summary: b?.title ?? d.label,
    description: b?.description ?? "",
    impact: { tripsCut: cut, tripsStartingAfter: late, tripsHeld: held, buses: busTrips.get(d.id)?.length ?? 0 },
    linkedTrain: sc.linkedTrain ?? null,
    warnings: sc.warnings ?? [],
  };
}
