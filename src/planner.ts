// Journey planner on the twin's effective timetable: the planned timetable with the live predictions, the twin's
// measures (holds, short turns, cancelled lines, closed sections, replacement buses) and the passenger rules of the
// official timetable (quays, pickup/drop-off types, published transfer times, walking links, trip-to-trip rules,
// stay-seated continuations; src/routing.ts).
//
// Every request runs on one immutable snapshot (snapshotId): the effective connections, sorted by departure. The search
// is a Connection Scan with quay-level labels by number of vehicles used, so "earliest arrival with at most k vehicles"
// is exact for every k; repeating it from just after each found departure enumerates the departure/arrival/changes
// profile. Journeys rank by (arrival, changes, -departure), lexicographically, to the second. Before a journey is
// published its witness is replayed against the snapshot with an independent check (validate()); an invalid one is
// never returned.
import { createHash } from "node:crypto";
import { baseDayTrips, byTrainId, dayTrips, liveTimes, nextDate, servedStations, stationBoard, timetableDate, trains } from "./engine.ts";
import { loadDayMappedSync, searchStations, stationIndex, stops, type Trip } from "./timetable.ts";
import { edgesGeometry, edgeSpans, metres, pathBetween, sectionEdges, travelPath } from "./geometry.ts";
import { serviceOrigin, zurich } from "./time.ts";
import { isScenario, stateAt } from "./scenario.ts";
import { disruptions, effective, incidents, tripChanges, type Disruption, type Incident, type Scenario, type TripChange } from "./disruptions.ts";
import { alertsState } from "./alerts.ts";
import { live, type TripLive } from "./realtime.ts";
import { DEFAULT_TRANSFER_SEC, loadRouting, pairKey, pairSec, pairsFrom, pairsTo, quayCount, quayPlatform, quayStation, quaysOf, routingLoaded, rulesFrom, tripRoute, type TripRoute } from "./routing.ts";

const HORIZON_MS = 6 * 3600_000;
const PARETO_WINDOW_MS = 90 * 60_000; // an option with fewer changes is offered when it arrives within 90 min of the best
const TWIN_BUS_TRANSFER_SEC = 240; // the twin's own replacement buses have no quay: rail <-> bus at a station takes this (or the station's published time if longer)
const SNAPSHOT_MAX_AGE_MS = 30_000; // trains the twin simulates move their predictions: rebuild at least this often then

type Place = { id: string; name: string; lon: number; lat: number };
export type Leg = {
  type: "ride";
  trainId: string;
  line: string;
  category: string;
  headsign: string;
  from: Place & { plannedDep: number; expectedDep: number; platform?: string };
  to: Place & { plannedArr: number; expectedArr: number; platform?: string };
  stopsBetween: number;
  delaySec: number;
  status: "on time" | "late" | "held";
  incidents: { id: string; title: string; severity: string; source: string }[];
  note?: string; // e.g. the reopening a journey relies on
  staySeated?: boolean; // a published stay-seated continuation of the previous ride (no change)
};
/** Walking between two stops (a rail station and its bus stop, two stations): published walking time. */
export type WalkLeg = {
  type: "walk";
  from: Place & { plannedDep: number; expectedDep: number };
  to: Place & { plannedArr: number; expectedArr: number };
  durationSec: number;
  // the fields a ride has, so that code reading every leg as a ride keeps working
  trainId: null;
  line: "Walk";
  category: "WALK";
  headsign: string;
  stopsBetween: 0;
  delaySec: 0;
  status: "on time";
  incidents: [];
};
export type AnyLeg = Leg | WalkLeg;
export type Journey = {
  id: string;
  departure: number; // leaving the requested origin (an initial walk included)
  arrival: number; // at the requested destination (a final walk included)
  plannedDeparture: number;
  plannedArrival: number;
  durationMin: number;
  transfers: number; // changes of vehicle (walks and stay-seated continuations are not changes)
  arrivalDelayMin: number;
  warnings: string[];
  legs: AnyLeg[];
  kind?: "best" | "via" | "wait"; // via: through the requested hub; wait: through an interrupted section after it reopens
  uncertain?: boolean; // relies on a reopening that is not confirmed (crosses after an UNTIL_AT_LEAST bound)
  fastest?: boolean; // the pick to recommend: the best journey that relies on no unconfirmed reopening
  nextServiceDay?: boolean; // the first services of the next morning
  corridor?: string[]; // the stations where it changes
  dominated?: boolean; // another option is better on every count, kept because it uses another corridor
  waitsForReopening?: boolean; // it goes through an interrupted section after the expected reopening
  snapshotId?: string;
};

// ---------------------------------------------------------------------------------------------- station resolution
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
let served: Set<string> | undefined;
let servedFor: Trip[] | undefined;
let normNames: string[] = [];
let normFor: unknown;
const isServed = (k: number) => {
  const day = dayTrips();
  if (!served || servedFor !== day) {
    served = new Set(servedStations().map((s) => s.id));
    servedFor = day;
  }
  return served.has(stops[k].id);
};
/** A station from an id or a name: the exact id, then the exact name (case and accents aside), then the best fuzzy
 *  match (a station trains call at today first). "Locarno" is Locarno (8505400), not Locarno FART. */
export function resolveStation(q: string | undefined) {
  if (!q) return undefined;
  const s = q.trim();
  const direct = stationIndex(s);
  if (direct !== undefined) return direct;
  const n = norm(s);
  if (!n) return undefined;
  if (normFor !== stops) {
    normNames = stops.map((x) => norm(x.name));
    normFor = stops;
  }
  const exact: number[] = [];
  for (let k = 0; k < normNames.length; k++) if (normNames[k] === n) exact.push(k);
  if (exact.length) return exact.find(isServed) ?? exact[0];
  const hits = searchStations(s, 40);
  const hit = hits.find((x) => isServed(stationIndex(x.id)!)) ?? hits[0];
  return hit ? stationIndex(hit.id) : undefined;
}

// ---------------------------------------------------------------------------------------------- closures in time
type Closure = {
  id: string;
  where: string;
  edges: Set<number>;
  inside: Set<number>; // stations closed with the section (and the station of a station closure)
  closed: [number, number][]; // certainly interrupted: [from, to)
  conditional: [number, number][]; // after an UNTIL_AT_LEAST bound with no reopening announced: crossing is conditional
  reopen: number | null; // the expected reopening (for notes)
  sure: boolean; // the reopening is announced (UNTIL or a resume decision)
  ahead: boolean; // the reopening is still to come (a crossing after it relies on it)
  a?: number;
  b?: number;
  bbox?: [number, number, number, number];
  hit: Map<number, boolean>; // station pair -> does a leg between them run on the section (computed on the track)
  pairs?: Set<number>; // the same for every leg of the static layer, from its edge index (set by build())
};
/** When a scenario disruption interrupts its section, as decided at `now`: the measures at their effective times;
 *  UNTIL_AT_LEAST is a lower bound only (crossing after it is conditional), UNKNOWN gives no timed crossing. */
function scheduleOf(d: Disruption & { scenario: Scenario }, now: number) {
  const sc = d.scenario;
  const resumeAt = (x: number) => sc.measures.some((m) => m.type === "resume" && m.announcedAt <= now && m.at <= x) || (sc.resumedAt !== undefined && x >= sc.resumedAt);
  const resumeLater = (x: number) => sc.measures.some((m) => m.type === "resume" && m.announcedAt <= now && m.at > x);
  const points = new Set<number>([sc.start]);
  for (const m of sc.measures) if (m.announcedAt <= now) {
    if (m.at > sc.start) points.add(m.at);
    const u = m.params.until;
    if (typeof u === "number") points.add(u);
  }
  if (sc.until !== null) points.add(sc.until);
  if (sc.resumedAt !== undefined) points.add(sc.resumedAt);
  const xs = [...points].filter((x) => x >= sc.start).sort((x, y) => x - y);
  const closed: [number, number][] = [];
  const conditional: [number, number][] = [];
  const push = (list: [number, number][], x: number, next: number) => {
    const last = list.at(-1);
    if (last && last[1] === x) last[1] = next;
    else list.push([x, next]);
  };
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k];
    const next = k + 1 < xs.length ? xs[k + 1] : Infinity;
    const st = stateAt(d, x, now);
    let state: string = st.state;
    // UNTIL_AT_LEAST is a lower bound: past it the section stays closed until a resumption is announced (closed up to
    // that time), or crossing it is conditional
    if (state === "resumed" && !resumeAt(x) && st.durationType === "UNTIL_AT_LEAST" && st.until !== null && x >= st.until) state = resumeLater(x) ? "interrupted" : "conditional";
    if (state === "interrupted") push(closed, x, next);
    else if (state === "conditional") push(conditional, x, next);
  }
  const lastClosed = closed.at(-1);
  let reopen: number | null = null;
  let sure = false;
  if (conditional.length) reopen = conditional[0][0];
  else if (lastClosed && Number.isFinite(lastClosed[1])) {
    reopen = lastClosed[1];
    sure = true;
  }
  return { closed, conditional, reopen, sure, ahead: reopen === null || reopen > now };
}
function bboxOf(d: Disruption): [number, number, number, number] | undefined {
  const g = d.geometry;
  if (!g || g.type !== "MultiLineString") return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const line of g.coordinates) for (const [x, y] of line) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? [x0 - 0.01, y0 - 0.01, x1 + 0.01, y1 + 0.01] : undefined;
}
const closureMemo = new Map<string, Map<number, boolean>>();
/** Every closure that can matter to a passenger now: interrupted scenario sections (scheduled), plain section
 *  closures, station closures. */
function closuresAt(now: number): Closure[] {
  const out: Closure[] = [];
  for (const d of disruptions.values()) {
    if (d.endedAt && d.endedAt <= now) continue;
    let memo = closureMemo.get(d.id);
    if (!memo) closureMemo.set(d.id, (memo = new Map()));
    if (isScenario(d)) {
      const sc = d.scenario;
      const s = scheduleOf(d, now);
      if (!s.closed.length && !s.conditional.length) continue;
      const inside = new Set(sc.inside.map((id) => stationIndex(id)).filter((x): x is number => x !== undefined));
      const a = stationIndex(sc.a);
      const b = sc.b ? stationIndex(sc.b) : undefined;
      if (b === undefined && a !== undefined) inside.add(a); // a station closure: legs to and from it are hit
      out.push({ id: d.id, where: d.where, edges: d.edges, inside, ...s, a, b, bbox: bboxOf(d), hit: memo });
    } else if (d.effect === "section_closure" && d.edges.size) {
      const end = d.endsAt ?? Infinity;
      out.push({ id: d.id, where: d.where, edges: d.edges, inside: new Set(), closed: [[d.startedAt, end]], conditional: [], reopen: Number.isFinite(end) ? end : null, sure: d.endsAt !== null, ahead: end > now, bbox: bboxOf(d), hit: memo });
    } else if (d.effect === "station_closure" && d.station !== undefined) {
      const end = d.endsAt ?? Infinity;
      out.push({ id: d.id, where: d.where, edges: new Set(), inside: new Set([d.station]), closed: [[d.startedAt, end]], conditional: [], reopen: Number.isFinite(end) ? end : null, sure: d.endsAt !== null, ahead: end > now, hit: memo });
    }
  }
  return out;
}
/** Does a rail leg between two consecutive calls run on the closure (its tracks, or a station closed with it)? A leg
 *  without matched track geometry near the closure counts as running on it (unresolved geometry earns no route). */
