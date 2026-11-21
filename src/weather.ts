// Live weather from MeteoSwiss (SwissMetNet, open data, 10-minute values) and god-mode weather overrides.
// Temperature is also interpolated into a grid corrected for altitude (in Switzerland altitude dominates):
// T(x) = IDW over points of (T_i + L * z_i)  -  L * z(x), with lapse rate L = 6.5 °C/km and z from a terrain model.
// Points = MeteoSwiss stations, plus Open-Meteo model values around the border so the map covers the whole view.
// Overrides (an area with new values) change the stations and the grid inside the area, fading out at its edge.
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { publish, clear } from "./mqtt.ts";
import * as channel from "./channel.ts";

// MeteoSwiss layer -> field. Units are read from the feed itself and published with the snapshot.
const FEEDS: Record<string, string> = {
  tempC: "lufttemperatur-10min",
  precipMm: "niederschlag-10min",
  windKmh: "windgeschwindigkeit-kmh-10min",
  gustKmh: "wind-boeenspitze-kmh-10min",
  humidityPct: "luftfeuchtigkeit-10min",
  dewPointC: "taupunkt-10min",
  pressureHpa: "luftdruck-qfe-10min",
  sunshineMin: "sonnenscheindauer-10min",
  radiationWm2: "globalstrahlung-10min",
  foehn: "foehn-10min",
  snowCm: "gesamtschnee-1d",
  newSnowCm: "neuschnee-1d",
};
export const FIELDS = Object.keys(FEEDS);
const url = (layer: string) => `https://data.geo.admin.ch/ch.meteoschweiz.messwerte-${layer}/ch.meteoschweiz.messwerte-${layer}_en.json`;
const LAPSE = 0.0065; // °C per metre
export const GRID = { west: 5.4, south: 45.55, east: 11.0, north: 48.05, step: 0.0125 }; // = the viewer's map bounds

export type WeatherStation = { id: string; name: string; lat: number; lon: number; altitudeM: number; measuredAt: number | null } & Record<string, number | null | string>;
type ModelPoint = { lat: number; lon: number; altitudeM: number; tempC: number };

export type WeatherOverride = {
  id: string;
  label: string;
  lat: number;
  lon: number;
  radiusKm: number;
  tempC?: number; // set the temperature
  tempDeltaC?: number; // or shift it
  minTempC?: number; // and keep it at least this warm (heavy rain stays rain at night)
  precipMm?: number;
  phase?: "rain" | "snow"; // what falls, decided from the temperature in the area when it is created
  windKmh?: number;
  gustKmh?: number;
  startedAt: number;
  endsAt: number | null;
  endedAt?: number;
  disruptionIds: string[]; // consequences on the trains (heat, storm, heavy rain, frost)
};

