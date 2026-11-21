// Live weather from MeteoSwiss (SwissMetNet, open data, 10-minute values): temperature, precipitation, wind.
// Temperature is also interpolated into a grid corrected for altitude (in Switzerland altitude dominates):
// T(x) = IDW over points of (T_i + L * z_i)  -  L * z(x), with lapse rate L = 6.5 °C/km and z from a terrain model.
// Points = MeteoSwiss stations, plus Open-Meteo model values around the border so the map covers the whole view.
import { PNG } from "pngjs";
import { publish } from "./mqtt.ts";

const FEEDS = {
  tempC: "lufttemperatur-10min",
  precipMm: "niederschlag-10min",
  windKmh: "windgeschwindigkeit-kmh-10min",
} as const;
const url = (layer: string) => `https://data.geo.admin.ch/ch.meteoschweiz.messwerte-${layer}/ch.meteoschweiz.messwerte-${layer}_en.json`;
const LAPSE = 0.0065; // °C per metre
export const GRID = { west: 5.4, south: 45.55, east: 11.0, north: 48.05, step: 0.0125 }; // = the viewer's map bounds

export type WeatherStation = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  altitudeM: number;
  tempC: number | null;
  precipMm: number | null; // last 10 minutes
  windKmh: number | null; // 10-minute mean
  measuredAt: number | null; // epoch ms
};

