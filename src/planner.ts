// Journey planner on the twin's live state: today's timetable with the live predictions, held, slowed and cancelled
// trains, skipped stops, closed stations and closed sections. Connection Scan (earliest arrival), repeated with later
// departures to offer the real alternatives (wait for the next train, another route). Plus what a passenger at a
// place should know (situation) and the track geometry to draw a journey.
import { createHash } from "node:crypto";
import { dayTrips, liveTimes, nextDate, servedStations, stationBoard, byTrainId, timetableDate } from "./engine.ts";
import { loadDayMapped, searchStations, stationIndex, stops, type Trip } from "./timetable.ts";
import { edgesGeometry, metres, sectionEdges, travelPath } from "./geometry.ts";
import { addDays, serviceOrigin, zurich } from "./time.ts";
import { expectedEnd, isScenario } from "./scenario.ts";
import { disruptions, effective, incidents, type Incident } from "./disruptions.ts";
import { alertsState } from "./alerts.ts";

const TRANSFER_MS = 4 * 60_000;
const HORIZON_MS = 6 * 3600_000;

type Place = { id: string; name: string; lon: number; lat: number };
export type Leg = {
  trainId: string;
  line: string;
  category: string;
  headsign: string;
  from: Place & { plannedDep: number; expectedDep: number };
  to: Place & { plannedArr: number; expectedArr: number };
  stopsBetween: number;
  delaySec: number;
  status: "on time" | "late" | "held";
  incidents: { id: string; title: string; severity: string; source: string }[];
  note?: string; // e.g. the reopening a "wait" journey relies on
};
export type Journey = {
  id: string;
  departure: number;
  arrival: number;
  plannedDeparture: number;
  plannedArrival: number;
  durationMin: number;
  transfers: number;
  arrivalDelayMin: number;
  warnings: string[];
  legs: Leg[];
  kind?: "best" | "via" | "wait"; // via: through the requested hub; wait: through the interrupted section after it reopens
  uncertain?: boolean; // relies on a reopening that is not confirmed (UNTIL_AT_LEAST or UNKNOWN)
  fastest?: boolean; // the pick to recommend: the earliest arrival that does not rely on an unconfirmed reopening
  nextServiceDay?: boolean; // the first services of the next morning
  corridor?: string[]; // the stations where it changes
  dominated?: boolean; // another option is better on every count, kept because it uses another corridor
  waitsForReopening?: boolean; // it goes through an interrupted section after the expected reopening
};
type Conn = { trip: number; i: number; dep: number; arr: number; from: number; to: number };
type Live = ReturnType<typeof liveTimes>;

const journeys = new Map<string, { at: number; journey: Journey; parts: { trip: Trip; i: number; j: number }[] }>();
const place = (k: number): Place => ({ id: stops[k].id, name: stops[k].name, lon: stops[k].lon, lat: stops[k].lat });
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

let served: Set<string> | undefined;
let servedDay = "";
export function resolveStation(q: string | undefined) {
  if (!q) return undefined;
  const direct = stationIndex(q.trim());
  if (direct !== undefined) return direct;
  // a station trains call at today, best match first (exact name, then prefix, then anywhere in the name)
  const day = String(dayTrips()[0]?.serviceDate ?? "");
  if (!served || servedDay !== day) {
    served = new Set(servedStations().map((s) => s.id));
    servedDay = day;
  }
  const hits = searchStations(q, 40);
  const hit = hits.find((s) => served!.has(s.id)) ?? hits[0];
  return hit ? stationIndex(hit.id) : undefined;
}

/** Sections closed now (with when they reopen) and closed stations. */
function closures() {
  const sections = [...disruptions.values()].filter((d) => !d.endedAt && d.effect === "section_closure" && d.edges.size);
  const stations = new Set([...disruptions.values()].filter((d) => !d.endedAt && d.effect === "station_closure" && d.station !== undefined).map((d) => d.station!));
  const memo = new Map<string, Set<number>>();
  const blocked = (a: number, b: number, at: number) => {
    if (!sections.length) return false;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    let edges = memo.get(key);
    if (!edges) memo.set(key, (edges = sectionEdges(stops[a], stops[b])));
    return sections.some((d) => (d.endsAt === null || at < d.endsAt) && [...edges!].some((e) => d.edges.has(e)));
  };
  return { blocked, stations };
}

