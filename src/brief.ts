// A fast situation brief for the passenger assistant: everything relevant to a place or a route in one answer, from
// the twin's state only (no model call). The voice assistant preloads it when a passenger mentions a place.
//   GET /api/brief?station=<id|name>      disruptions touching the station, its next departures
//   GET /api/brief?from=<>&to=<>          the same for both ends and the way between, plus the next 3 journeys
import { stationBoard, dayTrips } from "./engine.ts";
import { stationIndex, stops, type Trip } from "./timetable.ts";
import { disruptions, tripChanges, type Disruption, type Scenario } from "./disruptions.ts";
import { alertsState } from "./alerts.ts";
import { plan, resolveStation } from "./planner.ts";
import { expectedEnd, isScenario, latestBulletin, stateAt } from "./scenario.ts";
import { MEASURES } from "./catalogue.ts";

type S = Disruption & { scenario: Scenario };
const place = (k: number) => ({ id: stops[k].id, name: stops[k].name });
const nameOf = (id: string) => stops[stationIndex(id) ?? -1]?.name ?? id;
let keysOf: { trips: Trip[]; map: Map<string, string> } | undefined;
/** trainId -> trip key for today's effective timetable (rebuilt when it changes). */
const tripKeys = () => {
  const trips = dayTrips();
  if (keysOf?.trips !== trips) keysOf = { trips, map: new Map(trips.map((trip) => [trip.trainId, trip.key])) };
  return keysOf.map;
};

/** The stations a scenario disruption concerns directly: its ends, the stations inside and on the bus route. */
const stationsOf = (d: S) => new Set([d.scenario.a, d.scenario.b, ...d.scenario.inside, ...d.scenario.busStops].filter(Boolean) as string[]);

function disruptionBrief(d: S, t: number, at: Set<string>) {
  const sc = d.scenario;
  const b = latestBulletin(d);
  const st = stateAt(d, t, t);
  // replacement buses: next departures from the stations asked about (or from both ends)
  const buses = dayTrips().filter((trip) => trip.cat === "EV" && trip.key.includes(`EV-${d.id.slice(2)}-`));
  const from = [...at].filter((id) => sc.busStops.includes(id));
  const ends = from.length ? from : [sc.a, sc.b].filter(Boolean) as string[];
  const next = buses
    .flatMap((trip) => {
      const i = Array.from(trip.stops).findIndex((k) => ends.includes(stops[k].id));
      if (i < 0 || i === trip.stops.length - 1 || trip.dep[i] < t) return [];
      const last = trip.stops.length - 1;
      return [{ trainId: trip.trainId, from: stops[trip.stops[i]].name, to: stops[trip.stops[last]].name, departure: trip.dep[i], arrival: trip.arr[last] }];
    })
    .sort((x, y) => x.departure - y.departure)
    .slice(0, 4);
  let cut = 0;
  let held = 0;
  for (const ch of tripChanges.values()) if (ch.by === d.id) ch.holdAt !== undefined ? held++ : cut++;
  return {
    id: d.id,
    kind: "control",
    title: b?.title ?? d.label,
    description: b?.description ?? "",
    bulletinVersion: b?.version ?? 0,
    source: b?.source ?? "template",
    lifecycle: b?.lifecycle ?? "INFO",
    effect: st.state,
    cause: sc.cause,
    section: { a: { id: sc.a, name: nameOf(sc.a) }, b: sc.b ? { id: sc.b, name: nameOf(sc.b) } : null },
    until: st.until,
    durationType: st.durationType,
    expectedEnd: d.endedAt ? null : expectedEnd(d, t),
    lines: b ? b.lines : st.state === "interrupted" ? sc.lines : [],
    measures: sc.measures.filter((m) => m.announcedAt <= t).map((m) => ({ type: m.type, label: MEASURES.find((x) => x.type === m.type)?.label ?? m.type, at: m.at, withdrawAt: m.withdrawAt ?? null })),
    replacementBus: buses.length ? { route: sc.busStops.map(nameOf), next } : null,
    trainsCut: cut,
    trainsHeld: held,
    messages: b?.messages ?? [],
  };
}

