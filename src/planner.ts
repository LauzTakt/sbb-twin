// Journey planner on the twin's live state: today's timetable with the live predictions, held, slowed and cancelled
// trains, skipped stops, closed stations and closed sections. Connection Scan (earliest arrival), repeated with later
// departures to offer the real alternatives (wait for the next train, another route). Plus what a passenger at a
// place should know (situation) and the track geometry to draw a journey.
import { createHash } from "node:crypto";
import { dayTrips, liveTimes, servedStations, stationBoard, byTrainId } from "./engine.ts";
import { searchStations, stationIndex, stops, type Trip } from "./timetable.ts";
import { disruptions, incidents, type Incident } from "./disruptions.ts";
import { edgesGeometry, sectionEdges, travelPath } from "./geometry.ts";
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

function connections(t: number, after: number) {
  const until = after + HORIZON_MS;
  const trips = dayTrips();
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

function earliest(trips: Trip[], lives: (Live | undefined)[], conns: Conn[], from: number, to: number, after: number, closed: Set<number>) {
  const best = new Map<number, number>([[from, after]]);
  const boarded = new Map<number, number>(); // trip -> connection index where boarded
  const how = new Map<number, { trip: number; board: number; alight: number }>();
  for (let k = 0; k < conns.length; k++) {
    const c = conns[k];
    if (c.dep > (best.get(to) ?? Infinity)) break;
    const lt = lives[c.trip]!;
    if (!boarded.has(c.trip)) {
      const at = best.get(c.from);
      if (at === undefined || (c.from === from ? at : at + TRANSFER_MS) > c.dep) continue;
      if (lt.skipped[c.i] || closed.has(c.from)) continue;
      boarded.set(c.trip, k);
    }
    if (lt.skipped[c.i + 1] || closed.has(c.to)) continue; // passes without stopping
    if (c.arr < (best.get(c.to) ?? Infinity)) {
      best.set(c.to, c.arr);
      how.set(c.to, { trip: c.trip, board: boarded.get(c.trip)!, alight: k });
    }
  }
  if (!how.has(to)) return null;
  const parts: { trip: number; i: number; j: number }[] = [];
  let s = to;
  for (let guard = 0; s !== from && guard < 8; guard++) {
    const h = how.get(s);
    if (!h) return null;
    parts.unshift({ trip: h.trip, i: conns[h.board].i, j: conns[h.alight].i + 1 });
    s = conns[h.board].from;
  }
  return s === from ? parts : null;
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

/** The best journeys from one station to another, earliest arrival first. */
export function plan(fromQ: string, toQ: string, after = Date.now(), limit = 4) {
  const from = resolveStation(fromQ);
  const to = resolveStation(toQ);
  if (from === undefined) return { error: `Unknown station: ${fromQ}` };
  if (to === undefined) return { error: `Unknown station: ${toQ}` };
  const t = Date.now();
  const { trips, lives, conns } = connections(t, Math.min(after, t + HORIZON_MS));
  const { stations: closed } = closures();
  const found: Journey[] = [];
  const seen = new Set<string>();
  let from_t = after;
  for (let round = 0; round < limit * 2 && found.length < limit; round++) {
    const parts = earliest(trips, lives, conns, from, to, from_t, closed);
    if (!parts) break;
    const j = toJourney(trips, lives, parts);
    if (!seen.has(j.id)) {
      seen.add(j.id);
      found.push(j);
      journeys.set(j.id, { at: t, journey: j, parts: parts.map((p) => ({ trip: trips[p.trip], i: p.i, j: p.j })) });
    }
    from_t = j.departure + 60_000; // the next option leaves later
  }
  for (const [id, v] of journeys) if (t - v.at > 30 * 60_000) journeys.delete(id);
  // keep real choices: drop an option another one beats on all counts (leaves no earlier, arrives no later, fewer or
  // equal changes) and options arriving much later than the best
  const bestArrival = Math.min(...found.map((j) => j.arrival));
  const kept = found.filter((j) => j.arrival - bestArrival <= 90 * 60_000 && !found.some((k) => k !== j && k.departure >= j.departure && k.arrival <= j.arrival && k.transfers <= j.transfers && (k.arrival < j.arrival || k.transfers < j.transfers || k.departure > j.departure)));
  kept.sort((a, b) => a.arrival - b.arrival || a.transfers - b.transfers);
  return { from: place(from), to: place(to), generatedAt: t, journeys: kept };
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
    return { from: atStation(a), to: atStation(b), onTheWay: [...new Set((p.journeys ?? []).flatMap((j) => j.warnings))] };
  }
  const k = resolveStation(q.station);
  if (k === undefined) return { error: "Unknown station" };
  return atStation(k);
}
