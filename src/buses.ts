// Replacement buses (EV): what real data says about them, and the road a confirmed bus drives.
// - research/buses/model.json (research/buses/buses.py, re-read when it changes): how long real incidents waited for
//   their first bus (SBB control-centre liveticker), the scheduled speed of the official EV buses between consecutive
//   stops (GTFS), and the real bus stop serving each station ("Olten, Bahnhof") with the walk to it.
// - The road between two consecutive bus stops: asked once per stop pair from OSRM when buses are ordered or confirmed
//   (never per tick) and cached on disk next to the state file; a straight line when that fails. A pair's road never
//   changes once a bus uses it, so the vehicle, its timetable and the journey planner agree.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { metres, registeredRoad, setRoadPath } from "./geometry.ts";
import { stationIndex, stops } from "./timetable.ts";

type Quantiles = { n: number; p10?: number; p25: number; median: number; p75: number; p90?: number; samples?: number[] };
export type BusStop = { name: string; stopId?: string; didok?: string; lat: number; lon: number; walkM?: number; walkMin: number; walkBasis?: string; ev?: boolean; basis?: string };
export type BusModel = {
  name?: string;
  version?: string;
  busFromFirstVersion?: { interrupted: number; withBusSentence: number; share: number };
  leadTimeMin: { firstSearch?: Quantiles; firstRunning: Quantiles; searchToRunning?: Quantiles };
  shortages?: { incidents: number };
  speed: { roadFactor: number; roadFactorMethod?: string; kmh: Quantiles; byStraightKm?: (Quantiles & { maxKm: number | null })[]; dwellSec?: { n?: number; median: number }; hops?: number; routes?: number; trips?: number };
  stationStops?: Record<string, BusStop>;
};

// Until research/buses/model.json is there: the numbers measured on the liveticker by hand, and the twin's old flat
// bus speed (50 km/h by road). Everything computed from it says source "missing".
const FALLBACK: BusModel = {
  leadTimeMin: { firstRunning: { n: 41, p25: 44, median: 69, p75: 117 }, firstSearch: { n: 38, p25: 32, median: 46, p75: 65 }, searchToRunning: { n: 8, p25: 39, median: 39, p75: 39 } },
  speed: { roadFactor: 1.3, kmh: { n: 0, p25: 50, median: 50, p75: 50 } },
};
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const MODEL_FILE = join(process.env.RAIL_RESEARCH_DIR ?? here("../research/"), "buses", "model.json");
let loaded: { model: BusModel; source: "real" | "missing"; mtime: number; checked: number } | undefined;
/** The bus model (checked for a new file at most once a minute). */
export function busModel() {
  const now = Date.now();
  if (loaded && now - loaded.checked < 60_000) return loaded;
  const mtime = existsSync(MODEL_FILE) ? statSync(MODEL_FILE).mtimeMs : 0;
  if (loaded && loaded.mtime === mtime) return ((loaded.checked = now), loaded);
  let model = FALLBACK;
  let source: "real" | "missing" = "missing";
  if (mtime)
    try {
      const m = JSON.parse(readFileSync(MODEL_FILE, "utf8")) as BusModel;
      if (m?.leadTimeMin?.firstRunning && m?.speed?.kmh) ((model = m), (source = "real"));
    } catch (err) {
      console.warn(`[buses] ${MODEL_FILE} is not valid JSON: ${(err as Error).message}`);
    }
  loaded = { model, source, mtime, checked: now };
  return loaded;
}

// ---------------------------------------------------------------- the real bus stops and the speed
/** The real bus stop serving a station (GTFS), with the walk from the station, or null. */
export const busStopOf = (stationId: string): BusStop | null => busModel().model.stationStops?.[stationId] ?? null;
/** Scheduled speed of the real EV buses for a hop of this straight length (km/h by road: road km / scheduled time). */
export function speedKmh(straightKm: number) {
  const s = busModel().model.speed;
  const band = s.byStraightKm?.find((b) => b.maxKm === null || straightKm <= b.maxKm);
  return band && band.n >= 20 && band.median > 0 ? band.median : s.kmh.median;
}
export const dwellMs = () => Math.round((busModel().model.speed.dwellSec?.median ?? 0) / 30) * 30_000;
export const LAYOVER_MIN = 5; // turnaround at each end (not in the data: an assumption)

const point = (stationId: string) => {
  const b = busStopOf(stationId);
  if (b) return { lon: b.lon, lat: b.lat };
  const s = stops[stationIndex(stationId) ?? -1];
  return s ? { lon: s.lon, lat: s.lat } : undefined;
};