type ModelPoint = { lat: number; lon: number; altitudeM: number; tempC: number; at: number };
let border: ModelPoint[] = [];
let borderAt = 0;
/** Open-Meteo current temperatures on a 0.4° lattice, away from MeteoSwiss stations (mostly abroad). */
async function refreshBorder(stations: WeatherStation[]) {
  if (Date.now() - borderAt < 30 * 60_000 && border.length) return;
  const kmLon = 111.32 * Math.cos((46.8 * Math.PI) / 180);
  const pts: [number, number][] = [];
  for (let lat = GRID.south; lat <= GRID.north + 1e-9; lat += 0.4)
    for (let lon = GRID.west; lon <= GRID.east + 1e-9; lon += 0.4) {
      const near = stations.some((s) => s.tempC !== null && ((s.lon - lon) * kmLon) ** 2 + ((s.lat - lat) * 111.32) ** 2 < 15 * 15);
      if (!near) pts.push([Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]);
    }
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p[0]).join(",")}&longitude=${pts.map((p) => p[1]).join(",")}&current=temperature_2m`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const body = (await r.json()) as { latitude: number; longitude: number; elevation: number; current: { temperature_2m: number; time: string } }[];
  border = (Array.isArray(body) ? body : [body])
    .filter((x) => typeof x.current?.temperature_2m === "number")
    .map((x) => ({ lat: x.latitude, lon: x.longitude, altitudeM: x.elevation, tempC: x.current.temperature_2m, at: Date.parse(`${x.current.time}Z`) }));
  borderAt = Date.now();
}

export const weather = {
  stations: new Map<string, WeatherStation>(),
  grid: undefined as undefined | { cols: number; rows: number; values: (number | null)[]; measuredAt: number },
  fetchedAt: 0,
  error: undefined as string | undefined,
};

/** Swiss LV95 (EPSG:2056) to WGS84, swisstopo's approximate formulas (about 1 m). */
export function lv95ToWgs84(e: number, n: number) {
  const y = (e - 2_600_000) / 1e6;
  const x = (n - 1_200_000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lon: (lon * 100) / 36, lat: (lat * 100) / 36 };
}

// ---------------------------------------------------------------- terrain (Terrarium tiles, zoom 8)
const Z = 8;
let dem: Map<string, Float32Array> | undefined;
const tileX = (lon: number) => ((lon + 180) / 360) * 2 ** Z;
const tileY = (lat: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
async function loadDem() {
  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let x = Math.floor(tileX(GRID.west)); x <= Math.floor(tileX(GRID.east)); x++)
    for (let y = Math.floor(tileY(GRID.north)); y <= Math.floor(tileY(GRID.south)); y++)
      jobs.push(
        fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, { signal: AbortSignal.timeout(20_000) })
          .then((r) => r.arrayBuffer())
          .then((b) => {
            const png = PNG.sync.read(Buffer.from(b));
            const h = new Float32Array(png.width * png.height);
            for (let i = 0; i < h.length; i++) h[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
            tiles.set(`${x}/${y}`, h);
          }),
      );
  await Promise.all(jobs);
  dem = tiles;
}
export function elevation(lon: number, lat: number) {
  if (!dem) return undefined;
  const fx = tileX(lon);
  const fy = tileY(lat);
  const t = dem.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
  if (!t) return undefined;
  const px = Math.min(255, Math.floor((fx % 1) * 256));
  const py = Math.min(255, Math.floor((fy % 1) * 256));
  return Math.max(0, t[py * 256 + px]);
}

// ---------------------------------------------------------------- polling
async function fetchFeed(layer: string) {
  const r = await fetch(url(layer), { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`MeteoSwiss ${layer}: HTTP ${r.status}`);
  return (await r.json()) as { features: { id: string; geometry: { coordinates: [number, number] }; properties: { station_name: string; value: number; reference_ts: string; altitude: string } }[] };
}

export async function pollWeather() {
  try {
    if (!dem) await loadDem().catch((e) => console.warn("[weather] terrain model unavailable:", e.message));
    const feeds = await Promise.all(Object.values(FEEDS).map(fetchFeed));
    const stations = new Map<string, WeatherStation>();
    Object.keys(FEEDS).forEach((field, k) => {
      for (const f of feeds[k].features) {
        const p = f.properties;
        let s = stations.get(f.id);
        if (!s) {
          const { lon, lat } = lv95ToWgs84(f.geometry.coordinates[0], f.geometry.coordinates[1]);
          s = { id: f.id, name: p.station_name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, altitudeM: Math.round(Number(p.altitude)), tempC: null, precipMm: null, windKmh: null, measuredAt: null };
          stations.set(f.id, s);
        }
        const valid = typeof p.value === "number" && Math.abs(p.value) < 9000; // 99999 marks a missing value
        (s as Record<string, unknown>)[field] = valid ? p.value : null;
        const ts = Date.parse(p.reference_ts);
        if (valid && Number.isFinite(ts)) s.measuredAt = Math.max(s.measuredAt ?? 0, ts);
      }
    });
    weather.stations = stations;
    weather.fetchedAt = Date.now();
    weather.error = undefined;
    await refreshBorder([...stations.values()]).catch((e) => console.warn("[weather] border model values unavailable:", e.message));
    buildGrid();
    return true;
  } catch (err) {
    weather.error = (err as Error).message;
    return false;
  }
}

function buildGrid() {
  const measured = [...weather.stations.values()].filter((s) => s.tempC !== null);
  const pts = [...measured.map((s) => ({ lat: s.lat, lon: s.lon, altitudeM: s.altitudeM, tempC: s.tempC! })), ...border];
  const cols = Math.round((GRID.east - GRID.west) / GRID.step) + 1;
  const rows = Math.round((GRID.north - GRID.south) / GRID.step) + 1;
  const values: (number | null)[] = new Array(cols * rows).fill(null);
  const kmLon = 111.32 * Math.cos((46.8 * Math.PI) / 180);
  for (let r = 0; r < rows; r++) {
    const lat = GRID.north - r * GRID.step;
    for (let c = 0; c < cols; c++) {
      const lon = GRID.west + c * GRID.step;
      let num = 0;
      let den = 0;
      for (const s of pts) {
        const dx = (s.lon - lon) * kmLon;
        const dy = (s.lat - lat) * 111.32;
        const d2 = dx * dx + dy * dy;
        if (d2 > 90 * 90) continue;
        const w = 1 / Math.max(d2, 0.25) ** 1.2;
        num += w * (s.tempC + LAPSE * s.altitudeM);
        den += w;
      }
      if (!den) continue;
      const z = elevation(lon, lat);
      const t = num / den - LAPSE * (z ?? 500);
      values[r * cols + c] = Math.round(t * 10) / 10;
    }
  }
  const measuredAt = Math.max(0, ...measured.map((s) => s.measuredAt ?? 0));
  weather.grid = { cols, rows, values, measuredAt };
}

let lastSig = "";
export function publishWeather() {
  const sig = `${weather.fetchedAt}`;
  if (!weather.fetchedAt || sig === lastSig) return;
  lastSig = sig;
  const list = [...weather.stations.values()];
  for (const s of list) publish(`weather/stations/${s.id}`, { v: 1, ...s, source: "MeteoSwiss SwissMetNet (open data)" }, { retain: true, qos: 1 });
  publish(
    "weather/snapshot",
    { v: 1, ts: weather.fetchedAt, measuredAt: weather.grid?.measuredAt ?? null, source: "MeteoSwiss SwissMetNet (open data)", fields: ["id", "name", "lat", "lon", "altitudeM", "tempC", "precipMm", "windKmh", "measuredAt"], stations: list.map((s) => [s.id, s.name, s.lat, s.lon, s.altitudeM, s.tempC, s.precipMm, s.windKmh, s.measuredAt]) },
    { retain: true, qos: 1 },
  );
  if (weather.grid)
    publish(
      "weather/temperature-grid",
      { v: 1, ts: weather.fetchedAt, measuredAt: weather.grid.measuredAt, unit: "°C", method: "inverse-distance weighting of MeteoSwiss stations (plus Open-Meteo model values outside Switzerland), corrected for altitude (6.5 °C/km, terrain model)", bbox: [GRID.west, GRID.south, GRID.east, GRID.north], step: GRID.step, cols: weather.grid.cols, rows: weather.grid.rows, order: "row-major from north-west", values: weather.grid.values },
      { retain: true, qos: 1 },
    );
}
