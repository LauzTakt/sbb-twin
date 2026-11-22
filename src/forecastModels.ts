// The forecast models are plain JSON trained offline (research/<model>/, contract: research/forecast-contract.md) and
// applied in TypeScript; no Python runs here. Until a model lands, a clearly marked placeholder of the same shape
// (data/forecast-placeholders/<model>/) keeps the twin buildable, and everything computed from it says "placeholder".
// Files are checked again every minute, so a model that lands (git pull) is used without a restart.
import type { ModelSource, Models, Scorecard } from "./contracts/forecasts.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../");
const RESEARCH = process.env.RAIL_RESEARCH_DIR ?? here("../research/");
const PLACEHOLDERS = here("../data/forecast-placeholders/");

type Loaded<T> = { data: T | null; source: ModelSource; file: string; mtime: number };

export type DurationModel = {
  name: string; version: string; trainedOn?: string; testedOn?: string;
  type: "aft_lognormal" | "discrete_hazard";
  intercept?: number; sigma?: number; binIntercepts?: number[];
  coef: Record<string, number>;
  causeMap: Record<string, string>;
  horizonsMin?: number[];
  interval?: { level: number; method: string; lowLogShift: number; highLogShift: number; rule?: string };
  announced?: { minMinutes?: number; maxMinutes?: number };
  pointForecast?: { withAnnouncedEnd?: string; correctionMin?: number; withoutAnnouncedEnd?: string };
  causeText?: Record<string, string>; // phrase (en/de/fr/it, lower case) -> cause group
  placeholder?: boolean;
};
export type ResumptionModel = { name: string; version: string; a: number; b: number; bands: { min: number; label: string }[]; trainedOn?: string; testedOn?: string; placeholder?: boolean };
export type Segments = { type: "FeatureCollection"; placeholder?: boolean; features: { type: "Feature"; properties: Record<string, unknown>; geometry: unknown }[] };

function read<T>(model: string, file: string): Loaded<T> {
  for (const [path, source] of [[join(RESEARCH, model, file), "real"], [join(PLACEHOLDERS, model, file), "placeholder"]] as const) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as T & { placeholder?: boolean };
      return { data, source: data?.placeholder ? "placeholder" : source, file: relative(ROOT, path), mtime: statSync(path).mtimeMs };
    } catch (err) {
      console.warn(`[forecast] ${path} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return { data: null, source: "missing", file: "", mtime: 0 };
}

const FILES = {
  duration: ["duration", "model.json"],
  durationCard: ["duration", "scorecard.json"],
  resumption: ["post_resumption", "model.json"],
  resumptionCard: ["post_resumption", "scorecard.json"],
  segments: ["section_risk", "segments.geojson"],
  segmentsCard: ["section_risk", "scorecard.json"],
} as const;
type Key = keyof typeof FILES;
type Shapes = { duration: DurationModel; durationCard: Scorecard; resumption: ResumptionModel; resumptionCard: Scorecard; segments: Segments; segmentsCard: Scorecard };
const cache = new Map<Key, Loaded<unknown>>();
/** Bumped whenever a model file changed: forecasts recompute, the segments are served again. */
export const modelsGeneration = { n: 0 };

export function loaded<K extends Key>(k: K): Loaded<Shapes[K]> {
  let hit = cache.get(k);
  if (!hit) {
    hit = read(FILES[k][0], FILES[k][1]);
    cache.set(k, hit);
  }
  return hit as Loaded<Shapes[K]>;
}
/** The file a model would be read from now, and its modification time. */
function locate(k: Key) {
  const [m, f] = FILES[k];
  for (const path of [join(RESEARCH, m, f), join(PLACEHOLDERS, m, f)]) if (existsSync(path)) return { file: relative(ROOT, path), mtime: statSync(path).mtimeMs };
  return { file: "", mtime: 0 };
}
/** Look for new or changed files (a real model replacing its placeholder). */
export function refreshModels() {
  let changed = false;
  for (const k of Object.keys(FILES) as Key[]) {
    const old = cache.get(k);
    if (!old) continue; // read on first use
    const now = locate(k);
    if (now.file === old.file && now.mtime === old.mtime) continue;
    cache.delete(k);
    const next = loaded(k);
    console.log(`[forecast] ${FILES[k].join("/")}: ${next.source} (${next.file || "none"})`);
    changed = true;
  }
  if (changed) modelsGeneration.n++;
  return changed;
}

/** What /api/forecasts says about each model. */
export function modelInfo(): Models {
  const d = loaded("duration");
  const r = loaded("resumption");
  const s = loaded("segments");
  const card = loaded("segmentsCard").data;
  return {
    duration: { name: "duration", version: d.data?.version ?? "none", source: d.source, type: d.data?.type, trainedOn: d.data?.trainedOn, testedOn: d.data?.testedOn, file: d.file },
    post_resumption: { name: "post_resumption", version: r.data?.version ?? "none", source: r.source, type: "logistic", trainedOn: r.data?.trainedOn, testedOn: r.data?.testedOn, file: r.file },
    section_risk: { name: "section_risk", version: card?.version ?? card?.generatedAt ?? (s.data ? "1" : "none"), source: s.source, type: "ranking", file: s.file },
  };
}