// the connections of the effective timetable, shared by requests for a few seconds (until it is rebuilt)
let connCache: { gen: number; at: number; after: number; day: Trip[]; value: ReturnType<typeof buildConnections> } | undefined;
function connections(t: number, after: number) {
  const a = Math.floor(after / 30_000) * 30_000;
  const day = dayTrips(); // changes when buses are added or removed
  if (connCache && connCache.gen === effective.generation && connCache.day === day && t - connCache.at < 5000 && connCache.after === a) return connCache.value;
  const value = buildConnections(t, a);
  connCache = { gen: effective.generation, at: t, after: a, day, value };
  return value;
}
/** Keep the shared connections fresh so a journey request (and /api/brief) never waits for the build. */
export function warmPlanner() {
  const t = Date.now();
  connections(t, t);
}
// the next service day (the first morning services when somebody asks at night), loaded in the background
let nextDay: { date: string; trips: Trip[] } | undefined;
let nextLoading = "";
function ensureNextDay() {
  const date = nextDate();
  if (!timetableDate() || nextDay?.date === date || nextLoading === date) return;
  nextLoading = date;
  loadDayMapped(date)
    .then((trips) => (nextDay = { date, trips }))
    .catch(() => (nextDay = { date, trips: [] }))
    .finally(() => (nextLoading = ""));
}
/** How far ahead to search: 6 hours, and at night until 08:00 the next morning. */
function horizonFor(after: number) {
  const z = zurich(after);
  const hour = Number(z.time.slice(0, 2));
  if (hour >= 20) return Math.max(after + HORIZON_MS, serviceOrigin(addDays(z.date, 1)) + 8 * 3600_000);
  if (hour < 5) return Math.max(after + HORIZON_MS, serviceOrigin(z.date) + 8 * 3600_000);
  return after + HORIZON_MS;
}
function buildConnections(t: number, after: number) {
  ensureNextDay();
  const until = horizonFor(after);
  const trips = nextDay?.trips.length && until > serviceOrigin(nextDay.date) ? [...dayTrips(), ...nextDay.trips] : dayTrips();
  const lives: (Live | undefined)[] = new Array(trips.length);
  const conns: Conn[] = [];
  const { blocked } = closures();
  trips.forEach((trip, ti) => {
    const n = trip.stops.length;
    if (trip.dep[0] > until || trip.arr[n - 1] < after - 3 * 3600_000) return;
    const lt = liveTimes(trip, t);
    if (lt.cancelled) return;
    lives[ti] = lt;
    const road = trip.cat === "EV"; // replacement buses: rail closures do not stop them
    for (let i = lt.from; i < lt.lastServed; i++) {
      const dep = lt.dep[i];
      const arr = lt.arr[i + 1];
      if (dep > until) break;
      if (!road && blocked(trip.stops[i], trip.stops[i + 1], dep)) break; // it cannot get through: nothing further on this trip
      if (dep < after) continue;
      conns.push({ trip: ti, i, dep, arr, from: trip.stops[i], to: trip.stops[i + 1] });
    }
  });
  conns.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
  return { trips, lives, conns };
}

type Parts = { trip: number; i: number; j: number }[];
/** Connection scan with a bound on the trains used: for each number of trains (1..maxTrips) the earliest arrival,
 *  so a journey with fewer changes that arrives later is found too. Returns the options, fewest trains first. */