function legHits(c: Closure, s1: number, s2: number) {
  const key = s1 * 65536 + s2;
  if (c.pairs && layer?.pairTrips.has(key)) return c.pairs.has(key); // the index covers every leg of the static layer
  return legHitsOnTrack(c, s1, s2);
}
/** The same from the track geometry itself (validate() uses this, not the index). */
function legHitsOnTrack(c: Closure, s1: number, s2: number) {
  const key = s1 * 65536 + s2;
  let h = c.hit.get(key);
  if (h === undefined) {
    h = c.inside.has(s1) || c.inside.has(s2);
    if (!h && c.edges.size) {
      const p = pathBetween(stops[s1], stops[s2]);
      if (p.bav) h = edgeSpans(p).some((sp) => sp.ref !== 0 && c.edges.has(Math.abs(sp.ref)));
      else if (c.bbox) {
        const [x0, y0, x1, y1] = c.bbox;
        const a = stops[s1];
        const b = stops[s2];
        h = Math.max(a.lon, b.lon) >= x0 && Math.min(a.lon, b.lon) <= x1 && Math.max(a.lat, b.lat) >= y0 && Math.min(a.lat, b.lat) <= y1;
      }
    }
    c.hit.set(key, h);
  }
  return h;
}
const BLOCKED = 1;
const CONDITIONAL = 2;
const AFTER_REOPENING = 4;
/** How a leg occupying [t1, t2] relates to the closures: blocked (it cannot get through), conditional (only if the
 *  section reopens at its lower bound), after a reopening, or free. */
function legState(closures: Closure[], s1: number, s2: number, t1: number, t2: number, hitBy?: string[]) {
  let st = 0;
  for (const c of closures) {
    if (!legHits(c, s1, s2)) continue;
    if (c.closed.some(([f, to]) => t1 < to && t2 > f)) {
      hitBy?.push(c.id);
      return BLOCKED;
    }
    if (c.conditional.some(([f, to]) => t1 < to && t2 > f)) {
      st |= CONDITIONAL;
      hitBy?.push(c.id);
    } else if (c.ahead && c.reopen !== null && t1 >= c.reopen - 1) {
      st |= AFTER_REOPENING;
      hitBy?.push(c.id);
    }
  }
  return st;
}

// ---------------------------------------------------------------------------------------------- effective passenger times
/** Planned times shifted by GTFS-RT the way passengers see them: an absolute time before a delay, a delay carried
 *  forward only (never to earlier calls), updates matched by stop_sequence (else by station, in order), no departure
 *  before the timetable. The engine's animation adjustments (dwell borrowed from the approach) stay out of it. */
function passengerTimes(trip: Trip, rt: TripLive, route?: TripRoute) {
  const n = trip.stops.length;
  const arr = Float64Array.from(trip.arr);
  const dep = Float64Array.from(trip.dep);
  const skipped = new Uint8Array(n);
  const at: (TripLive["updates"][number] | undefined)[] = new Array(n);
  let from = 0;
  for (const u of rt.updates) {
    let k = -1;
    if (route && u.seq !== undefined) k = route.seq.indexOf(u.seq);
    if (k < 0 && u.stopId) for (let i = from; i < n; i++) if (stops[trip.stops[i]]?.id === u.stopId) { k = i; break; }
    if (k < 0) continue;
    from = k;
    at[k] = u;
  }
  let cur: number | undefined;
  for (let i = 0; i < n; i++) {
    const u = at[i];
    if (u?.skipped) skipped[i] = 1;
    const a = u ? (u.arrTime ? u.arrTime * 1000 : u.arrDelay !== undefined ? trip.arr[i] + u.arrDelay * 1000 : undefined) : undefined;
    const d = u ? (u.depTime ? u.depTime * 1000 : u.depDelay !== undefined ? trip.dep[i] + u.depDelay * 1000 : undefined) : undefined;
    if (a !== undefined) cur = a - trip.arr[i];
    arr[i] = a ?? trip.arr[i] + (cur ?? 0);
    if (d !== undefined) cur = d - trip.dep[i];
    dep[i] = d ?? trip.dep[i] + (cur ?? 0);
    if (i > 0 && arr[i] < dep[i - 1]) arr[i] = dep[i - 1];
    if (dep[i] < arr[i]) dep[i] = arr[i];
    if (dep[i] < trip.dep[i]) dep[i] = trip.dep[i];
  }
  return { arr, dep, skipped };
}
type Eff = { arr: Float64Array; dep: Float64Array; skipped?: Uint8Array; cancelled: boolean; from: number; firstServed: number; lastServed: number; change?: TripChange; sim: boolean; held: boolean };
/** A trip in the effective timetable: a train the twin simulates (a disruption took control of it) at the twin's own
 *  prediction; any other at its passenger times; then the twin's measures (first served call after a closed section,
 *  short turn, hold until the reopening, moving every later call). */
function effectiveTrip(trip: Trip, t: number, route?: TripRoute): Eff {
  const tr = trains.get(trip.key);
  if (tr && (tr.mode === "sim" || tr.warp > 30_000)) {
    const lt = liveTimes(trip, t);
    const held = (tr.mode === "sim" && tr.speed < 0.5 && tr.leg >= 0) || tr.motion === "held";
    return { arr: lt.arr, dep: lt.dep, skipped: lt.skipped, cancelled: lt.cancelled, from: lt.from, firstServed: lt.firstServed, lastServed: lt.lastServed, change: lt.change, sim: true, held };
  }
  const n = trip.stops.length;
  const rt = live.trips.get(trip.key);
  let arr = trip.arr;
  let dep = trip.dep;
  let skipped: Uint8Array | undefined;
  let cancelled = Boolean(rt?.cancelled);
  if (rt && rt.updates.length) ({ arr, dep, skipped } = passengerTimes(trip, rt, route));
  let from = 0;
  if (tr) {
    cancelled ||= tr.cancelled;
    from = tr.leg >= 0 ? tr.leg + 1 : tr.call;
    if (tr.skipped.some((x) => x)) {
      skipped = skipped ? Uint8Array.from(skipped) : new Uint8Array(n);
      for (let i = 0; i < n; i++) if (tr.skipped[i]) skipped[i] = 1;
    }
  }
  const change = tripChanges.get(trip.key);
  let firstServed = 0;
  let lastServed = n - 1;
  if (change) {
    if (change.startAt !== undefined) {
      firstServed = change.startAt;
      from = Math.max(from, change.startAt);
    }
    if (change.cut !== undefined && change.cut >= from) {
      lastServed = change.cut;
      if (change.cut === 0) cancelled = true;
    }
    const k = change.holdAt;
    if (k !== undefined && change.holdUntil !== undefined && k >= from) {
      const delta = change.holdUntil - dep[k];
      if (delta > 0) {
        arr = Float64Array.from(arr);
        dep = Float64Array.from(dep);
        dep[k] += delta;
        for (let i = k + 1; i < n; i++) {
          arr[i] += delta;
          dep[i] += delta;
        }
      }
    }
  }
  return { arr, dep, skipped, cancelled, from, firstServed, lastServed, change, sim: false, held: Boolean(tr && tr.motion === "held") };
}

// ---------------------------------------------------------------------------------------------- the snapshot
const BOARD = 1;
const ALIGHT = 2;
const STOPS = 4; // the vehicle calls there (not skipped): a served visit for `via`
const C_COND = CONDITIONAL; // 2
const C_REOPEN = AFTER_REOPENING; // 4
const C_EXC = 8; // the arrival call has trip-to-trip rules
type Exc = { toTrip: number; toCall: number; type: number; sec: number };
type Snapshot = {
  id: string;
  builtAt: number;
  sig: string;
  from: number;
  until: number;
  dates: string[];
  incomplete: string[];
  trips: Trip[];
  eff: Eff[];
  base: Int32Array; // first call of each trip in the call arrays
  callNode: Int32Array;
  callFlag: Uint8Array;
  callArr: Float64Array;
  callDep: Float64Array;
  legFlag: Uint8Array;
  firstUsable: Int32Array;
  stopAt: Int32Array;
  route: (TripRoute | undefined)[];
  nConn: number;
  cTrip: Int32Array;
  cCall: Int32Array;
  cDep: Float64Array;
  cArr: Float64Array;
  cFlag: Uint8Array;
  cFrom: Int32Array; // node of the departure call
  cTo: Int32Array; // node of the arrival call
  cFromF: Uint8Array; // call flags (BOARD, ALIGHT, STOPS) of the departure call
  cToF: Uint8Array; // and of the arrival call
  nQ: number; // nodes: quays [0, nQ), then one per station without quay information (the twin's buses)
  nNodes: number;
  used: Uint8Array; // nodes some call uses
  nodeStation: Int32Array;
  adjStart: Int32Array;
  adjNode: Int32Array;
  adjSec: Int32Array;
  stationNodes: Map<number, number[]>; // station -> its nodes used by calls
  exc: Map<number, Exc[]>; // trip * 1024 + call -> rules from that arrival
  veto: Map<number, { fromNode: number; toNode: number; sec: number; type: number }[]>; // fromTrip * 131072 + toTrip -> rules longer than the generic time (or forbidding)
  hasVeto: Uint8Array; // per to trip
  byTripId: Map<string, number[]>;
  closures: Closure[];
  meta: { feed: string[]; serviceDates: string[]; rtFeedTime: number | null; measureRevision: number; simTime: number; trips: number; connections: number; buildMs: number };
};

let snap: Snapshot | undefined; // journeys copy what they need from it: a newer snapshot never changes an older answer
let nextDay: { date: string; trips: Trip[] } | undefined;
const dayIds = new WeakMap<Trip[], number>();
let dayIdSeq = 0;
const dayId = (x: Trip[]) => {
  let id = dayIds.get(x);
  if (id === undefined) dayIds.set(x, (id = ++dayIdSeq));
  return id;
};
function disruptionSig(now: number) {
  let s = "";
  for (const d of disruptions.values()) {
    if (d.endedAt && now - d.endedAt > 6 * 3600_000) continue;
    s += `${d.id}:${d.effect}:${d.endedAt ?? ""}:${d.endsAt ?? ""}:${d.edges.size}`;
    if (d.scenario) for (const m of d.scenario.measures) s += `,${m.id}${m.announcedAt <= now ? "+" : "-"}${m.withdrawAt ?? ""}`;
    s += ";";
  }
  return s;
}
function ensureNextDay() {
  const date = timetableDate() ? nextDate() : "";
  if (!date || nextDay?.date === date) return;
  loadRouting(date);
  nextDay = { date, trips: loadDayMappedSync(date) }; // synchronous: the first answer already covers the next morning
}
/** The snapshot for a request: the current one unless the effective timetable changed. */
function snapshot(t: number): Snapshot {
  const today = timetableDate();
  if (today) loadRouting(today);
  ensureNextDay();
  const anySim = [...trains.values()].some((tr) => tr.mode === "sim");
  const sig = `${today}|${dayId(dayTrips())}|${nextDay?.date ?? ""}:${nextDay?.trips.length ?? 0}|${live.fetchedAt}|${effective.generation}|${tripChanges.size}|${disruptionSig(t)}`;
  if (snap && snap.sig === sig && (!anySim || t - snap.builtAt < SNAPSHOT_MAX_AGE_MS) && t - snap.builtAt < 15 * 60_000) return snap;
  snap = build(t, sig);
  return snap;
}
export const __snap = () => snap; // diagnostics (tests)
export const __rebuild = () => (snap = build(Date.now(), "bench"));
/** Keep the snapshot fresh so a journey request (and /api/brief) never waits for the build: cheap when nothing
 *  changed (a signature check), a rebuild of the changed trips otherwise. */
export function warmPlanner() {
  snapshot(Date.now());
}

/** One trip's calls in the snapshot arrays from offset b: node, times, flags (boarding where pickup allows, alighting
 *  where drop-off allows, none at skipped calls or at a closed station), and its legs against the closures (a blocked
 *  leg stops the vehicle there). Returns the first usable call and the last call the vehicle reaches. */
