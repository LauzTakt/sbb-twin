// Passenger-routing data next to each day file (data/days/route-YYYY-MM-DD.json.gz, built by tools/prepare_routing.py
// from the same GTFS ZIP): the quay of every call with its pickup/drop-off types and original stop_sequence, the
// published minimum transfer times between quays (inside a station, and the walking links between a rail station and
// its bus stops), and the trip-to-trip rules (Spiez 120 s, stay-seated continuations). The day file collapses quays
// to stations and drops all of this; the planner needs it to match the official timetable.
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Trip } from "./timetable.ts";

/** Swiss default when no transfers.txt row exists between two quays of one stop (opentransportdata cookbook). */
export const DEFAULT_TRANSFER_SEC = 120;

type RouteFile = { v: number; feed: string; date: string; quays: [string, string, string][]; calls: Record<string, number[]>; pairs: number[]; rules: [string, string, number, number, number, number, string[]?][] };
export type TripRoute = { quay: Int32Array; pickup: Uint8Array; dropOff: Uint8Array; seq: Int32Array };
export type TripRule = { fromTrip: string; toTrip: string; fromQuay: number; toQuay: number; type: number; sec: number; dates?: string[] };

// quays of every loaded file share one index
export const quayStop: string[] = []; // GTFS stop_id (sloid)
export const quayStation: string[] = []; // DiDok station id (the day file's station)
export const quayPlatform: string[] = [];
const quayIdx = new Map<string, number>();
function quay(stopId: string, station: string, platform: string) {
  let k = quayIdx.get(stopId);
  if (k === undefined) {
    k = quayStop.length;
    quayIdx.set(stopId, k);
    quayStop.push(stopId);
    quayStation.push(station);
    quayPlatform.push(platform);
  }
  return k;
}
export const quayCount = () => quayStop.length;

/** Published minimum transfer seconds between two quays (stop-pair rows), by from*2^21+to. */
export const pairSec = new Map<number, number>();
export const pairKey = (a: number, b: number) => a * 2_097_152 + b;
/** Quays a quay has published rows to (both inside its station and walking links to other stations), and from. */
export const pairsFrom = new Map<number, number[]>();
export const pairsTo = new Map<number, number[]>();
/** Trip-to-trip rules by from trip_id. */
export const rulesFrom = new Map<string, TripRule[]>();
const tripRoutes = new Map<string, TripRoute>(); // by trip_id
const loaded = new Map<string, { feed: string; trips: number; rules: number } | null>();

/** Load the sidecar of a service day (once). Returns false when there is none (the planner then uses station-level
 *  defaults for that day's trips). */
export function loadRouting(date: string) {
  if (loaded.has(date)) return loaded.get(date) !== null;
  const file = join(config.daysDir, `route-${date}.json.gz`);
  if (!existsSync(file)) {
    loaded.set(date, null);
    return false;
  }
  const doc = JSON.parse(gunzipSync(readFileSync(file)).toString()) as RouteFile;
  const map = doc.quays.map(([id, st, pf]) => quay(id, st, pf));
  for (const [tripId, packed] of Object.entries(doc.calls)) {
    if (tripRoutes.has(tripId)) continue;
    const n = packed.length / 3;
    const r: TripRoute = { quay: new Int32Array(n), pickup: new Uint8Array(n), dropOff: new Uint8Array(n), seq: new Int32Array(n) };
    for (let i = 0; i < n; i++) {
      r.quay[i] = map[packed[3 * i]];
      r.pickup[i] = packed[3 * i + 1] >> 2;
      r.dropOff[i] = packed[3 * i + 1] & 3;
      r.seq[i] = packed[3 * i + 2];
    }
    tripRoutes.set(tripId, r);
  }
  const p = doc.pairs;
  for (let i = 0; i < p.length; i += 3) {
    const a = map[p[i]];
    const b = map[p[i + 1]];
    const k = pairKey(a, b);
    if (pairSec.has(k)) continue;
    pairSec.set(k, p[i + 2]);
    let list = pairsFrom.get(a);
    if (!list) pairsFrom.set(a, (list = []));
    list.push(b);
    let back = pairsTo.get(b);
    if (!back) pairsTo.set(b, (back = []));
    back.push(a);
  }
  let rules = 0;
  for (const [f, t, fq, tq, type, sec, dates] of doc.rules) {
    const rule: TripRule = { fromTrip: f, toTrip: t, fromQuay: map[fq], toQuay: map[tq], type, sec, ...(dates ? { dates } : {}) };
    let list = rulesFrom.get(f);
    if (!list) rulesFrom.set(f, (list = []));
    if (list.some((x) => x.toTrip === t && x.fromQuay === rule.fromQuay && x.toQuay === rule.toQuay && x.type === type)) continue;
    list.push(rule);
    rules++;
  }
  loaded.set(date, { feed: doc.feed, trips: Object.keys(doc.calls).length, rules });
  return true;
}
export const routingLoaded = () => [...loaded].filter(([, v]) => v).map(([date, v]) => ({ date, ...v! }));

/** The quay-level calls of a trip, when they line up with its day-file calls (same count). */
export function tripRoute(trip: Trip): TripRoute | undefined {
  const r = tripRoutes.get(trip.tripId);
  return r && r.quay.length === trip.stops.length ? r : undefined;
}

let byStation: { n: number; map: Map<string, number[]> } | undefined;
/** Every known quay of a station (DiDok id), used by calls or only by published transfers. */
export function quaysOf(station: string): number[] {
  if (!byStation || byStation.n !== quayStop.length) {
    const map = new Map<string, number[]>();
    quayStation.forEach((st, q) => {
      const l = map.get(st);
      if (l) l.push(q);
      else map.set(st, [q]);
    });
    byStation = { n: quayStop.length, map };
  }
  return byStation.map.get(station) ?? [];
}