// ---------------------------------------------------------------- roads (OSRM, cached per stop pair)
const OSRM = process.env.RAIL_OSRM_URL ?? "https://router.project-osrm.org"; // empty: never ask, straight lines
const ROADS_FILE = process.env.RAIL_ROADS_FILE ?? join(dirname(process.env.RAIL_STATE_FILE ?? join(config.dataDir, "state.json")), "roads.json");
type Road = { coords: number[]; km: number; at: number };
const cache = new Map<string, Road>(); // "fromId>toId@lon,lat;lon,lat" (the two bus stops) -> the road between them
const failed = new Map<string, number>(); // key -> when OSRM last failed (asked again after 10 minutes)
const locked = new Map<string, "osrm" | "straight">(); // stop pair a bus drives (registered with the geometry, fixed)
try {
  if (existsSync(ROADS_FILE)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(ROADS_FILE, "utf8")) as Record<string, Road>)) cache.set(k, v);
} catch (err) {
  console.warn(`[buses] ${ROADS_FILE} unreadable: ${(err as Error).message}`);
}
function saveRoads() {
  try {
    writeFileSync(`${ROADS_FILE}.tmp`, JSON.stringify(Object.fromEntries(cache)));
    renameSync(`${ROADS_FILE}.tmp`, ROADS_FILE);
  } catch (err) {
    console.warn(`[buses] could not save ${ROADS_FILE}: ${(err as Error).message}`);
  }
}
const keyOf = (aId: string, bId: string) => {
  const a = point(aId);
  const b = point(bId);
  return a && b ? { a, b, key: `${aId}>${bId}@${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}` } : undefined;
};