function tripCalls(trip: Trip, route: TripRoute | undefined, e: Eff, closures: Closure[], stationClosed: Closure[], nQ: number, b: number, a: { callNode: Int32Array; callFlag: Uint8Array; callArr: Float64Array; callDep: Float64Array; legFlag: Uint8Array }) {
  const n = trip.stops.length;
  const road = trip.cat === "EV";
  const first = Math.max(e.from, e.firstServed);
  let stop = e.cancelled ? first : e.lastServed; // the vehicle does not get past a blocked leg
  let cond = 0;
  if (!road && closures.length)
    for (let i = first; i < stop; i++) {
      const st = legState(closures, trip.stops[i], trip.stops[i + 1], e.dep[i], e.arr[i + 1]);
      if (st & BLOCKED) {
        stop = i;
        break;
      }
      if (st & CONDITIONAL) cond = C_COND;
      a.legFlag[b + i] = cond | (st & AFTER_REOPENING);
    }
  for (let i = 0; i < n; i++) {
    const st = trip.stops[i];
    a.callNode[b + i] = route ? route.quay[i] : nQ + st;
    a.callArr[b + i] = e.arr[i];
    a.callDep[b + i] = e.dep[i];
    a.callFlag[b + i] = 0;
    if (i < first || i > stop || e.skipped?.[i]) continue;
    let f = STOPS;
    const closedHere = stationClosed.length > 0 && stationClosed.some((c) => c.inside.has(st) && c.closed.some(([x, y]) => e.dep[i] < y && e.arr[i] >= x));
    if (!closedHere) {
      if (i < stop && (!route || route.pickup[i] === 0)) f |= BOARD;
      if (i > first && (!route || route.dropOff[i] === 0)) f |= ALIGHT;
    }
    a.callFlag[b + i] = f;
  }
  return [first, stop] as const;
}
type Conns = { n: number; trip: Int32Array; call: Int32Array; dep: Float64Array; arr: Float64Array; flag: Uint8Array; from: Int32Array; to: Int32Array; fromF: Uint8Array; toF: Uint8Array };
/** The connections of some trips, sorted by departure, then arrival, then trip and call. */
function connectionsOf(ks: Iterable<number>, base: Int32Array, firstUsable: Int32Array, stopAt: Int32Array, a: { callNode: Int32Array; callFlag: Uint8Array; callArr: Float64Array; callDep: Float64Array; legFlag: Uint8Array }, excCalls: Set<number>, from: number): Conns {
  const list = [...ks];
  let n = 0;
  for (const k of list) n += Math.max(0, stopAt[k] - firstUsable[k]);
  const cTrip = new Int32Array(n), cCall = new Int32Array(n), cDep = new Float64Array(n), cArr = new Float64Array(n);
  let x = 0;
  for (const k of list)
    for (let i = firstUsable[k]; i < stopAt[k]; i++) {
      cTrip[x] = k;
      cCall[x] = i;
      cDep[x] = a.callDep[base[k] + i];
      cArr[x] = a.callArr[base[k] + i + 1];
      x++;
    }
  const order = sortConnections(cDep, cArr, n, from);
  const out: Conns = { n, trip: new Int32Array(n), call: new Int32Array(n), dep: new Float64Array(n), arr: new Float64Array(n), flag: new Uint8Array(n), from: new Int32Array(n), to: new Int32Array(n), fromF: new Uint8Array(n), toF: new Uint8Array(n) };
  for (let y = 0; y < n; y++) {
    const o = order[y];
    const k = cTrip[o];
    const i = cCall[o];
    const ci = base[k] + i;
    out.trip[y] = k;
    out.call[y] = i;
    out.dep[y] = cDep[o];
    out.arr[y] = cArr[o];
    out.flag[y] = a.legFlag[ci] | (excCalls.has(k * 1024 + i + 1) ? C_EXC : 0);
    out.from[y] = a.callNode[ci];
    out.to[y] = a.callNode[ci + 1];
    out.fromF[y] = a.callFlag[ci];
    out.toF[y] = a.callFlag[ci + 1];
  }
  return out;
}

// The static layer: every trip of the loaded day files at its planned times, with its quays, flags, connections
// and trip-to-trip rules. Rebuilt only when the day files change; each snapshot overlays the trips that differ.
type Layer = {
  key: string;
  trips: Trip[];
  route: (TripRoute | undefined)[];
  eff: Eff[];
  base: Int32Array;
  callNode: Int32Array;
  callFlag: Uint8Array;
  callArr: Float64Array;
  callDep: Float64Array;
  legFlag: Uint8Array;
  firstUsable: Int32Array;
  stopAt: Int32Array;
  conns: Conns;
  keyIndex: Map<string, number>;
  pairTrips: Map<number, number[]>; // station pair of a leg -> the trips running it
  edgePairs: Map<number, number[]>;
  stationPairs: Map<number, number[]>;
  loosePairs: number[];
  byTripId: Map<string, number[]>;
  exc: Map<number, Exc[]>;
  veto: Snapshot["veto"];
  hasVeto: Uint8Array;
  excCalls: Set<number>;
  used: Uint8Array;
  adjUsed: Uint8Array;
  stationOfQuay: Int32Array;
  nQ: number;
  until: number;
  dates: string[];
  ms: number;
};
let layer: Layer | undefined;
const pairMemo = new Map<string, Set<number>>();
// Two alternating buffer sets for the snapshot arrays: only the current snapshot is ever read (journeys copy what they
// keep), so the next build can write into the other set (no allocation, no page faults on the request path).
type Buffers = { calls: number; conns: number; callFlag: Uint8Array; callArr: Float64Array; callDep: Float64Array; legFlag: Uint8Array; c: Conns };
const pools: (Buffers | undefined)[] = [undefined, undefined];
let poolTurn = 0;
function buffers(calls: number, conns: number): Buffers {
  poolTurn ^= 1;
  let b = pools[poolTurn];
  if (!b || b.calls < calls || b.conns < conns) {
    const C = Math.ceil(calls * 1.1);
    const N = Math.ceil(conns * 1.1);
    b = { calls: C, conns: N, callFlag: new Uint8Array(C), callArr: new Float64Array(C), callDep: new Float64Array(C), legFlag: new Uint8Array(C), c: { n: 0, trip: new Int32Array(N), call: new Int32Array(N), dep: new Float64Array(N), arr: new Float64Array(N), flag: new Uint8Array(N), from: new Int32Array(N), to: new Int32Array(N), fromF: new Uint8Array(N), toF: new Uint8Array(N) } };
    pools[poolTurn] = b;
  }
  return b;
}
function staticLayer(): Layer {
  const today = baseDayTrips();
  const key = `${dayId(today)}|${nextDay?.date ?? ""}:${dayId(nextDay?.trips ?? [])}|${quayCount()}|${stops.length}`;
  if (layer?.key === key) return layer;
  const t0 = performance.now();
  const keys = new Set(today.map((x) => x.key));
  const extra = (nextDay?.trips ?? []).filter((x) => !keys.has(x.key)); // an occurrence running past midnight is in both files
  const trips = extra.length ? [...today, ...extra] : [...today];
  const nQ = quayCount();
  const nNodes = nQ + stops.length;
  const route = trips.map((trip) => tripRoute(trip));
  const eff: Eff[] = trips.map((trip) => ({ arr: trip.arr, dep: trip.dep, cancelled: false, from: 0, firstServed: 0, lastServed: trip.stops.length - 1, sim: false, held: false }));
  const base = new Int32Array(trips.length + 1);
  let nCalls = 0;
  trips.forEach((trip, k) => {
    base[k] = nCalls;
    nCalls += trip.stops.length;
  });
  base[trips.length] = nCalls;
  const a = { callNode: new Int32Array(nCalls), callFlag: new Uint8Array(nCalls), callArr: new Float64Array(nCalls), callDep: new Float64Array(nCalls), legFlag: new Uint8Array(nCalls) };
  const firstUsable = new Int32Array(trips.length);
  const stopAt = new Int32Array(trips.length);
  const used = new Uint8Array(nNodes);
  const stationOfQuay = new Int32Array(nQ).fill(-1);
  for (let q = 0; q < nQ; q++) stationOfQuay[q] = stationIndex(quayStation[q]) ?? -1;
  const keyIndex = new Map<string, number>();
  const pairTrips = new Map<number, number[]>();
  const edgePairs = new Map<number, number[]>(); // track edge -> the station pairs whose legs run on it
  const stationPairs = new Map<number, number[]>(); // station -> the pairs with a leg to or from it
  const loosePairs: number[] = []; // pairs without matched track geometry
  let until = 0;
  trips.forEach((trip, k) => {
    const [first, stop] = tripCalls(trip, route[k], eff[k], [], [], nQ, base[k], a);
    firstUsable[k] = first;
    stopAt[k] = stop;
    keyIndex.set(trip.key, k);
    for (let i = 0; i < trip.stops.length; i++) used[a.callNode[base[k] + i]] = 1;
    if (trip.cat !== "EV")
      for (let i = 0; i + 1 < trip.stops.length; i++) {
        const pk = trip.stops[i] * 65536 + trip.stops[i + 1];
        const l = pairTrips.get(pk);
        if (!l) {
          pairTrips.set(pk, [k]);
          const path = pathBetween(stops[trip.stops[i]], stops[trip.stops[i + 1]]);
          if (path.bav) for (const sp of edgeSpans(path)) {
            if (!sp.ref) continue;
            const e = Math.abs(sp.ref);
            const pl = edgePairs.get(e);
            if (!pl) edgePairs.set(e, [pk]);
            else if (pl[pl.length - 1] !== pk) pl.push(pk);
          }
          else loosePairs.push(pk);
          for (const st of [trip.stops[i], trip.stops[i + 1]]) {
            const sl = stationPairs.get(st);
            if (sl) sl.push(pk);
            else stationPairs.set(st, [pk]);
          }
        } else if (l[l.length - 1] !== k) l.push(k);
      }
    until = Math.max(until, trip.dep[trip.dep.length - 1]);
  });
  // trip-to-trip rules on the occurrences
  const byTripId = new Map<string, number[]>();
  trips.forEach((trip, k) => {
    const l = byTripId.get(trip.tripId);
    if (l) l.push(k);
    else byTripId.set(trip.tripId, [k]);
  });
  const exc = new Map<number, Exc[]>();
  const veto: Snapshot["veto"] = new Map();
  const hasVeto = new Uint8Array(trips.length);
  const excCalls = new Set<number>();
  for (const [tripId, ks] of byTripId) {
    const rules = rulesFrom.get(tripId);
    if (!rules) continue;
    for (const ka of ks) {
      const ra = route[ka];
      if (!ra) continue;
      const A = trips[ka];
      for (const r of rules) {
        if (r.dates && !r.dates.includes(A.serviceDate)) continue;
        const ja = ra.quay.indexOf(r.fromQuay);
        if (ja < 0) continue;
        const arrA = A.arr[ja];
        for (const kb of byTripId.get(r.toTrip) ?? []) {
          const rb = route[kb];
          if (!rb) continue;
          const jb = rb.quay.indexOf(r.toQuay);
          if (jb < 0) continue;
          const depB = trips[kb].dep[jb];
          if (depB < arrA - 3600_000 || depB > arrA + 6 * 3600_000) continue; // the occurrence of the same service day
          if (r.type === 3 || (r.type === 2 && r.sec > genericSec(r.fromQuay, r.toQuay, stationOfQuay))) {
            const vk = ka * 131072 + kb;
            const list = veto.get(vk) ?? [];
            list.push({ fromNode: r.fromQuay, toNode: r.toQuay, sec: r.sec, type: r.type });
            veto.set(vk, list);
            hasVeto[kb] = 1;
            if (r.type === 3) continue;
          }
          const ek = ka * 1024 + ja;
          const list = exc.get(ek) ?? [];
          list.push({ toTrip: kb, toCall: jb, type: r.type, sec: r.sec });
          exc.set(ek, list);
          excCalls.add(ek);
        }
      }
    }
  }
  const all = { length: trips.length, *[Symbol.iterator]() { for (let k = 0; k < trips.length; k++) yield k; } };
  const conns = connectionsOf(all, base, firstUsable, stopAt, a, excCalls, Date.now() - 86_400_000);
  const dates = [...new Set(trips.map((trip) => trip.serviceDate))].sort();
  const adjUsed = Uint8Array.from(used);
  for (let st = 0; st < stops.length; st++) adjUsed[nQ + st] = 1; // the twin's buses call at stations: every station's bus node exists
  layer = { adjUsed, key, trips, route, eff, base, ...a, firstUsable, stopAt, conns, keyIndex, pairTrips, edgePairs, stationPairs, loosePairs, byTripId, exc, veto, hasVeto, excCalls, used, stationOfQuay, nQ, until, dates, ms: Math.round(performance.now() - t0) };
  console.log(`[planner] static layer: ${trips.length} trips, ${conns.n} connections, ${layer.ms} ms`);
  return layer;
}