function alertBrief(a: (typeof alertsState.alerts extends Map<string, infer V> ? V : never)) {
  const { trainIds, sourceIds, geometry, ...rest } = a;
  return { ...rest, kind: "sbb", trains: trainIds.length };
}

/** Everything relevant to these stations: control-centre disruptions and real SBB alerts touching them. */
function touching(ids: Set<string>, t: number, trainIds: Set<string>) {
  const out: ReturnType<typeof disruptionBrief>[] = [];
  for (const d of disruptions.values()) {
    if (!isScenario(d)) continue;
    const mine = stationsOf(d);
    const hit = [...ids].some((id) => mine.has(id)) || [...tripChanges].some(([key, ch]) => ch.by === d.id && trainIds.has(key));
    if (hit) out.push(disruptionBrief(d, t, ids));
  }
  const alerts = [...alertsState.alerts.values()].filter((a) => a.stations.some((s) => ids.has(s.id)) || a.trainIds.some((x) => trainIds.has(x))).map(alertBrief);
  return { disruptions: out, alerts };
}

function stationPart(k: number, t: number) {
  const departures = stationBoard(k, t, 60, 8);
  return { station: place(k), departures };
}

let served: { day: unknown; ks: number[] } | undefined;
/** The served station nearest to a point (the passenger's location), with its distance in metres. */
function nearest(lat: number, lon: number) {
  const day = dayTrips();
  if (!served || served.day !== day) {
    const ks = new Set<number>();
    for (const trip of day) for (const k of trip.stops) ks.add(k);
    served = { day, ks: [...ks] };
  }
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bd = Infinity;
  for (const k of served.ks) {
    const d = Math.hypot((stops[k].lon - lon) * kx, (stops[k].lat - lat) * 110_540);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best < 0 ? undefined : { k: best, distanceM: Math.round(bd) };
}

export function brief(q: { station?: string; from?: string; to?: string; lat?: string; lon?: string }): Record<string, unknown> {
  // the passenger's location instead of a station: the nearest served station (as the origin when only "to" is given)
  if (q.lat && q.lon && !q.station && !q.from) {
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    const n = Number.isFinite(lat) && Number.isFinite(lon) ? nearest(lat, lon) : undefined;
    if (!n || n.distanceM > 50_000) return { error: "No station within 50 km of this point" };
    const near = { ...place(n.k), distanceM: n.distanceM };
    return { ...(q.to ? brief({ from: stops[n.k].id, to: q.to }) : brief({ station: stops[n.k].id })), nearest: near };
  }
  const t = Date.now();
  const t0 = performance.now();
  if (q.from && q.to) {
    const a = resolveStation(q.from);
    const b = resolveStation(q.to);
    if (a === undefined || b === undefined) return { error: `Unknown station: ${a === undefined ? q.from : q.to}` };
    const p = plan(stops[a].id, stops[b].id, t, 3, { quick: true });
    const journeys = "error" in p ? [] : p.journeys.slice(0, 3);
    // the way between: every station the journeys call at (boarding, changing, alighting) and their trains
    const ids = new Set([stops[a].id, stops[b].id]);
    const trips = new Set<string>();
    const byId = tripKeys();
    for (const j of journeys)
      for (const l of j.legs) {
        ids.add(l.from.id);
        ids.add(l.to.id);
        const key = byId.get(l.trainId);
        if (key) trips.add(key);
      }
    const from = stationPart(a, t);
    const to = stationPart(b, t);
    for (const r of [...from.departures]) if (r.trainId) trips.add(byId.get(r.trainId) ?? "");
    const hits = touching(ids, t, trips);
    return { generatedAt: t, from: from.station, to: to.station, ...hits, journeys, departures: from.departures, ms: Math.round(performance.now() - t0) };
  }
  const k = resolveStation(q.station);
  if (k === undefined) return { error: q.station ? `Unknown station: ${q.station}` : "station, or from and to, are required" };
  const part = stationPart(k, t);
  const byId = tripKeys();
  const trips = new Set(part.departures.map((r) => (r.trainId ? byId.get(r.trainId) ?? "" : "")));
  const hits = touching(new Set([stops[k].id]), t, trips);
  return { generatedAt: t, station: part.station, ...hits, departures: part.departures, ms: Math.round(performance.now() - t0) };
}
