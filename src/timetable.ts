// The planned timetable of a service day, from the prepared day index (GTFS rail + rail-replacement trips).
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "./config.ts";
import { serviceOrigin } from "./time.ts";

export type Stop = { id: string; name: string; lon: number; lat: number };
export type Trip = {
  key: string; // day-index instance id: "YYYYMMDD/<trip_id>[/<start>]"
  trainId: string; // MQTT-safe id: "YYYYMMDD_<trip_id without leading dot>[_<start>]"
  tripId: string;
  serviceDate: string; // YYYYMMDD
  cat: string;
  line: string;
  head: string;
  stops: Int32Array; // station indexes
  arr: Float64Array; // planned arrival, epoch ms
  dep: Float64Array; // planned departure, epoch ms
};
type DayFile = { stops: [string, string, number, number][]; trips: [string, string, string, string, number[]][] };

export let stops: Stop[] = [];
const byId = new Map<string, number>();
export const stationIndex = (id: string) => byId.get(id);

export async function loadDay(date: string): Promise<Trip[]> {
  const file = join(config.daysDir, `day-${date}.json.gz`);
  if (!existsSync(file)) throw new Error(`No timetable for ${date} in ${config.daysDir}`);
  const day = JSON.parse(gunzipSync(await readFile(file)).toString()) as DayFile;
  if (!stops.length || day.stops.length !== stops.length) {
    stops = day.stops.map(([id, name, lon, lat]) => ({ id, name, lon, lat }));
    byId.clear();
    stops.forEach((s, i) => byId.set(s.id, i));
  }
  const origin = serviceOrigin(date);
  return day.trips.map(([key, cat, line, head, flat]) => {
    const [serviceDate, tripId, start] = key.split("/");
    const n = flat.length / 3;
    const s = new Int32Array(n);
    const arr = new Float64Array(n);
    const dep = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = flat[i * 3];
      arr[i] = origin + flat[i * 3 + 1] * 1000;
      dep[i] = origin + flat[i * 3 + 2] * 1000;
    }
    const trainId = `${serviceDate}_${tripId.replace(/^\./, "")}${start ? `_${start}` : ""}`.replace(/[+#/\s]/g, "-");
    return { key, trainId, tripId, serviceDate, cat, line: line.replace(/\s+/g, ""), head, stops: s, arr, dep };
  });
}

export function searchStations(q: string, limit = 8) {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const n = norm(q.trim());
  if (!n) return [];
  const hits = stops.filter((s) => norm(s.name).includes(n) || s.id === q.trim());
  // exact name first, then names starting with the query, then the rest; shorter names first within each group
  const rank = (s: { name: string }) => (norm(s.name) === n ? 0 : norm(s.name).startsWith(n) ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length);
  return hits.slice(0, limit);
}

/** Another service day's trips on the current stop list (the planner reads the next morning with it), or [] when
 *  that day has no file. Unlike loadDay it never replaces the stop list: stops it does not know are dropped. */
export async function loadDayMapped(date: string): Promise<Trip[]> {
  const file = join(config.daysDir, `day-${date}.json.gz`);
  if (!existsSync(file)) return [];
  return mapDay(JSON.parse(gunzipSync(await readFile(file)).toString()) as DayFile, date);
}
/** The same, synchronously: the planner loads the next morning before it answers (never an incomplete first answer). */
export function loadDayMappedSync(date: string): Trip[] {
  const file = join(config.daysDir, `day-${date}.json.gz`);
  if (!existsSync(file)) return [];
  return mapDay(JSON.parse(gunzipSync(readFileSync(file)).toString()) as DayFile, date);
}
function mapDay(day: DayFile, date: string): Trip[] {
  const map = day.stops.map(([id]) => byId.get(id) ?? -1);
  const origin = serviceOrigin(date);
  const out: Trip[] = [];
  for (const [key, cat, line, head, flat] of day.trips) {
    const [serviceDate, tripId, start] = key.split("/");
    const n = flat.length / 3;
    const s = new Int32Array(n);
    const arr = new Float64Array(n);
    const dep = new Float64Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      s[i] = map[flat[i * 3]] ?? -1;
      if (s[i] < 0) ok = false;
      arr[i] = origin + flat[i * 3 + 1] * 1000;
      dep[i] = origin + flat[i * 3 + 2] * 1000;
    }
    if (!ok) continue;
    const trainId = `${serviceDate}_${tripId.replace(/^\./, "")}${start ? `_${start}` : ""}`.replace(/[+#/\s]/g, "-");
    out.push({ key, trainId, tripId, serviceDate, cat, line: line.replace(/\s+/g, ""), head, stops: s, arr, dep });
  }
  return out;
}