async function fetchRoad(aId: string, bId: string, timeoutMs: number) {
  const k = keyOf(aId, bId);
  if (!k || !OSRM || cache.has(k.key) || Date.now() - (failed.get(k.key) ?? 0) < 600_000) return false;
  try {
    const res = await fetch(`${OSRM}/route/v1/driving/${k.a.lon},${k.a.lat};${k.b.lon},${k.b.lat}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { code?: string; routes?: { distance: number; geometry?: { coordinates: [number, number][] } }[] };
    const r = body.routes?.[0];
    const line = r?.geometry?.coordinates ?? [];
    if (body.code !== "Ok" || !r || line.length < 2) throw new Error(`no route (${body.code})`);
    const straight = metres(k.a.lon, k.a.lat, k.b.lon, k.b.lat);
    if (r.distance > 3 * straight + 3000) throw new Error(`implausible detour (${Math.round(r.distance)} m for ${Math.round(straight)} m)`);
    // from the bus stop itself to the next one (OSRM starts and ends on the nearest road)
    const coords = [k.a.lon, k.a.lat, ...line.flatMap(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]), k.b.lon, k.b.lat];
    cache.set(k.key, { coords, km: Math.round(r.distance) / 1000, at: Date.now() });
    return true;
  } catch (err) {
    failed.set(k.key, Date.now());
    console.warn(`[buses] OSRM ${aId}>${bId}: ${(err as Error).message}: a straight line instead`);
    return false;
  }
}
/** Ask OSRM for the roads between consecutive stops of a bus route, both ways, once per pair (3 at a time). */
export async function ensureRoads(ids: string[], timeoutMs = 4000) {
  const pairs: [string, string][] = [];
  for (let k = 0; k < ids.length - 1; k++) pairs.push([ids[k], ids[k + 1]], [ids[k + 1], ids[k]]);
  let fetched = 0;
  for (let i = 0; i < pairs.length; i += 3) fetched += (await Promise.all(pairs.slice(i, i + 3).map(([a, b]) => fetchRoad(a, b, timeoutMs)))).filter(Boolean).length;
  if (fetched) saveRoads();
  return roadSummary(ids);
}
/** The road from one station's bus stop to the next: the one a bus already drives (fixed), else OSRM's (cached), else a
 *  straight line. `lock`: a bus is generated on it, so it is registered with the geometry and never changes again. */
function road(aId: string, bId: string, lock: boolean) {
  const pair = `${aId}>${bId}`;
  const fixed = locked.get(pair);
  const known = registeredRoad(aId, bId);
  if (fixed && known) return { len: known.len, source: fixed };
  const k = keyOf(aId, bId);
  const hit = k ? cache.get(k.key) : undefined;
  const coords = hit?.coords ?? (k ? [k.a.lon, k.a.lat, k.b.lon, k.b.lat] : [0, 0, 0, 0]);
  const source: "osrm" | "straight" = hit ? "osrm" : "straight";
  if (!lock) {
    let len = 0;
    for (let i = 2; i < coords.length; i += 2) len += metres(coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
    return { len, source };
  }
  locked.set(pair, source);
  return { len: setRoadPath(aId, bId, coords).len, source };
}
/** How long a bus takes between two stations' bus stops, ms: road metres (OSRM, else straight x the road factor) at the
 *  scheduled speed of the real EV buses for a hop of that length, rounded to 30 s, at least a minute. `lock` when a
 *  bus is generated on it (its road is then fixed). */
export function hopMs(aId: string, bId: string, lock = false) {
  const r = road(aId, bId, lock);
  const a = point(aId);
  const b = point(bId);
  const straightKm = a && b ? metres(a.lon, a.lat, b.lon, b.lat) / 1000 : r.len / 1000;
  const roadM = r.source === "osrm" ? r.len : straightKm * 1000 * busModel().model.speed.roadFactor;
  return Math.max(60, Math.round(roadM / (speedKmh(straightKm) / 3.6) / 30) * 30) * 1000;
}
/** One run along the route (first stop to last), ms: the hops plus the dwell at the stops between. */
export const runMs = (ids: string[]) => ids.slice(1).reduce((sum, id, k) => sum + hopMs(ids[k], id), 0) + dwellMs() * Math.max(0, ids.length - 2);
/** A shuttle on this route: run times each way and the round trip with a turnaround at each end, minutes. */
export function circulation(ids: string[], layoverMin = LAYOVER_MIN) {
  const a = runMs(ids);
  const b = runMs([...ids].reverse());
  return { runMinA: Math.round(a / 60_000), runMinB: Math.round(b / 60_000), cycleMin: Math.ceil((a + b) / 60_000 + 2 * layoverMin), layoverMin };
}
export function roadSummary(ids: string[]) {
  let osrm = 0;
  let km = 0;
  for (let k = 0; k < ids.length - 1; k++) {
    const kk = keyOf(ids[k], ids[k + 1]);
    const hit = kk ? cache.get(kk.key) : undefined;
    if (hit) (osrm++, (km += hit.km));
    else if (kk) km += (metres(kk.a.lon, kk.a.lat, kk.b.lon, kk.b.lat) / 1000) * busModel().model.speed.roadFactor;
  }
  const hops = Math.max(0, ids.length - 1);
  return { source: osrm === hops && hops ? "osrm" : osrm ? "mixed" : "straight", km: Math.round(km * 10) / 10, hops, osrmHops: osrm } as const;
}

// ---------------------------------------------------------------- when the first bus can be expected
const quantile = (xs: number[], q: number) => {
  const p = (xs.length - 1) * q;
  const lo = Math.floor(p);
  return xs[lo] + (xs[Math.min(xs.length - 1, lo + 1)] - xs[lo]) * (p - lo);
};
const r5 = (x: number) => Math.round(x / 5) * 5;
const hm = (ms: number) => new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
/** While buses are being organised: when the first one usually runs, from the real incidents (start -> first bus in
 *  service, the middle half), given that none ran yet `now`. */
export function expectedFirstBus(start: number, now: number) {
  const { model, source } = busModel();
  const q = model.leadTimeMin.firstRunning;
  const elapsed = Math.max(0, (now - start) / 60_000);
  const sample = (q.samples ?? []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  let lo = q.p25;
  let hi = q.p75;
  let median = q.median;
  let n = q.n;
  let conditional = false;
  if (sample.length && elapsed > sample[0]) {
    const left = sample.filter((x) => x > elapsed);
    conditional = true;
    if (left.length < 5)
      return { fromMin: null, toMin: null, from: null, to: null, medianMin: null, n: left.length, of: sample.length, conditional, late: true, source, basis: "start of the disruption -> first replacement bus in service, real SBB incidents (control-centre liveticker)", say: `Replacement buses are being organised for longer than in almost every real incident (${sample.length - left.length} of ${sample.length} had a bus by now): no time can be estimated.` };
    ((lo = quantile(left, 0.25)), (hi = quantile(left, 0.75)), (median = quantile(left, 0.5)), (n = left.length));
  } else if (!sample.length && elapsed > lo) ((lo = elapsed), (hi = Math.max(hi, elapsed + 10)));
  const fromMin = r5(lo);
  const toMin = Math.max(fromMin + 5, r5(hi));
  return {
    fromMin, toMin, from: Math.round(start / 60_000 + fromMin) * 60_000, to: Math.round(start / 60_000 + toMin) * 60_000, medianMin: r5(median), n, of: sample.length || q.n, conditional, late: false, source,
    basis: "start of the disruption -> first replacement bus in service, the middle half of real SBB incidents (control-centre liveticker)",
    say: `The first replacement bus usually arrives ${fromMin} to ${toMin} minutes after the start of the disruption, so between about ${hm(start + fromMin * 60_000)} and ${hm(start + toMin * 60_000)}.`,
  };
}
/** The empirical facts behind the bus lifecycle, for payloads (small). */
export function busEvidence() {
  const { model, source } = busModel();
  const t = model.leadTimeMin;
  const pick = (q?: Quantiles) => (q ? { n: q.n, p25: q.p25, median: q.median, p75: q.p75 } : null);
  return { source, version: model.version ?? null, firstSearchMin: pick(t.firstSearch), firstBusMin: pick(t.firstRunning), orderToBusMin: pick(t.searchToRunning), busSentenceFromFirstVersion: model.busFromFirstVersion ?? null, speedKmh: { median: model.speed.kmh.median, n: model.speed.kmh.n, roadFactor: model.speed.roadFactor } };
}