/** A snapshot: the static layer with the trips that differ now recomputed and merged in (realtime, the twin's trip
 *  changes and simulated trains, legs on a closure, the twin's own buses). */
function build(t: number, sig: string): Snapshot {
  const t0 = performance.now();
  const L = staticLayer();
  const closures = closuresAt(t);
  const stationClosed = closures.filter((c) => !c.edges.size && c.inside.size);
  const nBase = L.trips.length;
  // the trips that differ from the static layer
  const over = new Uint8Array(nBase);
  const mark = (key: string) => {
    const k = L.keyIndex.get(key);
    if (k !== undefined) over[k] = 1;
  };
  for (const [key, rt] of live.trips) if (rt.cancelled || rt.updates.length) mark(key);
  for (const key of tripChanges.keys()) mark(key);
  for (const tr of trains.values()) if (tr.mode === "sim" || tr.warp > 30_000 || tr.cancelled || tr.motion === "held" || tr.skipped.some((x) => x)) mark(tr.trip.key);
  for (const c of closures) {
    const memoKey = `${c.id}|${L.key}|${c.edges.size}|${c.inside.size}`;
    let pairs = pairMemo.get(memoKey);
    if (!pairs) {
      pairs = new Set<number>();
      for (const e of c.edges) for (const pk of L.edgePairs.get(e) ?? []) pairs.add(pk);
      for (const st of c.inside) for (const pk of L.stationPairs.get(st) ?? []) pairs.add(pk);
      for (const pk of L.loosePairs) if (legHitsOnTrack(c, Math.floor(pk / 65536), pk % 65536)) pairs.add(pk);
      pairMemo.set(memoKey, pairs);
      if (pairMemo.size > 64) pairMemo.delete(pairMemo.keys().next().value!);
    }
    c.pairs = pairs;
    for (const pk of pairs) for (const k of L.pairTrips.get(pk) ?? []) over[k] = 1;
  }
  const added = dayTrips().slice(baseDayTrips().length); // the twin's buses (and any added trip)
  const nT = nBase + added.length;
  const nQ = L.nQ;
  const trips = added.length ? [...L.trips, ...added] : L.trips;
  const route: (TripRoute | undefined)[] = added.length ? [...L.route, ...added.map(() => undefined)] : L.route;
  const eff = L.eff.slice();
  const baseOff = new Int32Array(nT + 1);
  baseOff.set(L.base.subarray(0, nBase + 1));
  let nCalls = L.base[nBase];
  for (let k = nBase; k < nT; k++) {
    baseOff[k] = nCalls;
    nCalls += trips[k].stops.length;
  }
  baseOff[nT] = nCalls;
  // connections: the static ones of unchanged trips, plus the recomputed ones (counted after the trips)
  let keep = 0;
  for (let y = 0; y < L.conns.n; y++) if (!over[L.conns.trip[y]]) keep++;
  let addedConns = 0;
  for (const trip of added) addedConns += trip.stops.length;
  let overConns = 0;
  for (let k = 0; k < nBase; k++) if (over[k]) overConns += L.trips[k].stops.length;
  const buf = buffers(nCalls, keep + overConns + addedConns);
  const view = <A extends Uint8Array | Float64Array>(x: A, src: A) => {
    const v = x.subarray(0, nCalls) as A;
    v.set(src);
    if (nCalls > src.length) v.fill(0, src.length);
    return v;
  };
  let callNode = L.callNode;
  if (added.length) {
    callNode = new Int32Array(nCalls);
    callNode.set(L.callNode);
  }
  const a = { callNode, callFlag: view(buf.callFlag, L.callFlag), callArr: view(buf.callArr, L.callArr), callDep: view(buf.callDep, L.callDep), legFlag: view(buf.legFlag, L.legFlag) };
  const firstUsable = new Int32Array(nT);
  firstUsable.set(L.firstUsable);
  const stopAt = new Int32Array(nT);
  stopAt.set(L.stopAt);
  const changed: number[] = [];
  for (let k = 0; k < nT; k++) {
    if (k < nBase && !over[k]) continue;
    const trip = trips[k];
    const e = effectiveTrip(trip, t, route[k]);
    if (k < nBase) eff[k] = e;
    else eff.push(e);
    const [first, stop] = tripCalls(trip, route[k], e, closures, stationClosed, nQ, baseOff[k], a);
    firstUsable[k] = first;
    stopAt[k] = stop;
    changed.push(k);
  }
  const fresh = connectionsOf(changed, baseOff, firstUsable, stopAt, a, L.excCalls, t - 86_400_000);
  // merge the static connections of unchanged trips with the recomputed ones
  const B = L.conns;
  const nConn = keep + fresh.n;
  const sub = <A extends Int32Array | Uint8Array | Float64Array>(x: A) => x.subarray(0, nConn) as A;
  const P = buf.c;
  const c: Conns = { n: nConn, trip: sub(P.trip), call: sub(P.call), dep: sub(P.dep), arr: sub(P.arr), flag: sub(P.flag), from: sub(P.from), to: sub(P.to), fromF: sub(P.fromF), toF: sub(P.toF) };
  {
    // a tight two-way merge (the static list without the recomputed trips, and the recomputed list)
    const bT = B.trip, bC = B.call, bD = B.dep, bA = B.arr, bF = B.flag, bFr = B.from, bTo = B.to, bFF = B.fromF, bTF = B.toF;
    const fT = fresh.trip, fC = fresh.call, fD = fresh.dep, fA = fresh.arr, fF = fresh.flag, fFr = fresh.from, fTo = fresh.to, fFF = fresh.fromF, fTF = fresh.toF;
    const oT = c.trip, oC = c.call, oD = c.dep, oA = c.arr, oF = c.flag, oFr = c.from, oTo = c.to, oFF = c.fromF, oTF = c.toF;
    const nb = B.n, nf = fresh.n;
    let x = 0, y = 0, z = 0;
    for (;;) {
      while (y < nb && over[bT[y]] === 1) y++;
      let fromB: boolean;
      if (y < nb && z < nf) {
        const d1 = bD[y], d2 = fD[z];
        fromB = d1 < d2 || (d1 === d2 && (bA[y] < fA[z] || (bA[y] === fA[z] && (bT[y] < fT[z] || (bT[y] === fT[z] && bC[y] < fC[z])))));
      } else if (y < nb) fromB = true;
      else if (z < nf) fromB = false;
      else break;
      if (fromB) {
        oT[x] = bT[y]; oC[x] = bC[y]; oD[x] = bD[y]; oA[x] = bA[y]; oF[x] = bF[y]; oFr[x] = bFr[y]; oTo[x] = bTo[y]; oFF[x] = bFF[y]; oTF[x] = bTF[y];
        y++;
      } else {
        oT[x] = fT[z]; oC[x] = fC[z]; oD[x] = fD[z]; oA[x] = fA[z]; oF[x] = fF[z]; oFr[x] = fFr[z]; oTo[x] = fTo[z]; oFF[x] = fFF[z]; oTF[x] = fTF[z];
        z++;
      }
      x++;
    }
  }
  let used = L.used;
  if (added.length) {
    used = new Uint8Array(L.used.length);
    used.set(L.used);
    for (let k = nBase; k < nT; k++) for (let i = 0; i < trips[k].stops.length; i++) used[a.callNode[baseOff[k] + i]] = 1;
  }
  const nNodes = nQ + stops.length;
  const nodes = adjacency(nQ, nNodes, L.adjUsed, L.stationOfQuay);
  const hasVeto = new Uint8Array(nT);
  hasVeto.set(L.hasVeto);
  const dates = L.dates;
  const incomplete: string[] = [];
  if (!nextDay?.trips.length) incomplete.push(`no timetable for ${nextDate()}: the search ends with today's last trains`);
  for (const d of [timetableDate(), nextDay?.date].filter(Boolean) as string[]) if (!routingLoaded().some((r) => r.date === d)) incomplete.push(`no routing data for ${d}: station-level transfer times`);
  const id = `s-${createHash("sha1").update(`${sig}|${t}`).digest("hex").slice(0, 12)}`;
  const s: Snapshot = {
    id, builtAt: t, sig, from: -Infinity, until: Math.max(L.until, t), dates, incomplete, trips, eff, base: baseOff, ...a, firstUsable, stopAt, route,
    nConn, cTrip: c.trip, cCall: c.call, cDep: c.dep, cArr: c.arr, cFlag: c.flag, cFrom: c.from, cTo: c.to, cFromF: c.fromF, cToF: c.toF,
    nQ, nNodes, used, nodeStation: nodes.nodeStation, adjStart: nodes.adjStart, adjNode: nodes.adjNode, adjSec: nodes.adjSec, stationNodes: nodes.stationNodes,
    exc: L.exc, veto: L.veto, hasVeto, byTripId: L.byTripId, closures,
    meta: {
      feed: [...new Set(routingLoaded().map((r) => r.feed))],
      serviceDates: dates,
      rtFeedTime: live.feedTime || null,
      measureRevision: effective.generation,
      simTime: t,
      trips: nT,
      connections: nConn,
      buildMs: 0,
    },
  };
  s.meta.buildMs = Math.round(performance.now() - t0);
  if (s.meta.buildMs > 150) console.warn(`[planner] snapshot ${s.id} took ${s.meta.buildMs} ms (${changed.length} trips recomputed)`);
  return s;
}
/** The published minimum time between two quays: their stop-pair row, else the Swiss default inside one stop. */
function genericSec(qa: number, qb: number, stationOfQuay: Int32Array) {
  const s = pairSec.get(pairKey(qa, qb));
  if (s !== undefined) return s;
  return stationOfQuay[qa] >= 0 && stationOfQuay[qa] === stationOfQuay[qb] ? DEFAULT_TRANSFER_SEC : Infinity;
}
function sortConnections(dep: Float64Array, arr: Float64Array, n: number, from: number) {
  // one float key per connection: departure second, then arrival delta, then creation order (trip, call)
  const keys = new Float64Array(n);
  const base0 = Math.floor(from / 1000) - 86_400;
  for (let i = 0; i < n; i++) {
    const d = Math.max(0, Math.round(dep[i] / 1000) - base0);
    const a = Math.min(16_383, Math.max(0, Math.round((arr[i] - dep[i]) / 1000)));
    keys[i] = (d * 16_384 + a) * 1_048_576 + i;
  }
  keys.sort();
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = keys[i] % 1_048_576;
  return order;
}
/** Where a passenger standing at a node can board next, and in how many seconds: every quay of the same station
 *  (published time, else 120 s), published walking links to other stations, and the twin's buses at the station. */
