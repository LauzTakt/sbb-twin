// God-mode state survives restarts: disruptions, weather changes, marked incidents and switches are saved to disk
// (every couple of seconds when something changed) and restored at startup.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { disruptions, incidents, type Disruption, type Incident } from "./disruptions.ts";
import { settings } from "./engine.ts";
import { weather, type WeatherOverride } from "./weather.ts";

const FILE = join(config.dataDir, "state.json");
type Saved = { disruptions: (Omit<Disruption, "edges" | "affected"> & { edges: number[]; affected: string[] })[]; overrides: WeatherOverride[]; incidents: Incident[]; settings: typeof settings };

function snapshot(): Saved {
  return {
    disruptions: [...disruptions.values()].map((d) => ({ ...d, edges: [...d.edges], affected: [...d.affected] })),
    overrides: [...weather.overrides.values()],
    incidents: [...incidents.values()],
    settings: { ...settings },
  };
}

let last = "";
export function saveState() {
  const body = JSON.stringify(snapshot());
  if (body === last) return;
  last = body;
  writeFileSync(`${FILE}.tmp`, body);
  renameSync(`${FILE}.tmp`, FILE);
}

/** Restore the saved state; returns what came back so it can be republished. */
export function loadState() {
  if (!existsSync(FILE)) return { disruptions: 0, overrides: 0, incidents: 0 };
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8")) as Saved;
    for (const d of s.disruptions) disruptions.set(d.id, { ...d, edges: new Set(d.edges), affected: new Set(d.affected) });
    for (const o of s.overrides) weather.overrides.set(o.id, o);
    for (const i of s.incidents) incidents.set(i.id, i);
    Object.assign(settings, s.settings);
    last = JSON.stringify(snapshot());
    return { disruptions: s.disruptions.length, overrides: s.overrides.length, incidents: s.incidents.length };
  } catch (err) {
    console.warn("[sbb-twin] could not restore the saved state:", (err as Error).message);
    return { disruptions: 0, overrides: 0, incidents: 0 };
  }
}