export const weather = {
  stations: new Map<string, WeatherStation>(), // measured values
  units: {} as Record<string, string>,
  raw: undefined as undefined | { cols: number; rows: number; values: (number | null)[]; measuredAt: number },
  grid: undefined as undefined | { cols: number; rows: number; values: (number | null)[]; measuredAt: number }, // with overrides
  precipRaw: undefined as undefined | number[],
  precip: undefined as undefined | number[], // mm per 10 minutes, with overrides
  overrides: new Map<string, WeatherOverride>(),
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
const KM_LON = 111.32 * Math.cos((46.8 * Math.PI) / 180);
const km = (lat1: number, lon1: number, lat2: number, lon2: number) => Math.hypot((lon2 - lon1) * KM_LON, (lat2 - lat1) * 111.32);

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
type Feed = { features: { id: string; geometry: { coordinates: [number, number] }; properties: { station_name: string; value: number; unit?: string; reference_ts: string; altitude: string; wind_direction?: number } }[] };
async function fetchFeed(layer: string) {
  const r = await fetch(url(layer), { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`MeteoSwiss ${layer}: HTTP ${r.status}`);
  return (await r.json()) as Feed;
}

let border: ModelPoint[] = [];
let borderAt = 0;
/** Open-Meteo current temperatures on a 0.4° lattice, away from MeteoSwiss stations (mostly abroad). */
async function refreshBorder(stations: WeatherStation[]) {
  if (Date.now() - borderAt < 30 * 60_000 && border.length) return;
  const pts: [number, number][] = [];
  for (let lat = GRID.south; lat <= GRID.north + 1e-9; lat += 0.4)
    for (let lon = GRID.west; lon <= GRID.east + 1e-9; lon += 0.4)
      if (!stations.some((s) => s.tempC !== null && km(s.lat, s.lon, lat, lon) < 15)) pts.push([Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]);
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p[0]).join(",")}&longitude=${pts.map((p) => p[1]).join(",")}&current=temperature_2m`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const body = (await r.json()) as { latitude: number; longitude: number; elevation: number; current: { temperature_2m: number } }[];
  border = (Array.isArray(body) ? body : [body]).filter((x) => typeof x.current?.temperature_2m === "number").map((x) => ({ lat: x.latitude, lon: x.longitude, altitudeM: x.elevation, tempC: x.current.temperature_2m }));
  borderAt = Date.now();
}

export async function pollWeather() {
  try {
    if (!dem) await loadDem().catch((e) => console.warn("[weather] terrain model unavailable:", e.message));
    const layers = Object.entries(FEEDS);
    const feeds = await Promise.all(layers.map(([, layer]) => fetchFeed(layer).catch(() => undefined)));
    if (!feeds[0]) throw new Error("MeteoSwiss temperature feed unavailable");
    const stations = new Map<string, WeatherStation>();
    layers.forEach(([field], k) => {
      const feed = feeds[k];
      if (!feed) return;
      for (const f of feed.features) {
        const p = f.properties;
        let s = stations.get(f.id);
        if (!s) {
          const { lon, lat } = lv95ToWgs84(f.geometry.coordinates[0], f.geometry.coordinates[1]);
          s = { id: f.id, name: p.station_name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, altitudeM: Math.round(Number(p.altitude)), measuredAt: null } as WeatherStation;
          for (const name of FIELDS) s[name] = null;
          s.windDirDeg = null;
          stations.set(f.id, s);
        }
        if (p.unit && !weather.units[field]) weather.units[field] = p.unit;
        const valid = typeof p.value === "number" && Math.abs(p.value) < 9000; // 99999 marks a missing value
        s[field] = valid ? p.value : null;
        // the wind layer also says where the wind comes from (degrees clockwise from north)
        if (field === "windKmh") s.windDirDeg = typeof p.wind_direction === "number" && p.wind_direction >= 0 && p.wind_direction <= 360 ? p.wind_direction : null;
        const ts = Date.parse(p.reference_ts);
        if (valid && field === "tempC" && Number.isFinite(ts)) s.measuredAt = Math.max(s.measuredAt ?? 0, ts);
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
  const pts = [...measured.map((s) => ({ lat: s.lat, lon: s.lon, altitudeM: s.altitudeM, tempC: s.tempC as number })), ...border];
  const cols = Math.round((GRID.east - GRID.west) / GRID.step) + 1;
  const rows = Math.round((GRID.north - GRID.south) / GRID.step) + 1;
  const values: (number | null)[] = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r++) {
    const lat = GRID.north - r * GRID.step;
    for (let c = 0; c < cols; c++) {
      const lon = GRID.west + c * GRID.step;
      let num = 0;
      let den = 0;
      for (const s of pts) {
        const dx = (s.lon - lon) * KM_LON;
        const dy = (s.lat - lat) * 111.32;
        const d2 = dx * dx + dy * dy;
        if (d2 > 90 * 90) continue;
        const w = 1 / Math.max(d2, 0.25) ** 1.2;
        num += w * (s.tempC + LAPSE * s.altitudeM);
        den += w;
      }
      if (!den) continue;
      const z = elevation(lon, lat);
      values[r * cols + c] = Math.round((num / den - LAPSE * (z ?? 500)) * 10) / 10;
    }
  }
  weather.raw = { cols, rows, values, measuredAt: Math.max(0, ...measured.map((s) => s.measuredAt ?? 0)) };
  // precipitation: plain inverse-distance weighting of the stations that measure it (no altitude effect), 25 km reach
  const wet = [...weather.stations.values()].filter((s) => typeof s.precipMm === "number");
  const precip = new Array(cols * rows).fill(0);
  for (let r = 0; r < rows; r++) {
    const lat = GRID.north - r * GRID.step;
    for (let c = 0; c < cols; c++) {
      const lon = GRID.west + c * GRID.step;
      let num = 0;
      let den = 0;
      for (const s of wet) {
        const dx = (s.lon - lon) * KM_LON;
        const dy = (s.lat - lat) * 111.32;
        const d2 = dx * dx + dy * dy;
        if (d2 > 25 * 25) continue;
        const w = 1 / Math.max(d2, 0.25);
        num += w * (s.precipMm as number);
        den += w;
      }
      precip[r * cols + c] = den ? Math.round((num / den) * 100) / 100 : 0;
    }
  }
  weather.precipRaw = precip;
  applyOverrides();
}

// ---------------------------------------------------------------- overrides
/** 1 inside 70 % of the radius, then a cosine fade to 0 at the edge: no hard rims on the map. */
const weight = (d: number, r: number) => (d >= r ? 0 : d <= 0.7 * r ? 1 : 0.5 * (1 + Math.cos((Math.PI * (d - 0.7 * r)) / (0.3 * r))));
const active = () => [...weather.overrides.values()].filter((o) => !o.endedAt);

function applyOverrides() {
  if (!weather.raw) return;
  const { cols, rows } = weather.raw;
  const values = weather.raw.values.slice();
  for (const o of active()) {
    if (o.tempC === undefined && o.tempDeltaC === undefined && o.minTempC === undefined) continue;
    const r0 = Math.max(0, Math.floor((GRID.north - (o.lat + o.radiusKm / 111.32)) / GRID.step));
    const r1 = Math.min(rows - 1, Math.ceil((GRID.north - (o.lat - o.radiusKm / 111.32)) / GRID.step));
    const c0 = Math.max(0, Math.floor((o.lon - o.radiusKm / KM_LON - GRID.west) / GRID.step));
    const c1 = Math.min(cols - 1, Math.ceil((o.lon + o.radiusKm / KM_LON - GRID.west) / GRID.step));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const v = values[i];
        if (v === null) continue;
        const w = weight(km(GRID.north - r * GRID.step, GRID.west + c * GRID.step, o.lat, o.lon), o.radiusKm);
        if (!w) continue;
        let x = o.tempC !== undefined ? v * (1 - w) + o.tempC * w : v + (o.tempDeltaC ?? 0) * w;
        if (o.minTempC !== undefined && x < o.minTempC) x += (o.minTempC - x) * w;
        values[i] = Math.round(x * 10) / 10;
      }
  }
  weather.grid = { ...weather.raw, values };
  if (weather.precipRaw) {
    const p = weather.precipRaw.slice();
    for (const o of active()) {
      if (o.precipMm === undefined) continue;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const w = weight(km(GRID.north - r * GRID.step, GRID.west + c * GRID.step, o.lat, o.lon), o.radiusKm);
          if (w) p[r * cols + c] = Math.round((p[r * cols + c] * (1 - w) + o.precipMm * w) * 100) / 100;
        }
    }
    weather.precip = p;
  }
}
/** Temperature from the (overridden) grid at a point, nearest cell. */
export function temperatureAt(lon: number, lat: number) {
  const g = weather.grid;
  if (!g) return undefined;
  const c = Math.round((lon - GRID.west) / GRID.step);
  const r = Math.round((GRID.north - lat) / GRID.step);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return undefined;
  return g.values[r * g.cols + c] ?? undefined;
}

/** A station with the overrides that cover it applied. */
export function effective(s: WeatherStation): WeatherStation {
  let out = s;
  for (const o of active()) {
    const w = weight(km(s.lat, s.lon, o.lat, o.lon), o.radiusKm);
    if (!w) continue;
    out = { ...out };
    const blend = (field: string, value: number | undefined) => {
      if (value === undefined) return;
      const cur = out[field];
      out[field] = Math.round((typeof cur === "number" ? cur * (1 - w) + value * w : value) * 10) / 10;
    };
    if (o.tempC !== undefined) blend("tempC", o.tempC);
    else if (o.tempDeltaC !== undefined && typeof out.tempC === "number") out.tempC = Math.round((out.tempC + o.tempDeltaC * w) * 10) / 10;
    blend("precipMm", o.precipMm);
    blend("windKmh", o.windKmh);
    blend("gustKmh", o.gustKmh);
  }
  return out;
}

export function addOverride(input: Omit<WeatherOverride, "id" | "startedAt" | "endedAt" | "disruptionIds"> & { minutes?: number | null }) {
  const now = Date.now();
  const o: WeatherOverride = {
    id: `w-${randomUUID().slice(0, 8)}`,
    label: input.label,
    lat: input.lat,
    lon: input.lon,
    radiusKm: Math.max(2, Math.min(150, input.radiusKm)),
    tempC: input.tempC,
    tempDeltaC: input.tempDeltaC,
    minTempC: input.minTempC,
    precipMm: input.precipMm,
    windKmh: input.windKmh,
    gustKmh: input.gustKmh,
    startedAt: now,
    endsAt: input.minutes ? now + input.minutes * 60_000 : null,
    disruptionIds: [],
  };
  weather.overrides.set(o.id, o);
  applyOverrides();
  publishOverride(o);
  return o;
}
export function endOverride(id: string) {
  const o = weather.overrides.get(id);
  if (!o || o.endedAt) return o;
  o.endedAt = Date.now();
  applyOverrides();
  publishOverride(o);
  return o;
}
export function removeOverride(id: string) {
  const o = endOverride(id);
  weather.overrides.delete(id);
  clear(`truth/weather/${id}`);
  return o;
}
/** Ends overrides whose time is up; returns them so their consequences can end too. */
export function expireOverrides(t = Date.now()) {
  const ended: WeatherOverride[] = [];
  for (const o of active()) if (o.endsAt && t >= o.endsAt) ended.push(endOverride(o.id)!);
  for (const o of [...weather.overrides.values()]) if (o.endedAt && t - o.endedAt > 30 * 60_000) removeOverride(o.id);
  return ended;
}
export const overridePayload = (o: WeatherOverride) => ({ v: 1, ...o, status: o.endedAt ? "ended" : "active" });
/** Only the override's own retained message (after its consequences and phase are known). */
export const publishOverrideState = (o: WeatherOverride) => publish(`truth/weather/${o.id}`, overridePayload(o), { retain: true, qos: 1 });
function publishOverride(o: WeatherOverride) {
  publish(`truth/weather/${o.id}`, overridePayload(o), { retain: true, qos: 1 });
  lastSig = ""; // republish the weather now
  publishWeather();
}

// ---------------------------------------------------------------- publishing
let lastSig = "";
export function publishWeather() {
  const sig = `${weather.fetchedAt}|${active().map((o) => o.id).join(",")}`;
  if (!weather.fetchedAt || sig === lastSig) return;
  lastSig = sig;
  const list = [...weather.stations.values()].map(effective);
  const source = "MeteoSwiss SwissMetNet (open data)";
  for (const s of list) publish(`weather/stations/${s.id}`, { v: 1, ...s, source }, { retain: true, qos: 1 });
  const fields = ["id", "name", "lat", "lon", "altitudeM", ...FIELDS, "windDirDeg", "measuredAt"];
  weather.units.windDirDeg = "° (where the wind comes from, clockwise from north)";
  const snapshot = { v: 1, ts: Date.now(), measuredAt: weather.grid?.measuredAt ?? null, source, units: weather.units, fields, stations: list.map((s) => fields.map((f) => s[f] ?? null)) };
  publish("weather/snapshot", snapshot, { retain: true, qos: 1 });
  channel.send("weather", { type: "weather", snapshot });
  if (weather.grid && weather.precip) {
    const grid = { v: 1, ts: Date.now(), measuredAt: weather.grid.measuredAt, unit: "mm per 10 minutes", phase: "snow where the temperature-grid value of the same cell is <= 1 °C, rain above", method: "inverse-distance weighting of MeteoSwiss stations within 25 km", bbox: [GRID.west, GRID.south, GRID.east, GRID.north], step: GRID.step, cols: weather.grid.cols, rows: weather.grid.rows, order: "row-major from north-west", values: weather.precip };
    publish("weather/precipitation-grid", grid, { retain: true, qos: 1 });
    channel.send("precip", { type: "precip", grid });
  }
  if (weather.grid) {
    const grid = { v: 1, ts: Date.now(), measuredAt: weather.grid.measuredAt, unit: "°C", method: "inverse-distance weighting of MeteoSwiss stations (plus Open-Meteo model values outside Switzerland), corrected for altitude (6.5 °C/km, terrain model)", bbox: [GRID.west, GRID.south, GRID.east, GRID.north], step: GRID.step, cols: weather.grid.cols, rows: weather.grid.rows, order: "row-major from north-west", values: weather.grid.values };
    publish("weather/temperature-grid", grid, { retain: true, qos: 1 });
    channel.send("grid", { type: "grid", grid });
  }
}
export const activeOverrides = active;