let adjCache: { key: string; value: ReturnType<typeof buildAdjacency> } | undefined;
function adjacency(nQ: number, nNodes: number, used: Uint8Array, stationOfQuay: Int32Array) {
  let h = 0;
  for (let i = 0; i < nNodes; i++) if (used[i]) h = (h * 31 + i) | 0;
  const key = `${nQ}|${nNodes}|${h}`;
  if (adjCache?.key === key) return adjCache.value;
  const value = buildAdjacency(nQ, nNodes, used, stationOfQuay);
  adjCache = { key, value };
  return value;
}
function buildAdjacency(nQ: number, nNodes: number, used: Uint8Array, stationOfQuay: Int32Array) {
  const nodeStation = new Int32Array(nNodes);
  for (let q = 0; q < nQ; q++) nodeStation[q] = stationOfQuay[q];
  for (let s = 0; s < nNodes - nQ; s++) nodeStation[nQ + s] = s;
  const stationNodes = new Map<number, number[]>();
  for (let v = 0; v < nNodes; v++) {
    if (!used[v] || nodeStation[v] < 0) continue;
    const l = stationNodes.get(nodeStation[v]);
    if (l) l.push(v);
    else stationNodes.set(nodeStation[v], [v]);
  }
  // the station's published time (all its quay pairs share one), for the twin's buses
  const stationSec = new Map<number, number>();
  for (const [k, sec] of pairSec) {
    const a = Math.floor(k / 2_097_152);
    const b = k % 2_097_152;
    if (a < nQ && b < nQ && stationOfQuay[a] >= 0 && stationOfQuay[a] === stationOfQuay[b]) stationSec.set(stationOfQuay[a], Math.max(stationSec.get(stationOfQuay[a]) ?? 0, sec));
  }
  const busSec = (s: number) => Math.max(TWIN_BUS_TRANSFER_SEC, stationSec.get(s) ?? 0);
  const lists: [number, number][][] = new Array(nNodes);
  for (let v = 0; v < nNodes; v++) {
    if (!used[v] || nodeStation[v] < 0) continue;
    const s = nodeStation[v];
    const out = new Map<number, number>();
    const add = (w: number, sec: number) => {
      if (!used[w]) return;
      const old = out.get(w);
      if (old === undefined || sec < old) out.set(w, sec);
    };
    if (v < nQ) {
      for (const w of stationNodes.get(s) ?? []) add(w, w < nQ ? genericSec(v, w, stationOfQuay) : busSec(s));
      for (const w of pairsFrom.get(v) ?? []) if (w < nQ) add(w, pairSec.get(pairKey(v, w))!);
    } else for (const w of stationNodes.get(s) ?? []) add(w, busSec(s));
    lists[v] = [...out];
  }
  const adjStart = new Int32Array(nNodes + 1);
  let m = 0;
  for (let v = 0; v < nNodes; v++) {
    adjStart[v] = m;
    m += lists[v]?.length ?? 0;
  }
  adjStart[nNodes] = m;
  const adjNode = new Int32Array(m);
  const adjSec = new Int32Array(m);
  for (let v = 0; v < nNodes; v++) {
    let o = adjStart[v];
    for (const [w, sec] of lists[v] ?? []) {
      adjNode[o] = w;
      adjSec[o] = sec;
      o++;
    }
  }
  return { nodeStation, adjStart, adjNode, adjSec, stationNodes };
}

// ---------------------------------------------------------------------------------------------- the search
const K_ORIGIN = 0;
const K_TRANSFER = 1; // published (or default) minimum time between the quays, or a walking link
const K_RULE = 2; // a trip-to-trip rule (published minimum for exactly these two trips, or a timed connection)
const K_SEATED = 4; // stay seated: the vehicle continues as another trip
type Mode = 0 | 1 | 2; // 0 plain; 1 via: a served visit to the hub; 2 wait: rides through a section after its reopening
type Query = {
  s: Snapshot;
  origin: number;
  dest: number;
  L: number; // vehicles at most (changes + 1)
  mode: Mode;
  via: number;
  certain: boolean; // conditional crossings (after an UNTIL_AT_LEAST bound) excluded
  horizon: number;
  originWalk: Map<number, number>; // node -> seconds from the origin station
  destWalk: Map<number, number>; // node -> seconds to the destination station
};
// scratch state, reused by every scan (stamped instead of cleared)
let cap = { labels: 0, trips: 0 };
let qid = 0;
let R1t = new Float64Array(0), R2t = new Float64Array(0), A1t = new Float64Array(0), A2t = new Float64Array(0);
let R1s = new Int32Array(0), R1e = new Int32Array(0), R2s = new Int32Array(0), R2e = new Int32Array(0), A1s = new Int32Array(0), A2s = new Int32Array(0);
let Rst = new Int32Array(0), Ast = new Int32Array(0);
let Tl = new Int8Array(0), Tb = new Int32Array(0), Tst = new Int32Array(0), Pst = new Int32Array(0);
let dWalk = new Float64Array(0), dSt = new Int32Array(0);
// events: boardings and alightings, for the witness
let nB = 0, nA = 0;
let bTrip = new Int32Array(1024), bCall = new Int32Array(1024), bLv = new Int8Array(1024), bKind = new Int8Array(1024), bPrev = new Int32Array(1024), bNode = new Int32Array(1024);
let aBev = new Int32Array(1024), aCall = new Int32Array(1024), aNode = new Int32Array(1024), aTime = new Float64Array(1024);
function growB() {
  const n = bTrip.length * 2;
  const g = <T extends Int32Array | Int8Array>(x: T, C: new (n: number) => T) => { const y = new C(n); y.set(x); return y; };
  bTrip = g(bTrip, Int32Array); bCall = g(bCall, Int32Array); bLv = g(bLv, Int8Array); bKind = g(bKind, Int8Array); bPrev = g(bPrev, Int32Array); bNode = g(bNode, Int32Array);
}
function growA() {
  const n = aBev.length * 2;
  const g = <T extends Int32Array>(x: T) => { const y = new Int32Array(n); y.set(x); return y as T; };
  aBev = g(aBev); aCall = g(aCall); aNode = g(aNode);
  const t = new Float64Array(n); t.set(aTime); aTime = t;
}
function ensure(labels: number, tripsN: number, nodes: number) {
  if (labels > cap.labels) {
    R1t = new Float64Array(labels); R2t = new Float64Array(labels); A1t = new Float64Array(labels); A2t = new Float64Array(labels);
    R1s = new Int32Array(labels); R1e = new Int32Array(labels); R2s = new Int32Array(labels); R2e = new Int32Array(labels); A1s = new Int32Array(labels); A2s = new Int32Array(labels);
    Rst = new Int32Array(labels); Ast = new Int32Array(labels);
    cap.labels = labels;
  }
  if (tripsN > cap.trips) {
    Tl = new Int8Array(tripsN); Tb = new Int32Array(tripsN); Tst = new Int32Array(tripsN); Pst = new Int32Array(tripsN);
    cap.trips = tripsN;
  }
  if (dWalk.length < nodes) {
    dWalk = new Float64Array(nodes);
    dSt = new Int32Array(nodes);
  }
}
/** Keep the best two labels from different source trips (a trip-specific rule can forbid the best one). */
function putR(ix: number, t: number, src: number, evt: number) {
  if (Rst[ix] !== qid) {
    Rst[ix] = qid; R1t[ix] = t; R1s[ix] = src; R1e[ix] = evt; R2t[ix] = Infinity; R2s[ix] = -9; R2e[ix] = -2;
    return;
  }
  if (t < R1t[ix]) {
    if (R1s[ix] !== src) { R2t[ix] = R1t[ix]; R2s[ix] = R1s[ix]; R2e[ix] = R1e[ix]; }
    R1t[ix] = t; R1s[ix] = src; R1e[ix] = evt;
  } else if (src !== R1s[ix] && t < R2t[ix]) { R2t[ix] = t; R2s[ix] = src; R2e[ix] = evt; }
}
function putA(ix: number, t: number, src: number) {
  if (Ast[ix] !== qid) {
    Ast[ix] = qid; A1t[ix] = t; A1s[ix] = src; A2t[ix] = Infinity; A2s[ix] = -9;
    return true;
  }
  if (t < A1t[ix]) {
    if (A1s[ix] !== src) { A2t[ix] = A1t[ix]; A2s[ix] = A1s[ix]; }
    A1t[ix] = t; A1s[ix] = src;
    return true;
  }
  if (src !== A1s[ix] && t < A2t[ix]) { A2t[ix] = t; A2s[ix] = src; return true; }
  return false;
}
function board(ti: number, T: number, i: number, lv: number, kind: number, prev: number, node: number) {
  if (Tst[ti] === qid && Tl[ti] <= lv) return;
  if (nB >= bTrip.length) growB();
  bTrip[nB] = T; bCall[nB] = i; bLv[nB] = lv; bKind[nB] = kind; bPrev[nB] = prev; bNode[nB] = node;
  Tst[ti] = qid; Tl[ti] = lv; Tb[ti] = nB;
  nB++;
}
function arrival(bev: number, call: number, node: number, t: number) {
  if (nA >= aBev.length) growA();
  aBev[nA] = bev; aCall[nA] = call; aNode[nA] = node; aTime[nA] = t;
  return nA++;
}
type Result = { D: Float64Array; De: Int32Array; Dw: Float64Array; L: number; bits: number; scanned: number };
/** One Connection Scan from ready time tau: for every number of vehicles 1..L (and the via/wait bit), the earliest
 *  arrival at the destination, with its witness in the event arrays. */
function scan(q: Query, tau: number): Result {
  const s = q.s;
  const L = q.L;
  const NB = q.mode ? 2 : 1;
  const nT = s.trips.length;
  const NN = s.nNodes;
  const LV = L + 1;
  ensure(NB * LV * NN, NB * nT, NN);
  qid++;
  nB = 0;
  nA = 0;
  const D = new Float64Array(NB * (L + 1)).fill(Infinity);
  const De = new Int32Array(NB * (L + 1)).fill(-1);
  const Dw = new Float64Array(NB * (L + 1));
  const pending = new Map<number, { call: number; lv: number; evt: number; kind: number }[]>();
  const { cTrip, cCall, cDep, cArr, cFlag, cFrom, cTo, cFromF, cToF, base, adjStart, adjNode, adjSec, nodeStation, hasVeto } = s;
  const via = q.mode === 1 ? q.via : -1;
  for (const [node, sec] of q.destWalk) {
    dSt[node] = qid;
    dWalk[node] = sec;
  }
  for (const [node, sec] of q.originWalk) {
    const bit = via >= 0 && (nodeStation[node] === via || q.origin === via) ? 1 : 0;
    putR((bit * NN + node) * LV, tau + sec * 1000, -1, -1);
  }
  const vetoed = (src: number, evt: number, T: number, node: number, dep: number) => {
    if (src < 0 || evt < 0) return false;
    const rules = s.veto.get(src * 131072 + T);
    if (!rules) return false;
    for (const r of rules) if (r.fromNode === aNode[evt] && r.toNode === node) return r.type === 3 || aTime[evt] + r.sec * 1000 > dep;
    return false;
  };
  // first connection departing at or after tau
  let lo = 0;
  let hi = s.nConn;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cDep[mid] < tau) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  let stop = q.horizon;
  let x = lo;
  for (; x < s.nConn; x++) {
    const dep = cDep[x];
    if (dep > stop) break;
    const f = cFlag[x];
    if (q.certain && f & C_COND) continue;
    const T = cTrip[x];
    const i = cCall[x];
    const fromNode = cFrom[x];
    const cf = cFromF[x];
    for (let bit = 0; bit < NB; bit++) {
      const ti = bit * nT + T;
      const cur = Tst[ti] === qid ? Tl[ti] : L + 1;
      if (cf & BOARD && cur > 1) {
        for (let lv = 0; lv + 1 < cur; lv++) {
          const ix = (bit * NN + fromNode) * LV + lv;
          if (Rst[ix] !== qid) continue;
          let e = -2;
          if (R1t[ix] <= dep && !(hasVeto[T] && vetoed(R1s[ix], R1e[ix], T, fromNode, dep))) e = R1e[ix];
          else if (R2t[ix] <= dep && !(hasVeto[T] && vetoed(R2s[ix], R2e[ix], T, fromNode, dep))) e = R2e[ix];
          if (e === -2) continue;
          board(ti, T, i, lv + 1, e < 0 ? K_ORIGIN : K_TRANSFER, e, fromNode);
          break;
        }
      }
      if (Pst[ti] === qid) {
        const pl = pending.get(ti);
        if (pl) for (const p of pl) if (p.call === i && (p.kind === K_SEATED || cf & BOARD)) board(ti, T, i, p.lv, p.kind, p.evt, fromNode);
      }
    }
    if (NB === 2) {
      // a served visit to the hub while aboard, or a ride through the reopened section: the bit is set from here on
      const up = q.mode === 1 ? (cf & STOPS) !== 0 && nodeStation[fromNode] === via : (f & (C_REOPEN | C_COND)) !== 0;
      if (up && Tst[T] === qid && (Tst[nT + T] !== qid || Tl[nT + T] > Tl[T])) {
        Tst[nT + T] = qid;
        Tl[nT + T] = Tl[T];
        Tb[nT + T] = Tb[T];
      }
    }
    const toNode = cTo[x];
    const af = cToF[x];
    const arr = cArr[x];
    for (let bit = 0; bit < NB; bit++) {
      const ti = bit * nT + T;
      if (Tst[ti] !== qid) continue;
      const lv = Tl[ti];
      const bev = Tb[ti];
      const nbit = via >= 0 && nodeStation[toNode] === via ? 1 : bit;
      let evt = -1;
      if (f & C_EXC) {
        for (const r of s.exc.get(T * 1024 + i + 1) ?? []) {
          const depB = s.callDep[base[r.toTrip] + r.toCall];
          let kind: number;
          let need: number;
          let to: number;
          if (r.type === 4) { kind = K_SEATED; need = arr; to = lv; } // the same vehicle continues
          else if (af & ALIGHT && lv < L) { kind = K_RULE; need = arr + (r.type === 1 ? 0 : r.sec * 1000); to = lv + 1; }
          else continue;
          if (depB < need) continue;
          if (evt < 0) evt = arrival(bev, i + 1, toNode, arr);
          const key = (r.type === 4 ? bit : nbit) * nT + r.toTrip;
          const p = { call: r.toCall, lv: to, evt, kind };
          if (Pst[key] === qid) pending.get(key)!.push(p);
          else {
            Pst[key] = qid;
            pending.set(key, [p]);
          }
        }
      }
      if (!(af & ALIGHT)) continue;
      let dominated = false;
      for (let l2 = 1; l2 < lv && !dominated; l2++) {
        const ix2 = (nbit * NN + toNode) * LV + l2;
        if (Ast[ix2] === qid && A1t[ix2] <= arr) dominated = true;
      }
      if (dominated) continue;
      if (dSt[toNode] === qid && (q.mode !== 1 || nbit === 1)) {
        const tt = arr + dWalk[toNode] * 1000;
        const di = nbit * (L + 1) + lv;
        if (tt < D[di]) {
          if (evt < 0) evt = arrival(bev, i + 1, toNode, arr);
          D[di] = tt;
          De[di] = evt;
          Dw[di] = dWalk[toNode];
          if (q.mode === 0 || nbit === 1) {
            if (tt < best) best = tt;
            stop = Math.min(q.horizon, best + PARETO_WINDOW_MS, D[nbit * (L + 1) + 1]);
          }
        }
      }
      if (lv >= L) continue;
      const ax = (nbit * NN + toNode) * LV + lv;
      if (!putA(ax, arr, T)) continue;
      if (evt < 0) evt = arrival(bev, i + 1, toNode, arr);
      for (let k = adjStart[toNode]; k < adjStart[toNode + 1]; k++) {
        const w = adjNode[k];
        const wbit = via >= 0 && nodeStation[w] === via ? 1 : nbit;
        putR((wbit * NN + w) * LV + lv, arr + adjSec[k] * 1000, T, evt);
      }
    }
  }
  return { D, De, Dw, L, bits: NB, scanned: x - lo };
}
type Part = { trip: number; i: number; j: number; kind: number; boardNode: number; alightNode: number };
type Witness = { parts: Part[]; initialWalk: number; finalWalk: number; departure: number; arrival: number; changes: number };
/** The witnesses of the Pareto levels of a scan (fewest vehicles first): the earliest arrival with 1, 2, ... vehicles
 *  when it beats every level with fewer. */