function search(lives: (Live | undefined)[], conns: Conn[], from: number, to: number, after: number, closed: Set<number>, maxTrips: number) {
  const K = maxTrips;
  const best: Map<number, number>[] = Array.from({ length: K + 1 }, () => new Map());
  const how: Map<number, { trip: number; board: number; alight: number; prev: number }>[] = Array.from({ length: K + 1 }, () => new Map());
  best[0].set(from, after);
  const boarded = new Map<number, { k: number; board: number }>(); // trip -> fewest trains it can be the last of
  // first connection at or after `after` (they are sorted by departure)
  let lo = 0;
  let hi = conns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (conns[mid].dep < after) lo = mid + 1;
    else hi = mid;
  }
  for (let x = lo; x < conns.length; x++) {
    const c = conns[x];
    // stop once no option can improve: past the arrival with one train, or far past the earliest arrival (options
    // arriving more than 90 minutes after the earliest are not offered)
    if (c.dep > Math.min(best[1].get(to) ?? Infinity, (best[K].get(to) ?? Infinity) + 90 * 60_000)) break;
    const lt = lives[c.trip]!;
    let tk = boarded.get(c.trip);
    if (!lt.skipped[c.i] && !closed.has(c.from))
      for (let q = 0; q < K && (!tk || q + 1 < tk.k); q++) {
        const at = best[q].get(c.from);
        if (at === undefined) continue;
        if ((q === 0 ? at : at + TRANSFER_MS) > c.dep) continue;
        tk = { k: q + 1, board: x };
        boarded.set(c.trip, tk);
        break;
      }
    if (!tk) continue;
    if (lt.skipped[c.i + 1] || closed.has(c.to)) continue; // passes without stopping
    for (let q = tk.k; q <= K; q++) {
      if (c.arr >= (best[q].get(c.to) ?? Infinity)) break;
      best[q].set(c.to, c.arr);
      how[q].set(c.to, { trip: c.trip, board: tk.board, alight: x, prev: tk.k - 1 });
    }
  }
  const out: Parts[] = [];
  let last = Infinity;
  for (let q = 1; q <= K; q++) {
    const arr = best[q].get(to);
    if (arr === undefined || arr >= last) continue;
    last = arr;
    const parts: Parts = [];
    let s = to;
    let k = q;
    for (let guard = 0; s !== from && guard < K + 1 && k > 0; guard++) {
      const h = how[k].get(s);
      if (!h) break;
      parts.unshift({ trip: h.trip, i: conns[h.board].i, j: conns[h.alight].i + 1 });
      s = conns[h.board].from;
      k = h.prev;
    }
    if (s === from && parts.length) out.push(parts);
  }
  return out;
}

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

