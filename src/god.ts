// God mode: weather overrides and their consequences on the trains, protection switch, releasing trains.
import { addSystemDisruption, disruptions, type Disruption } from "./disruptions.ts";
import { edgeMidpoint, edgesWithin } from "./geometry.ts";
import { settings } from "./engine.ts";
import { addOverride, elevation, endOverride, expireOverrides, temperatureAt, weather, type WeatherOverride } from "./weather.ts";

export const WEATHER_PRESETS = [
  { id: "heatwave", label: "Heatwave", tempC: 38 },
  { id: "cold", label: "Cold snap", tempC: -18 },
  { id: "storm", label: "Storm", windKmh: 70, gustKmh: 120, precipMm: 6, tempDeltaC: -4 }, // a cold front: it also cools
  { id: "rain", label: "Heavy rain", precipMm: 12, tempDeltaC: -2 },
  { id: "snow", label: "Snowfall", tempC: -3, precipMm: 3 },
  { id: "blizzard", label: "Heavy snowfall", tempC: -6, precipMm: 6, windKmh: 40, gustKmh: 70 },
  { id: "warmer", label: "Warmer (+5 °C)", tempDeltaC: 5 },
  { id: "colder", label: "Colder (−5 °C)", tempDeltaC: -5 },
] as const;

/** What extreme weather does to the railway inside the area (the network reacts on its own). */
function consequences(o: WeatherOverride): Disruption[] {
  const edges = edgesWithin(o.lat, o.lon, o.radiusKm * 0.85);
  if (!edges.size) return [];
  const scope = { kind: "area" as const, lat: o.lat, lon: o.lon, radiusKm: o.radiusKm };
  const where = o.label;
  const add = (type: string, label: string, reasonCode: string, effect: Disruption["effect"], params: Disruption["params"]) =>
    addSystemDisruption({ type, label, reasonCode, effect, scope, where, params, edges, endsAt: o.endsAt, origin: `weather override ${o.id}` });
  const out: Disruption[] = [];
  // the temperature in the area decides rain or snow (the same storm can rain in valleys and snow higher up)
  const temp = o.tempC ?? temperatureAt(o.lon, o.lat) ?? 5;
  const precip = o.precipMm ?? 0;
  const snow = precip >= 1 && temp <= 1;
  if (temp >= 35) out.push(add("heat", "Heat: track buckling risk", "EG_006", "speed_restriction", { maxKmh: 80 }));
  if (temp <= -15) out.push(add("frost", "Frost: icing of points and overhead lines", "EG_016", "speed_restriction", { maxKmh: 60 }));
  if ((o.gustKmh ?? 0) >= 100) out.push(add("storm", "Storm: lines closed", "EG_101", "section_closure", {}));
  else if ((o.gustKmh ?? 0) >= 75) out.push(add("wind", "Strong wind: reduced speed", "EG_101", "speed_restriction", { maxKmh: 60 }));
  if (snow) {
    out.push(add("snow", precip >= 4 ? "Heavy snowfall: slow running" : "Snow on the tracks: reduced speed", "EG_023", "speed_restriction", { maxKmh: precip >= 4 ? 40 : 60 }));
    if (precip >= 4) {
      // avalanche risk closes the mountain lines in the area (track above ~1,100 m)
      const mountain = new Set([...edges].filter((ref) => {
        const mid = edgeMidpoint(ref);
        return mid !== undefined && (elevation(mid[0], mid[1]) ?? 0) >= 1100;
      }));
      if (mountain.size) out.push(addSystemDisruption({ type: "avalanche", label: "Avalanche risk: mountain lines closed", reasonCode: "EG_022", effect: "section_closure", scope, where, params: {}, edges: mountain, endsAt: o.endsAt, origin: `weather override ${o.id}` }));
    }
  } else if (precip >= 8) out.push(add("rain", "Heavy rain: landslide risk", "EG_018", "speed_restriction", { maxKmh: 40 }));
  return out;
}

export function setWeather(input: Parameters<typeof addOverride>[0]) {
  const o = addOverride(input);
  o.disruptionIds = consequences(o).map((d) => d.id);
  return { override: o, consequences: o.disruptionIds.map((id) => disruptions.get(id)!) };
}
export function endWeather(id: string) {
  const o = endOverride(id);
  for (const d of o?.disruptionIds ?? []) {
    const x = disruptions.get(d);
    if (x && !x.endedAt) x.endedAt = Date.now();
  }
  return o;
}
/** Called every few seconds: overrides whose time is up end, with their consequences. */
export function expireWeather() {
  for (const o of expireOverrides()) for (const d of o.disruptionIds) {
    const x = disruptions.get(d);
    if (x && !x.endedAt) x.endedAt = Date.now();
  }
}

/** Ends everything we did to one train (stops, holds, speeds, obstacles): it moves on, still late until synced. */
export function releaseTrain(trainId: string) {
  const ended: string[] = [];
  for (const d of disruptions.values())
    if (!d.endedAt && d.scope.kind === "train" && d.scope.trainId === trainId) {
      d.endedAt = Date.now();
      ended.push(d.id);
    }
  return ended;
}
/** Ends every disruption and weather override. */
export function releaseAll() {
  let n = 0;
  for (const d of disruptions.values()) if (!d.endedAt) {
    d.endedAt = Date.now();
    n++;
  }
  for (const o of weather.overrides.values()) if (!o.endedAt) {
    endWeather(o.id);
    n++;
  }
  return n;
}
export function setProtection(on: boolean) {
  settings.protection = on;
  return settings;
}