function witnesses(q: Query, r: Result): Witness[] {
  const out: Witness[] = [];
  const bit = q.mode ? 1 : 0;
  let last = Infinity;
  for (let lv = 1; lv <= r.L; lv++) {
    const di = bit * (r.L + 1) + lv;
    const t = r.D[di];
    if (!(t < last)) continue;
    last = t;
    const parts: Part[] = [];
    let e = r.De[di];
    let guard = 0;
    while (e >= 0 && guard++ < 32) {
      const b = aBev[e];
      parts.unshift({ trip: bTrip[b], i: bCall[b], j: aCall[e], kind: bKind[b], boardNode: bNode[b], alightNode: aNode[e] });
      e = bPrev[b];
    }
    if (!parts.length || e !== -1) continue;
    const initialWalk = q.originWalk.get(parts[0].boardNode) ?? 0;
    const p0 = parts[0];
    const departure = q.s.callDep[q.s.base[p0.trip] + p0.i] - initialWalk * 1000;
    out.push({ parts, initialWalk, finalWalk: r.Dw[di], departure, arrival: t, changes: parts.filter((p) => p.kind !== K_SEATED).length - 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- validation (gate C)
let stationSecCache: { n: number; map: Map<number, number> } | undefined;
function stationPublishedSec(station: number) {
  if (!stationSecCache || stationSecCache.n !== pairSec.size) {
    const map = new Map<number, number>();
    for (const [k, sec] of pairSec) {
      const a = Math.floor(k / 2_097_152);
      const b = k % 2_097_152;
      const sa = stationIndex(quayStation[a]);
      if (sa !== undefined && sa === stationIndex(quayStation[b])) map.set(sa, Math.max(map.get(sa) ?? 0, sec));
    }
    stationSecCache = { n: pairSec.size, map };
  }
  return stationSecCache.map.get(station) ?? 0;
}
/** The minimum seconds from alighting trip A at node na to boarding trip B at node nb, by GTFS precedence: a rule for
 *  exactly these two trips at these quays, then the stop-pair row, then the Swiss default inside one stop; the twin's
 *  buses (no quay) at a station take the bus transfer time. Infinity when no transfer exists. Written apart from the
 *  search's indexes on purpose: validate() replays a witness with it. */
function transferSec(s: Snapshot, A: number, na: number, B: number, nb: number) {
  const tA = s.trips[A];
  const tB = s.trips[B];
  for (const r of rulesFrom.get(tA.tripId) ?? []) {
    if (r.toTrip !== tB.tripId || r.fromQuay !== na || r.toQuay !== nb || r.type === 4) continue;
    if (r.dates && !r.dates.includes(tA.serviceDate)) continue;
    if (r.type === 3) return Infinity;
    return r.type === 1 ? 0 : r.sec;
  }
  const sa = s.nodeStation[na];
  const sb = s.nodeStation[nb];
  if (na >= s.nQ || nb >= s.nQ) return sa === sb && sa >= 0 ? Math.max(TWIN_BUS_TRANSFER_SEC, stationPublishedSec(sa)) : Infinity;
  const p = pairSec.get(pairKey(na, nb));
  if (p !== undefined) return p;
  return sa === sb && sa >= 0 ? DEFAULT_TRANSFER_SEC : Infinity;
}
function walkFrom(station: number, node: number) {
  if (stationIndex(quayStation[node] ?? "") === station) return 0;
  let best = Infinity;
  for (const qa of quaysOfIdx(station)) {
    const p = pairSec.get(pairKey(qa, node));
    if (p !== undefined) best = Math.min(best, p);
  }
  return best;
}
function walkTo(node: number, station: number) {
  if (stationIndex(quayStation[node] ?? "") === station) return 0;
  let best = Infinity;
  for (const qd of quaysOfIdx(station)) {
    const p = pairSec.get(pairKey(node, qd));
    if (p !== undefined) best = Math.min(best, p);
  }
  return best;
}
const quaysOfIdx = (station: number) => quaysOf(stops[station].id);
/** Replay a witness on its snapshot: endpoints, every boarding and alighting permission, served calls, every leg
 *  against the closures in time, transfer and walking times, monotonic times, changes, via. Returns what is wrong. */
function validate(q: Query, w: Witness, tau: number): string | null {
  const s = q.s;
  const node = (T: number, i: number) => s.callNode[s.base[T] + i];
  const first = w.parts[0];
  const last = w.parts[w.parts.length - 1];
  const nodeSt = (n: number) => s.nodeStation[n];
  const initial = nodeSt(first.boardNode) === q.origin ? 0 : first.boardNode < s.nQ ? walkFrom(q.origin, first.boardNode) : Infinity;
  if (initial !== w.initialWalk) return `initial walk ${w.initialWalk} s, published ${initial} s`;
  const final = nodeSt(last.alightNode) === q.dest ? 0 : last.alightNode < s.nQ ? walkTo(last.alightNode, q.dest) : Infinity;
  if (final !== w.finalWalk) return `final walk ${w.finalWalk} s, published ${final} s`;
  let ready = tau + w.initialWalk * 1000;
  let changes = -1;
  let visited = q.mode !== 1 || q.origin === q.via;
  let crossed = q.mode !== 2;
  for (let k = 0; k < w.parts.length; k++) {
    const p = w.parts[k];
    const trip = s.trips[p.trip];
    const e = s.eff[p.trip];
    const route = s.route[p.trip];
    const n = trip.stops.length;
    if (e.cancelled) return `${trip.trainId} is cancelled`;
    if (!(p.i >= 0 && p.i < p.j && p.j <= n - 1)) return `${trip.trainId}: calls ${p.i}..${p.j}`;
    if (p.i < Math.max(e.from, e.firstServed) || p.j > e.lastServed) return `${trip.trainId} does not serve calls ${p.i}..${p.j}`;
    if (node(p.trip, p.i) !== p.boardNode || node(p.trip, p.j) !== p.alightNode) return `${trip.trainId}: quays differ`;
    const seated = p.kind === K_SEATED;
    const nextSeated = w.parts[k + 1]?.kind === K_SEATED;
    if (!seated && (e.skipped?.[p.i] || (route && route.pickup[p.i] !== 0))) return `${trip.trainId}: no boarding at ${stops[trip.stops[p.i]].name}`;
    if (!nextSeated && (e.skipped?.[p.j] || (route && route.dropOff[p.j] !== 0))) return `${trip.trainId}: no alighting at ${stops[trip.stops[p.j]].name}`;
    const dep = e.dep[p.i];
    if (k === 0 && dep < ready) return `${trip.trainId} leaves before the passenger is there`;
    if (k > 0) {
      const prev = w.parts[k - 1];
      const arrPrev = s.eff[prev.trip].arr[prev.j];
      if (seated) {
        const ok = (rulesFrom.get(s.trips[prev.trip].tripId) ?? []).some((r) => r.type === 4 && r.toTrip === trip.tripId && r.fromQuay === prev.alightNode && r.toQuay === p.boardNode && (!r.dates || r.dates.includes(s.trips[prev.trip].serviceDate)));
        if (!ok) return `no published stay-seated continuation ${s.trips[prev.trip].trainId} -> ${trip.trainId}`;
        if (dep < arrPrev) return `stay-seated continuation leaves before arrival`;
      } else {
        const need = transferSec(s, prev.trip, prev.alightNode, p.trip, p.boardNode);
        if (!Number.isFinite(need)) return `no transfer ${stops[nodeSt(prev.alightNode)]?.name} -> ${stops[nodeSt(p.boardNode)]?.name}`;
        if (dep < arrPrev + need * 1000) return `transfer to ${trip.line} at ${stops[nodeSt(p.boardNode)]?.name}: ${(dep - arrPrev) / 1000} s for ${need} s`;
      }
    }
    if (!seated) changes++;
    for (let c = p.i; c < p.j; c++) {
      if (e.arr[c + 1] < e.dep[c] || e.dep[c + 1] < e.arr[c + 1]) return `${trip.trainId}: times not monotonic at call ${c}`;
      if (trip.cat !== "EV") {
        const st = legState(s.closures.map((x) => ({ ...x, pairs: undefined })), trip.stops[c], trip.stops[c + 1], e.dep[c], e.arr[c + 1]);
        if (st & BLOCKED) return `${trip.trainId} runs on a closed section between ${stops[trip.stops[c]].name} and ${stops[trip.stops[c + 1]].name}`;
        if (q.certain && st & CONDITIONAL) return `${trip.trainId} relies on an unconfirmed reopening`;
        if (st & (CONDITIONAL | AFTER_REOPENING)) crossed = true;
      }
    }
    if (q.mode === 1) for (let c = p.i; c <= p.j; c++) if (trip.stops[c] === q.via && !e.skipped?.[c]) visited = true;
    if (q.mode === 1 && (nodeSt(p.boardNode) === q.via || nodeSt(p.alightNode) === q.via)) visited = true;
  }
  if (changes !== w.changes) return `changes ${w.changes}, counted ${changes}`;
  if (changes > q.L - 1) return `${changes} changes, at most ${q.L - 1}`;
  if (!visited) return `does not go through the via station`;
  if (!crossed) return `does not use the reopened section`;
  const arrival = s.eff[last.trip].arr[last.j] + w.finalWalk * 1000;
  if (arrival !== w.arrival) return `arrival ${arrival} != ${w.arrival}`;
  return null;
}

// ---------------------------------------------------------------------------------------------- journeys
const journeys = new Map<string, { at: number; journey: Journey; snapshotId: string; rides: { trip: Trip; i: number; j: number; arr: number[]; dep: number[]; served: boolean[]; platforms: (string | undefined)[] }[] }>();
const place = (k: number): Place => ({ id: stops[k].id, name: stops[k].name, lon: stops[k].lon, lat: stops[k].lat });
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const platformOf = (s: Snapshot, node: number) => (node < s.nQ ? quayPlatform[node] || undefined : undefined);

function legIncidents(trainId: string, stationIds: Set<string>) {
  const out: Leg["incidents"] = [];
  for (const i of incidents.values()) {
    const sc = i.scope as { kind: string; trainId?: string; from?: string; to?: string; station?: string };
    const hit = i.trainIds?.includes(trainId) || sc.trainId === trainId || (sc.kind === "section" && stationIds.has(sc.from!) && stationIds.has(sc.to!)) || (sc.kind === "station" && stationIds.has(sc.station!));
    if (hit) out.push({ id: i.id, title: i.title, severity: i.severity, source: i.source ?? "staff" });
  }
  for (const a of alertsState.alerts.values()) if (a.trainIds.includes(trainId) || a.stations.filter((s) => stationIds.has(s.id)).length >= 2) out.push({ id: a.id, title: a.title, severity: a.severity, source: "sbb" });
  return out;
}
const walkLeg = (from: number, to: number, plannedDep: number, expectedDep: number, sec: number): WalkLeg => ({
  type: "walk",
  from: { ...place(from), plannedDep, expectedDep },
  to: { ...place(to), plannedArr: plannedDep + sec * 1000, expectedArr: expectedDep + sec * 1000 },
  durationSec: sec,
  trainId: null,
  line: "Walk",
  category: "WALK",
  headsign: stops[to].name,
  stopsBetween: 0,
  delaySec: 0,
  status: "on time",
  incidents: [],
});
const hhmm = (ms: number) => zurich(ms).time.slice(0, 5);
function toJourney(q: Query, w: Witness, kind: Journey["kind"]): Journey {
  const s = q.s;
  const legs: AnyLeg[] = [];
  const warnings: string[] = [];
  let uncertain = false;
  let waits = false;
  const p0 = w.parts[0];
  const t0 = s.trips[p0.trip];
  const st0 = s.nodeStation[p0.boardNode];
  if (w.initialWalk > 0 || st0 !== q.origin) legs.push(walkLeg(q.origin, st0, t0.dep[p0.i] - w.initialWalk * 1000, s.callDep[s.base[p0.trip] + p0.i] - w.initialWalk * 1000, w.initialWalk));
  w.parts.forEach((p, k) => {
    const trip = s.trips[p.trip];
    const e = s.eff[p.trip];
    if (k > 0) {
      const prev = w.parts[k - 1];
      const sa = s.nodeStation[prev.alightNode];
      const sb = s.nodeStation[p.boardNode];
      if (sa !== sb) {
        const sec = transferSec(s, prev.trip, prev.alightNode, p.trip, p.boardNode);
        legs.push(walkLeg(sa, sb, s.trips[prev.trip].arr[prev.j], s.eff[prev.trip].arr[prev.j], sec));
      }
    }
    const delaySec = Math.round((e.arr[p.j] - trip.arr[p.j]) / 1000);
    const ids = new Set<string>();
    for (let c = p.i; c <= p.j; c++) ids.add(stops[trip.stops[c]].id);
    let note: string | undefined;
    if (trip.cat !== "EV")
      for (let c = p.i; c < p.j; c++) {
        const hitBy: string[] = [];
        const st = legState(s.closures, trip.stops[c], trip.stops[c + 1], e.dep[c], e.arr[c + 1], hitBy);
        if (!(st & (CONDITIONAL | AFTER_REOPENING))) continue;
        waits = true;
        if (st & CONDITIONAL) uncertain = true;
        for (const id of hitBy) {
          const cl = s.closures.find((x) => x.id === id);
          if (!cl) continue;
          const text = cl.reopen === null ? `${cl.where}: no reopening time is known` : `${cl.where} reopens ${cl.sure ? "about" : "at the earliest"} ${hhmm(cl.reopen)}`;
          note ??= text;
          if (!warnings.includes(text)) warnings.unshift(text);
        }
      }
    legs.push({
      type: "ride",
      trainId: trip.trainId,
      line: trip.line,
      category: trip.cat,
      headsign: e.lastServed < trip.stops.length - 1 ? stops[trip.stops[e.lastServed]].name : trip.head,
      from: { ...place(trip.stops[p.i]), plannedDep: trip.dep[p.i], expectedDep: e.dep[p.i], ...(platformOf(s, p.boardNode) ? { platform: platformOf(s, p.boardNode) } : {}) },
      to: { ...place(trip.stops[p.j]), plannedArr: trip.arr[p.j], expectedArr: e.arr[p.j], ...(platformOf(s, p.alightNode) ? { platform: platformOf(s, p.alightNode) } : {}) },
      stopsBetween: p.j - p.i - 1,
      delaySec,
      status: e.held ? "held" : delaySec >= 180 ? "late" : "on time",
      incidents: legIncidents(trip.trainId, ids),
      ...(note ? { note } : {}),
      ...(p.kind === K_SEATED ? { staySeated: true } : {}),
    });
  });
  const pl = w.parts[w.parts.length - 1];
  const stL = s.nodeStation[pl.alightNode];
  if (w.finalWalk > 0 || stL !== q.dest) legs.push(walkLeg(stL, q.dest, s.trips[pl.trip].arr[pl.j], s.eff[pl.trip].arr[pl.j], w.finalWalk));
  for (const l of legs) {
    if (l.type !== "ride") continue;
    if (l.category === "EV") warnings.push(`Replacement bus (EV) from ${l.from.name} to ${l.to.name}`);
    if (l.staySeated) warnings.push(`Stay on board at ${l.from.name}: the train continues as ${l.line} to ${l.headsign}`);
    if (l.status === "held") warnings.push(`${l.line} to ${l.headsign} is stopped at the moment`);
    else if (l.status === "late") warnings.push(`${l.line} to ${l.headsign} is about ${Math.round(l.delaySec / 60)} min late`);
    for (const inc of l.incidents) if (!warnings.includes(inc.title)) warnings.push(inc.title);
  }
  const first = legs[0];
  const last = legs[legs.length - 1];
  const key = legs.map((l) => (l.type === "ride" ? `${l.trainId}:${l.from.id}>${l.to.id}` : `walk:${l.from.id}>${l.to.id}`)).join("|");
  const j: Journey = {
    id: `j-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
    departure: first.from.expectedDep,
    arrival: last.to.expectedArr,
    plannedDeparture: first.from.plannedDep,
    plannedArrival: last.to.plannedArr,
    durationMin: Math.round((last.to.expectedArr - first.from.expectedDep) / 60_000),
    transfers: w.changes,
    arrivalDelayMin: Math.max(0, Math.round((last.to.expectedArr - last.to.plannedArr) / 60_000)),
    warnings,
    legs,
    kind,
    snapshotId: s.id,
  };
  if (uncertain) j.uncertain = true;
  if (waits) j.waitsForReopening = true;
  j.corridor = legs.filter((l): l is Leg => l.type === "ride").slice(1).filter((l) => !l.staySeated).map((l) => l.from.name);
  return j;
}
function remember(q: Query, w: Witness, j: Journey, t: number) {
  const s = q.s;
  journeys.set(j.id, {
    at: t,
    journey: j,
    snapshotId: s.id,
    rides: w.parts.map((p) => {
      const e = s.eff[p.trip];
      const trip = s.trips[p.trip];
      const arr: number[] = [];
      const dep: number[] = [];
      const servedCalls: boolean[] = [];
      const platforms: (string | undefined)[] = [];
      for (let c = p.i; c <= p.j; c++) {
        arr.push(Math.round(e.arr[c]));
        dep.push(Math.round(e.dep[c]));
        servedCalls.push(!e.skipped?.[c] && c >= e.firstServed && c <= e.lastServed);
        platforms.push(platformOf(s, s.callNode[s.base[p.trip] + c]));
      }
      return { trip, i: p.i, j: p.j, arr, dep, served: servedCalls, platforms };
    }),
  });
}

// ---------------------------------------------------------------------------------------------- planning
/** How far ahead to search: 6 hours, and at night until 08:00 the next morning. */
function horizonFor(after: number) {
  const z = zurich(after);
  const hour = Number(z.time.slice(0, 2));
  if (hour >= 20) return Math.max(after + HORIZON_MS, serviceOrigin(addDay(z.date)) + 8 * 3600_000);
  if (hour < 5) return Math.max(after + HORIZON_MS, serviceOrigin(z.date) + 8 * 3600_000);
  return after + HORIZON_MS;
}
const addDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
function endpoints(s: Snapshot, origin: number, dest: number) {
  const originWalk = new Map<number, number>();
  const destWalk = new Map<number, number>();
  const put = (m: Map<number, number>, n: number, sec: number) => {
    const old = m.get(n);
    if (old === undefined || sec < old) m.set(n, sec);
  };
  for (const n of s.stationNodes.get(origin) ?? []) put(originWalk, n, 0);
  for (const qa of quaysOfIdx(origin)) for (const w of pairsFrom.get(qa) ?? []) if (w < s.nQ && s.used[w] && s.nodeStation[w] !== origin) put(originWalk, w, pairSec.get(pairKey(qa, w))!);
  for (const n of s.stationNodes.get(dest) ?? []) put(destWalk, n, 0);
  for (const qd of quaysOfIdx(dest)) for (const w of pairsTo.get(qd) ?? []) if (w < s.nQ && s.used[w] && s.nodeStation[w] !== dest) put(destWalk, w, pairSec.get(pairKey(w, qd))!);
  return { originWalk, destWalk };
}
const beats = (k: Journey, j: Journey) => k !== j && k.departure >= j.departure && k.arrival <= j.arrival && k.transfers <= j.transfers && (k.arrival < j.arrival || k.transfers < j.transfers || k.departure > j.departure);
const lexi = (a: Journey, b: Journey) => a.arrival - b.arrival || a.transfers - b.transfers || b.departure - a.departure;
export type PlanOptions = { maxTransfers?: number; via?: string; includeWait?: boolean; quick?: boolean };
/** Journeys from one station to another, ranked by arrival, then changes, then the latest departure (to the second).
 *  Options: at most `maxTransfers` changes (0 = direct only; default 3, up to 4), `via` a hub to go through (staying
 *  aboard counts), `includeWait` the journeys through an interrupted section after it reopens. At night the search
 *  reaches the first services of the next morning. Every journey is validated on its snapshot before it is returned. */
export function plan(fromQ: string, toQ: string, after = Date.now(), limit = 4, opts: PlanOptions = {}) {
  const t0 = performance.now();
  const from = resolveStation(fromQ);
  const to = resolveStation(toQ);
  if (from === undefined) return { error: `Unknown station: ${fromQ}` };
  if (to === undefined) return { error: `Unknown station: ${toQ}` };
  const via = opts.via ? resolveStation(opts.via) : undefined;
  if (opts.via && via === undefined) return { error: `Unknown station: ${opts.via}` };
  const maxTransfers = Math.max(0, Math.min(4, Math.round(Number.isFinite(opts.maxTransfers) ? opts.maxTransfers! : 3)));
  const t = Date.now();
  const s = snapshot(t);
  const tSearch = performance.now(); // the search budget starts once the snapshot is there
  const { originWalk, destWalk } = endpoints(s, from, to);
  const horizon = horizonFor(after);
  // the loaded service days: today's file (with the trips of earlier days still running) and the next day's
  const days = [timetableDate(), nextDay?.trips.length ? nextDay.date : ""].filter(Boolean);
  const coverFrom = days.length ? serviceOrigin(days[0]) : Infinity;
  if (!Number.isFinite(after) || after < coverFrom || after > s.until)
    return { error: `Outside the loaded timetable: ${Number.isFinite(after) ? `${zurich(after).date} ${zurich(after).time.slice(0, 5)}` : String(after)} (the twin has the service days ${days.join(" and ")}, until ${zurich(s.until).date} ${hhmm(s.until)})` };
  const incomplete = [...s.incomplete];
  if (horizon > s.until) incomplete.push(`the timetable ends at ${zurich(s.until).date} ${hhmm(s.until)}: later journeys are not searched`);
  const base: Query = { s, origin: from, dest: to, L: maxTransfers + 1, mode: via !== undefined ? 1 : 0, via: via ?? -1, certain: true, horizon, originWalk, destWalk };
  let searches = 0;
  let scanned = 0;
  const validation = { checked: 0, rejected: [] as string[] };
  const found = new Map<string, Journey>();
  /** The profile: scan, take the Pareto levels' witnesses, scan again just after the earliest departure found. */
  const profile = (q: Query, kind: Journey["kind"], want: number, rounds: number, budgetMs: number) => {
    const mine: Journey[] = [];
    let tau = after;
    for (let r = 0; r < rounds && (r === 0 || performance.now() - tSearch < budgetMs); r++) {
      const res = scan(q, tau);
      searches++;
      scanned += res.scanned;
      const ws = witnesses(q, res);
      if (!ws.length) break;
      let minDep = Infinity;
      let roundBest = Infinity;
      for (const w of ws) {
        minDep = Math.min(minDep, w.departure);
        roundBest = Math.min(roundBest, w.arrival);
        validation.checked++;
        const bad = validate(q, w, tau);
        if (bad) {
          validation.rejected.push(bad);
          console.warn(`[planner] rejected a witness ${stops[from].name} -> ${stops[to].name}: ${bad}`);
          continue;
        }
        const j = toJourney(q, w, kind);
        if (!found.has(j.id)) {
          found.set(j.id, j);
          mine.push(j);
          remember(q, w, j, t);
        }
      }
      if (!Number.isFinite(minDep)) break;
      tau = Math.floor(minDep / 1000) * 1000 + 1000; // the next option leaves at least a second later
      const nd = mine.filter((j) => !mine.some((k) => beats(k, j))).sort(lexi);
      if (nd.length >= want && roundBest > nd[want - 1].arrival) break;
    }
    return mine;
  };
  const main = profile(base, via !== undefined ? "via" : "best", limit, opts.quick ? limit + 2 : limit * 3, 110);
  let conditionalOnly = false;
  let wait: Journey[] = [];
  const reopening = s.closures.length > 0;
  if (!main.length && reopening) {
    // nothing confirmed: the journeys that rely on a reopening at its lower bound, said so
    wait = profile({ ...base, certain: false }, "wait", 2, 3, 130);
    conditionalOnly = wait.length > 0;
  } else if (opts.includeWait && reopening && via === undefined) wait = profile({ ...base, mode: 2, certain: false }, "wait", 2, 3, 130);
  for (const j of wait) {
    j.kind = "wait";
    j.waitsForReopening = true;
  }
  for (const [id, v] of journeys) if (t - v.at > 30 * 60_000) journeys.delete(id);
  // keep the real choices: an option another one beats on every count goes, unless it uses a corridor no better
  // option uses (then it is kept, flagged dominated, after the others)
  const night = (() => {
    const ha = Number(zurich(after).time.slice(0, 2));
    return ha >= 20 || ha < 4;
  })();
  for (const j of [...main, ...wait]) {
    const h = Number(zurich(j.departure).time.slice(0, 2));
    if (night && j.departure - after > 2 * 3600_000 && h >= 4 && h < 10) j.nextServiceDay = true;
  }
  const certainMain = main.filter((j) => !j.uncertain);
  const nd = certainMain.filter((j) => !certainMain.some((k) => beats(k, j))).sort(lexi);
  const picked = nd.slice(0, limit);
  if (picked.length < limit) {
    const ways = new Set(picked.map((j) => j.corridor!.join(">")));
    for (const j of certainMain.filter((x) => !picked.includes(x)).sort(lexi)) {
      if (picked.length >= limit) break;
      const way = j.corridor!.join(">");
      if (ways.has(way)) continue;
      ways.add(way);
      j.dominated = true;
      picked.push(j);
    }
  }
  const waitKept = wait.filter((j) => !picked.some((k) => k.id === j.id)).sort(lexi).slice(0, 2);
  const out = [...picked.sort(lexi), ...waitKept];
  const pick = out.find((j) => !j.uncertain);
  for (const j of out) if (j === pick) j.fastest = true; else delete j.fastest;
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  return {
    from: place(from),
    to: place(to),
    generatedAt: t,
    snapshotId: s.id,
    snapshot: { id: s.id, builtAt: s.builtAt, ...s.meta },
    journeys: out,
    ...(conditionalOnly ? { allConditional: true, note: "Every journey found relies on a reopening that is not confirmed (at the earliest time announced)." } : {}),
    ...(!out.length && validation.rejected.length ? { unavailable: "The journeys found did not pass validation on the snapshot; plan again." } : {}),
    alternativesConsidered: found.size,
    corridorsConsidered: new Set([...found.values()].map((j) => j.corridor!.join(">"))).size,
    searches,
    connectionsScanned: scanned,
    maxTransfers,
    validation: { checked: validation.checked, rejected: validation.rejected.length, ...(validation.rejected.length ? { reasons: validation.rejected.slice(0, 3) } : {}) },
    endpoints: "the requested stations: a published walk to or from a nearby stop (a bus stop at the station) is a walk leg, included in the times",
    ...(incomplete.length ? { incomplete } : {}),
    ms,
    ...(via !== undefined ? { via: place(via) } : {}),
  };
}

/** The track a trip runs on between two of its stops, as a light LineString. */
export function tripGeometry(trip: Trip, i: number, j: number) {
  const coords: number[][] = [];
  for (let k = i; k < j; k++) {
    const p = travelPath(trip.cat, stops[trip.stops[k]], stops[trip.stops[k + 1]]);
    const n = p.coords.length / 2;
    for (let v = 0; v < n; v++) if (v % 4 === 0 || v === n - 1) coords.push([r5(p.coords[2 * v]), r5(p.coords[2 * v + 1])]);
  }
  return { type: "LineString" as const, coordinates: coords };
}
/** A planned journey with every stop of every ride (planned and expected times on the journey's snapshot, and whether
 *  the vehicle serves it), for step-by-step itineraries and printed reports. Walk legs as planned. */
export function journeyDetail(id: string) {
  const hit = journeys.get(id);
  if (!hit) return undefined;
  let r = 0;
  const legs = hit.journey.legs.map((leg) => {
    if (leg.type !== "ride") return leg;
    const { trip, i, j, arr, dep, served: sv, platforms } = hit.rides[r++];
    const calls = [];
    for (let c = i; c <= j; c++) {
      calls.push({
        id: stops[trip.stops[c]].id,
        name: stops[trip.stops[c]].name,
        plannedArr: c === i ? null : trip.arr[c],
        expectedArr: c === i ? null : arr[c - i],
        plannedDep: c === j ? null : trip.dep[c],
        expectedDep: c === j ? null : dep[c - i],
        served: sv[c - i],
        ...(platforms[c - i] ? { platform: platforms[c - i] } : {}),
      });
    }
    return { ...leg, calls };
  });
  return { ...hit.journey, snapshotId: hit.snapshotId, generatedAt: hit.at, legs };
}

export function journeyGeometry(id: string) {
  const hit = journeys.get(id);
  if (!hit) return null;
  let r = 0;
  return {
    id,
    legs: hit.journey.legs.map((l) => {
      if (l.type !== "ride") return { trainId: null, line: "Walk", geometry: { type: "LineString" as const, coordinates: [[r5(l.from.lon), r5(l.from.lat)], [r5(l.to.lon), r5(l.to.lat)]] } };
      const p = hit.rides[r++];
      return { trainId: l.trainId, line: l.line, geometry: tripGeometry(p.trip, p.i, p.j) };
    }),
  };
}
export function trainGeometry(trainId: string, fromQ?: string, toQ?: string) {
  const trip = byTrainId.get(trainId)?.trip ?? dayTrips().find((x) => x.trainId === trainId);
  if (!trip) return null;
  const stopIdx = (q?: string) => {
    const k = resolveStation(q);
    return k === undefined ? -1 : trip.stops.indexOf(k);
  };
  const i = fromQ ? stopIdx(fromQ) : 0;
  const j = toQ ? stopIdx(toQ) : trip.stops.length - 1;
  if (i < 0 || j < 0 || j <= i) return null;
  return { trainId, geometry: tripGeometry(trip, i, j) };
}
export function sectionGeometry(fromQ: string, toQ: string) {
  const a = resolveStation(fromQ);
  const b = resolveStation(toQ);
  if (a === undefined || b === undefined) return null;
  const edges = sectionEdges(stops[a], stops[b]);
  return { from: place(a), to: place(b), geometry: edges.size ? edgesGeometry(edges) : { type: "LineString", coordinates: [[stops[a].lon, stops[a].lat], [stops[b].lon, stops[b].lat]] } };
}

/** What a passenger at a station, on a train, or going from A to B should know right now. */
export function situation(q: { station?: string; trainId?: string; from?: string; to?: string }) {
  const t = Date.now();
  const brief = (i: Incident) => ({
    id: i.id,
    title: i.title,
    where: i.where,
    severity: i.severity,
    source: i.source ?? "staff",
    since: i.createdAt,
    trainIds: i.trainIds ?? [],
    ...(i.source === "control" ? { description: i.description, lines: i.lines, until: i.until, durationType: i.durationType, lifecycle: i.lifecycle, bulletinVersion: i.bulletinVersion, messages: i.messages, replacementBus: i.replacementBus } : {}),
  });
  const atStation = (k: number) => {
    const id = stops[k].id;
    const board = stationBoard(k, t, 90, 12);
    const boardTrains = new Set(board.map((b) => b.trainId).filter(Boolean) as string[]);
    return {
      station: place(k),
      incidents: [...incidents.values()]
        .filter((i) => {
          const sc = i.scope as { kind: string; station?: string; from?: string; to?: string; trainId?: string };
          return sc.station === id || sc.from === id || sc.to === id || (sc.trainId !== undefined && boardTrains.has(sc.trainId)) || (i.trainIds ?? []).some((x) => boardTrains.has(x));
        })
        .map(brief),
      alerts: [...alertsState.alerts.values()].filter((a) => a.stations.some((s) => s.id === id) || a.trainIds.some((x) => boardTrains.has(x))).map(({ trainIds, sourceIds, geometry, ...a }) => ({ ...a, trains: trainIds.length })),
      departures: board,
    };
  };
  if (q.trainId) {
    const tr = byTrainId.get(q.trainId);
    if (!tr) return { error: "Train not in service" };
    const ids = new Set<string>();
    for (let k = Math.max(0, tr.leg >= 0 ? tr.leg : tr.call); k < tr.trip.stops.length; k++) ids.add(stops[tr.trip.stops[k]].id);
    return {
      train: { trainId: tr.trip.trainId, line: tr.trip.line, headsign: tr.trip.head, mode: tr.mode === "sim" ? "affected" : "normal", speedKmh: Math.round(tr.speed * 3.6), stopped: tr.speed < 0.5, atStation: tr.leg < 0 ? stops[tr.trip.stops[tr.call]].name : null, between: tr.leg >= 0 ? [stops[tr.trip.stops[tr.leg]].name, stops[tr.trip.stops[tr.leg + 1]].name] : null, lon: tr.lon, lat: tr.lat },
      incidents: legIncidents(tr.trip.trainId, ids),
    };
  }
  if (q.from && q.to) {
    const a = resolveStation(q.from);
    const b = resolveStation(q.to);
    if (a === undefined || b === undefined) return { error: "Unknown station" };
    const p = plan(q.from, q.to, t, 2);
    return { from: atStation(a), to: atStation(b), onTheWay: [...new Set(("error" in p ? [] : p.journeys).flatMap((j) => j.warnings))] };
  }
  const k = resolveStation(q.station);
  if (k === undefined) return { error: "Unknown station" };
  return atStation(k);
}