function toJourney(trips: Trip[], lives: (Live | undefined)[], parts: { trip: number; i: number; j: number }[]): Journey {
  const legs: Leg[] = parts.map(({ trip: ti, i, j }) => {
    const trip = trips[ti];
    const lt = lives[ti]!;
    const delaySec = Math.round((lt.arr[j] - trip.arr[j]) / 1000);
    const held = lt.train && ((lt.train.mode === "sim" && lt.train.speed < 0.5 && lt.train.leg >= 0) || lt.train.motion === "held");
    const ids = new Set<string>();
    for (let k = i; k <= j; k++) ids.add(stops[trip.stops[k]].id);
    return {
      trainId: trip.trainId,
      line: trip.line,
      category: trip.cat,
      headsign: trip.head,
      from: { ...place(trip.stops[i]), plannedDep: trip.dep[i], expectedDep: lt.dep[i] },
      to: { ...place(trip.stops[j]), plannedArr: trip.arr[j], expectedArr: lt.arr[j] },
      stopsBetween: j - i - 1,
      delaySec,
      status: held ? "held" : delaySec >= 180 ? "late" : "on time",
      incidents: legIncidents(trip.trainId, ids),
    };
  });
  const first = legs[0];
  const last = legs[legs.length - 1];
  const warnings: string[] = [];
  for (const l of legs) {
    if (l.category === "EV") warnings.push(`Replacement bus (EV) from ${l.from.name} to ${l.to.name}`);
    if (l.status === "held") warnings.push(`${l.line} to ${l.headsign} is stopped at the moment`);
    else if (l.status === "late") warnings.push(`${l.line} to ${l.headsign} is about ${Math.round(l.delaySec / 60)} min late`);
    for (const inc of l.incidents) if (!warnings.includes(inc.title)) warnings.push(inc.title);
  }
  const key = legs.map((l) => `${l.trainId}:${l.from.id}>${l.to.id}`).join("|");
  return {
    id: `j-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
    departure: first.from.expectedDep,
    arrival: last.to.expectedArr,
    plannedDeparture: first.from.plannedDep,
    plannedArrival: last.to.plannedArr,
    durationMin: Math.round((last.to.expectedArr - first.from.expectedDep) / 60_000),
    transfers: legs.length - 1,
    arrivalDelayMin: Math.max(0, Math.round((last.to.expectedArr - last.to.plannedArr) / 60_000)),
    warnings,
    legs,
  };
}

/** A journey through an interrupted section (a train held for it, or one after the reopening) depends on the
 *  reopening: say when, and flag it uncertain unless the end is confirmed (UNTIL). */
function annotate(j: Journey, parts: Parts, trips: Trip[], t: number) {
  parts.forEach((p, n) => {
    const trip = trips[p.trip];
    if (trip.cat === "EV") return; // a replacement bus runs because of the closure: it does not wait for the reopening
    const calls = Array.from(trip.stops.slice(p.i, p.j + 1)).map((k) => stops[k].id);
    for (const d of disruptions.values()) {
      if (!isScenario(d) || d.endedAt || d.effect !== "section_closure" || !d.scenario.b) continue;
      if (!(calls.includes(d.scenario.a) && calls.includes(d.scenario.b))) continue;
      const end = expectedEnd(d, t);
      const sure = d.scenario.durationType === "UNTIL" && end !== null;
      const note = end === null ? `${d.where}: no reopening time is known` : `${d.where} reopens ${sure ? "about" : "at the earliest"} ${zurich(end).time.slice(0, 5)}`;
      j.waitsForReopening = true;
      if (!sure) j.uncertain = true;
      j.legs[n].note ??= note;
      if (!j.warnings.includes(note)) j.warnings.unshift(note);
    }
  });
}
export type PlanOptions = { maxTransfers?: number; via?: string; includeWait?: boolean; quick?: boolean };
const corridorOf = (j: Journey) => j.legs.slice(1).map((l) => l.from.name);
/** The best journeys from one station to another, earliest arrival first. Options: at most `maxTransfers` changes
 *  (default 3, up to 4), `via` a hub to go through, `includeWait` the journey that waits for an interrupted section
 *  to reopen. At night the search reaches the first services of the next morning. */
export function plan(fromQ: string, toQ: string, after = Date.now(), limit = 4, opts: PlanOptions = {}) {
  const from = resolveStation(fromQ);
  const to = resolveStation(toQ);
  if (from === undefined) return { error: `Unknown station: ${fromQ}` };
  if (to === undefined) return { error: `Unknown station: ${toQ}` };
  const via = opts.via ? resolveStation(opts.via) : undefined;
  if (opts.via && via === undefined) return { error: `Unknown station: ${opts.via}` };
  const maxTrips = Math.max(1, Math.min(4, Math.round(opts.maxTransfers ?? 3))) + 1;
  const t = Date.now();
  const { trips, lives, conns } = connections(t, Math.min(after, t + HORIZON_MS));
  const { stations: closed } = closures();
  let searches = 0;
  const run = (a: number, b: number, at: number, k: number) => {
    searches++;
    return search(lives, conns, a, b, at, closed, k);
  };
  /** Through a list of stations in order (via, or a section to wait for), each step with the trains left. */
  const chain = (points: number[], at: number, budget: number, onlyDirect?: [number, number]): Parts | null => {
    let parts: Parts = [];
    let time = at;
    for (let p = 0; p < points.length - 1; p++) {
      const direct = onlyDirect && points[p] === onlyDirect[0] && points[p + 1] === onlyDirect[1];
      const left = budget - parts.length - (points.length - 2 - p);
      if (left < 1) return null;
      const found = run(points[p], points[p + 1], p === 0 ? time : time + TRANSFER_MS, direct ? 1 : left);
      if (!found.length) return null;
      const seg = found[found.length - 1]; // earliest arrival within the budget
      parts = [...parts, ...seg];
      time = lives[seg[seg.length - 1].trip]!.arr[seg[seg.length - 1].j];
    }
    return parts.length ? parts : null;
  };
  const found: Journey[] = [];
  const seen = new Set<string>();
  const arrivalOf = (parts: Parts) => lives[parts[parts.length - 1].trip]!.arr[parts[parts.length - 1].j];
  const departureOf = (parts: Parts) => lives[parts[0].trip]!.dep[parts[0].i];
  /** The same arrival, leaving as late as possible (no point waiting hours at a change at night). */
  const leaveLater = (parts: Parts): Parts => {
    const arr = arrivalOf(parts);
    let lo = departureOf(parts) + 60_000;
    let hi = arr;
    let bestParts = parts;
    for (let it = 0; it < 9 && hi - lo > 120_000; it++) {
      const mid = Math.floor((lo + hi) / 2);
      const opt = run(from, to, mid, Math.max(parts.length, 1)).filter((p) => arrivalOf(p) <= arr);
      if (opt.length) {
        bestParts = opt[opt.length - 1];
        lo = departureOf(bestParts) + 60_000;
      } else hi = mid;
    }
    return bestParts;
  };
  const add = (parts: Parts, kind: Journey["kind"], extra: Partial<Journey> = {}) => {
    const j = { ...toJourney(trips, lives, parts), kind, ...extra };
    annotate(j, parts, trips, t);
    j.corridor = corridorOf(j);
    const h = zurich(j.departure).time.slice(0, 2);
    const ha = Number(zurich(after).time.slice(0, 2));
    if (j.departure - after > 2 * 3600_000 && Number(h) >= 4 && Number(h) < 10 && (ha >= 20 || ha < 4)) j.nextServiceDay = true;
    if (seen.has(j.id)) return j;
    seen.add(j.id);
    found.push(j);
    journeys.set(j.id, { at: t, journey: j, parts: parts.map((p) => ({ trip: trips[p.trip], i: p.i, j: p.j })) });
    return j;
  };
  // the best options, then later departures
  let from_t = after;
  for (let round = 0; round < limit * 2 && found.length < limit * 2; round++) {
    const options = via === undefined ? run(from, to, from_t, maxTrips) : [chain([from, via, to], from_t, maxTrips)].filter((x): x is Parts => x !== null);
    if (!options.length) break;
    let first = Infinity;
    for (const parts of options) {
      first = Math.min(first, departureOf(parts));
      add(parts, via === undefined ? "best" : "via");
      if (via === undefined && !opts.quick && arrivalOf(parts) - departureOf(parts) > 3 * 3600_000) add(leaveLater(parts), "best"); // a long night wait somewhere: leave later
    }
    from_t = first + 60_000; // the next option leaves later
  }
  // waiting for an interrupted section on the way to reopen
  if (opts.includeWait) {
    const direct = metres(stops[from].lon, stops[from].lat, stops[to].lon, stops[to].lat);
    for (const d of disruptions.values()) {
      if (!isScenario(d) || d.endedAt || d.effect !== "section_closure" || !d.scenario.b) continue;
      const a = stationIndex(d.scenario.a)!;
      const b = stationIndex(d.scenario.b)!;
      const dist = (x: number, y: number) => metres(stops[x].lon, stops[x].lat, stops[y].lon, stops[y].lat);
      const [x, y] = dist(from, a) <= dist(from, b) ? [a, b] : [b, a];
      if (dist(from, x) + dist(x, y) + dist(y, to) > 1.35 * direct + 5000) continue; // not on the way
      const points = [from, x, y, to].filter((k, i, all) => i === 0 || k !== all[i - 1]);
      const parts = chain(points, after, maxTrips, [x, y]);
      if (!parts) continue;
      const end = expectedEnd(d, t);
      const sure = d.scenario.durationType === "UNTIL" && end !== null;
      const reopen = end === null ? "No reopening time is known" : `${stops[x].name} - ${stops[y].name} reopens ${sure ? "about" : "at the earliest"} ${zurich(end).time.slice(0, 5)}`;
      const fresh = add(parts, "wait", { uncertain: !sure });
      const j = found.find((k) => k.id === fresh.id)!; // the best option may already be this one
      j.waitsForReopening = true;
      j.uncertain = j.uncertain || !sure;
      for (const l of j.legs) if (l.from.id === stops[x].id && !l.note) l.note = reopen;
      if (!j.warnings.includes(reopen)) j.warnings.unshift(reopen);
    }
  }
  for (const [id, v] of journeys) if (t - v.at > 30 * 60_000) journeys.delete(id);
  // keep real choices: an option another one beats on all counts (leaves no earlier, arrives no later, fewer or equal
  // changes) stays only if it goes another way (a corridor no better option uses); drop options arriving much later
  const bestArrival = Math.min(...found.map((j) => j.arrival));
  const beats = (k: Journey, j: Journey) => k !== j && k.departure >= j.departure && k.arrival <= j.arrival && k.transfers <= j.transfers && (k.arrival < j.arrival || k.transfers < j.transfers || k.departure > j.departure);
  const night = found.some((j) => j.nextServiceDay);
  const kept: Journey[] = [];
  for (const j of [...found].sort((a, b) => a.arrival - b.arrival || a.transfers - b.transfers)) {
    if (j.kind === "best" && !night && j.arrival - bestArrival > 90 * 60_000) continue;
    const better = found.filter((k) => beats(k, j));
    if (better.length && j.kind !== "wait") {
      const way = j.corridor!.join(">");
      if (kept.some((k) => k.corridor!.join(">") === way) || better.some((k) => k.corridor!.join(">") === way)) continue;
      j.dominated = true;
    }
    kept.push(j);
  }
  const main = kept.filter((j) => j.kind !== "wait").slice(0, limit);
  // earliest arrival first, waiting for the reopening included: the fastest way there is the first certain one
  const out = [...main, ...kept.filter((j) => j.kind === "wait")].sort((a, b) => a.arrival - b.arrival || a.transfers - b.transfers);
  const pick = out.find((j) => !j.uncertain) ?? out[0];
  for (const j of out) if (j === pick) j.fastest = true; else delete j.fastest;
  return {
    from: place(from),
    to: place(to),
    generatedAt: t,
    journeys: out,
    alternativesConsidered: found.length,
    corridorsConsidered: new Set(found.map((j) => j.corridor!.join(">"))).size,
    searches,
    maxTransfers: maxTrips - 1,
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
/** A planned journey with every stop of every leg (planned and live times, and whether the train still serves it), for
 *  step-by-step itineraries and printed reports. */
export function journeyDetail(id: string) {
  const hit = journeys.get(id);
  if (!hit) return undefined;
  const t = Date.now();
  const legs = hit.journey.legs.map((leg, k) => {
    const { trip, i, j } = hit.parts[k];
    const lt = liveTimes(trip, t);
    const calls = [];
    for (let s = i; s <= j; s++) {
      const served = !lt.cancelled && !lt.skipped[s] && s >= lt.firstServed && s <= lt.lastServed;
      calls.push({
        id: stops[trip.stops[s]].id,
        name: stops[trip.stops[s]].name,
        plannedArr: s === i ? null : trip.arr[s],
        expectedArr: s === i ? null : Math.round(lt.arr[s]),
        plannedDep: s === j ? null : trip.dep[s],
        expectedDep: s === j ? null : Math.round(lt.dep[s]),
        served,
      });
    }
    return { ...leg, calls };
  });
  return { ...hit.journey, generatedAt: t, legs };
}

export function journeyGeometry(id: string) {
  const hit = journeys.get(id);
  if (!hit) return null;
  return { id, legs: hit.parts.map((p, k) => ({ trainId: hit.journey.legs[k].trainId, line: hit.journey.legs[k].line, geometry: tripGeometry(p.trip, p.i, p.j) })) };
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
