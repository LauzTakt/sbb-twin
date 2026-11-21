// Disruptions we provoke deliberately (ground truth) and incidents we mark (public flags).
import { randomUUID } from "node:crypto";
import { edgesGeometry, sectionEdges } from "./geometry.ts";
import { stationIndex, stops } from "./timetable.ts";

export type Effect = "section_closure" | "speed_restriction" | "signal_failure" | "station_closure" | "train_breakdown" | "train_delay" | "cancellation" | "train_speed" | "skip_stop" | "target_speed" | "obstacle";
export type ScopeKind = "section" | "station" | "train";
export type DisruptionType = {
  id: string;
  label: string;
  reasonCode: string; // SBB public reason code (extern-liveticker lookup)
  effect: Effect;
  scope: ScopeKind;
  defaultMinutes: number | null;
  params?: { maxKmh?: number; holdMinutes?: number; kmh?: number; brakeMs2?: number; distanceM?: number };
  behaviour: string;
};

// Recognised SBB incident types (codes from the public live-ticker reason lookup), each mapped to what it does to trains.
export const TYPES: DisruptionType[] = [
  { id: "overhead_line_fault", label: "Overhead line fault", reasonCode: "EG_008", effect: "section_closure", scope: "section", defaultMinutes: 120, behaviour: "Section closed in both directions. Trains wait at the station before it; a train already inside brakes and stops on the line." },
  { id: "power_failure", label: "Power failure", reasonCode: "EG_011", effect: "section_closure", scope: "section", defaultMinutes: 60, behaviour: "As an overhead line fault: no train can run through the section." },
  { id: "person_accident", label: "Person accident", reasonCode: "EG_047", effect: "section_closure", scope: "section", defaultMinutes: 90, behaviour: "Section closed in both directions while emergency services work." },
  { id: "obstacle_on_track", label: "Obstacle or fallen tree on the track", reasonCode: "EG_100", effect: "section_closure", scope: "section", defaultMinutes: 45, behaviour: "Section closed in both directions until the line is cleared." },
  { id: "track_damage", label: "Track damage", reasonCode: "EG_006", effect: "speed_restriction", scope: "section", defaultMinutes: 120, params: { maxKmh: 40 }, behaviour: "Trains slow down to the speed limit on the section and lose time." },
  { id: "signal_box_failure", label: "Signal box failure", reasonCode: "EG_010", effect: "signal_failure", scope: "station", defaultMinutes: 60, params: { maxKmh: 30, holdMinutes: 3 }, behaviour: "Trains around the station run on sight (slowly) and wait a few minutes at it for manual clearance." },
  { id: "station_fire", label: "Fire in a station", reasonCode: "EG_110", effect: "station_closure", scope: "station", defaultMinutes: 60, behaviour: "Station closed: trains pass through without stopping." },
  { id: "rolling_stock_failure", label: "Train breakdown", reasonCode: "EG_014", effect: "train_breakdown", scope: "train", defaultMinutes: 40, behaviour: "The train brakes and stays where it is; following trains are held behind it." },
  { id: "technical_delay", label: "Delay at a station", reasonCode: "EG_014", effect: "train_delay", scope: "train", defaultMinutes: null, params: { holdMinutes: 8 }, behaviour: "The train waits at its next station for the given minutes, then continues late." },
  { id: "cancellation", label: "Train cancelled", reasonCode: "EG_063", effect: "cancellation", scope: "train", defaultMinutes: null, behaviour: "The train ends its run at the next station and leaves service." },
  { id: "train_speed_limit", label: "Speed limit for a train", reasonCode: "EG_014", effect: "train_speed", scope: "train", defaultMinutes: null, params: { maxKmh: 60 }, behaviour: "The train runs at most at the given speed (it brakes down to it) until the limit is removed." },
  { id: "skip_next_stop", label: "Skip the next stop", reasonCode: "EG_063", effect: "skip_stop", scope: "train", defaultMinutes: null, behaviour: "The train passes its next stop without stopping." },
  { id: "target_speed", label: "Target speed for a train", reasonCode: "EG_063", effect: "target_speed", scope: "train", defaultMinutes: null, params: { kmh: 120 }, behaviour: "The train accelerates or brakes to this speed and cruises there between its stops (it still stops at them and never leaves early)." },
  { id: "emergency_brake", label: "Emergency brake", reasonCode: "EG_014", effect: "train_breakdown", scope: "train", defaultMinutes: null, params: { brakeMs2: 1.2 }, behaviour: "The train brakes at 1.2 m/s² and stays where it stops; following trains are held behind it." },
  { id: "obstacle_collision", label: "Obstacle on the track ahead", reasonCode: "EG_100", effect: "obstacle", scope: "train", defaultMinutes: null, params: { distanceM: 400 }, behaviour: "An obstacle appears ahead: the train emergency-brakes; without enough distance it hits it at the remaining speed and is immobilised." },
];

export type Scope =
  | { kind: "section"; from: string; to: string }
  | { kind: "station"; station: string }
  | { kind: "train"; trainId: string }
  | { kind: "area"; lat: number; lon: number; radiusKm: number };

export type Disruption = {
  id: string;
  type: string;
  label: string;
  reasonCode: string;
  effect: Effect;
  scope: Scope;
  where: string; // human-readable place
  params: { maxKmh?: number; holdMinutes?: number; kmh?: number; brakeMs2?: number; distanceM?: number; atLeg?: number; atS?: number; impactKmh?: number; collidedAt?: number; withTrain?: string };
  startedAt: number;
  endsAt: number | null;
  endedAt?: number;
  note?: string;
  edges: Set<number>; // section: affected edge refs (unsigned)
  station?: number; // station: index
  geometry: GeoJsonGeometry | null; // where it is, for maps
  affected: Set<string>; // trains whose behaviour it changed
};
export type GeoJsonGeometry = { type: "MultiLineString"; coordinates: number[][][] } | { type: "Point"; coordinates: number[] } | { type: "LineString"; coordinates: number[][] } | { type: "Polygon"; coordinates: number[][][] };

export type Incident = {
  id: string;
  title: string;
  description: string;
  severity: "info" | "minor" | "major" | "critical";
  type?: string;
  reasonCode?: string;
  scope: Scope | { kind: "line"; line: string } | { kind: "network" };
  where: string;
  geometry: GeoJsonGeometry | null;
  disruptionId?: string;
  source?: "staff" | "auto"; // "auto": opened and closed by the twin's own detection (src/auto.ts)
  trainIds?: string[]; // automatic incidents: the trains concerned
  createdAt: number;
  updatedAt: number;
};

export const disruptions = new Map<string, Disruption>();
export const incidents = new Map<string, Incident>();

const stationName = (id: string) => stops[stationIndex(id) ?? -1]?.name ?? id;
export function describeScope(scope: Scope): string {
  if (scope.kind === "section") return `${stationName(scope.from)} – ${stationName(scope.to)}`;
  if (scope.kind === "station") return stationName(scope.station);
  if (scope.kind === "area") return `${scope.radiusKm} km around ${scope.lat.toFixed(3)}, ${scope.lon.toFixed(3)}`;
  return scope.trainId;
}

/** A disruption created by sbb-twin itself (weather consequences, rear-end collisions), not from the API. */
export function addSystemDisruption(input: { type: string; label: string; reasonCode: string; effect: Effect; scope: Scope; where: string; params?: Disruption["params"]; edges?: Set<number>; endsAt?: number | null; origin: string }): Disruption {
  const d: Disruption = {
    id: `d-${randomUUID().slice(0, 8)}`,
    type: input.type,
    label: input.label,
    reasonCode: input.reasonCode,
    effect: input.effect,
    scope: input.scope,
    where: input.where,
    params: { ...input.params },
    startedAt: Date.now(),
    endsAt: input.endsAt ?? null,
    note: input.origin,
    edges: input.edges ?? new Set(),
    geometry: input.scope.kind === "area" ? circle(input.scope.lat, input.scope.lon, input.scope.radiusKm) : input.edges?.size ? edgesGeometry(input.edges) : null,
    affected: new Set(),
  };
  disruptions.set(d.id, d);
  return d;
}
/** A light polygon for an area (a disruption over an area sends its circle, not every track inside it). */
function circle(lat: number, lon: number, radiusKm: number): GeoJsonGeometry {
  const ring: number[][] = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    ring.push([Math.round((lon + (radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a)) * 1e5) / 1e5, Math.round((lat + (radiusKm / 111.32) * Math.sin(a)) * 1e5) / 1e5]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export class InputError extends Error {}

export type TrainLookup = (id: string) => { label: string; nextStation?: number; obstacleAt?: (distanceM: number) => { leg: number; s: number } | undefined } | undefined;
export function createDisruption(input: { type: string; scope: Scope; minutes?: number | null; params?: Disruption["params"]; note?: string }, train?: TrainLookup): Disruption {
  const type = TYPES.find((t) => t.id === input.type);
  if (!type) throw new InputError(`Unknown disruption type "${input.type}"`);
  const scope = input.scope;
  if (!scope || scope.kind !== type.scope) throw new InputError(`"${type.id}" needs a ${type.scope} scope`);
  let edges = new Set<number>();
  let station: number | undefined;
  if (scope.kind === "section") {
    const a = stationIndex(scope.from);
    const b = stationIndex(scope.to);
    if (a === undefined || b === undefined || a === b) throw new InputError("A section needs two different known stations");
    edges = sectionEdges(stops[a], stops[b]);
    if (!edges.size) throw new InputError("No track found between these stations");
  } else if (scope.kind === "station") {
    station = stationIndex(scope.station);
    if (station === undefined) throw new InputError("Unknown station");
  } else {
    const t = train?.(scope.trainId);
    if (!t) throw new InputError("That train is not in service now");
    if (type.effect === "skip_stop") station = t.nextStation;
    if (type.effect === "obstacle") {
      const at = t.obstacleAt?.(Math.max(30, Number(input.params?.distanceM ?? type.params?.distanceM ?? 400)));
      if (!at) throw new InputError("No track ahead of this train");
      input = { ...input, params: { ...input.params, atLeg: at.leg, atS: at.s } };
    }
  }
  const minutes = input.minutes === undefined ? type.defaultMinutes : input.minutes;
  const now = Date.now();
  const d: Disruption = {
    id: `d-${randomUUID().slice(0, 8)}`,
    type: type.id,
    label: type.label,
    reasonCode: type.reasonCode,
    effect: type.effect,
    scope,
    where: scope.kind === "train" ? `${train?.(scope.trainId)?.label ?? scope.trainId}${type.effect === "skip_stop" && station !== undefined ? ` (skips ${stops[station].name})` : ""}` : describeScope(scope),
    params: { ...type.params, ...input.params },
    startedAt: now,
    endsAt: minutes ? now + minutes * 60_000 : null,
    note: input.note,
    edges,
    station,
    geometry: scope.kind === "section" ? edgesGeometry(edges) : scope.kind === "station" && station !== undefined ? { type: "Point", coordinates: [stops[station].lon, stops[station].lat] } : null,
    affected: new Set(),
  };
  disruptions.set(d.id, d);
  return d;
}

function scopeGeometry(scope: Incident["scope"]): GeoJsonGeometry | null {
  if (scope.kind === "station") {
    const s = stops[stationIndex(scope.station) ?? -1];
    return s ? { type: "Point", coordinates: [s.lon, s.lat] } : null;
  }
  if (scope.kind === "section") {
    const a = stationIndex(scope.from);
    const b = stationIndex(scope.to);
    return a !== undefined && b !== undefined ? edgesGeometry(sectionEdges(stops[a], stops[b])) : null;
  }
  return null;
}

export function createIncident(input: Partial<Incident> & { title: string }): Incident {
  const now = Date.now();
  const scope = (input.scope ?? { kind: "network" }) as Incident["scope"];
  const where = input.where ?? ("kind" in scope && (scope.kind === "section" || scope.kind === "station" || scope.kind === "train") ? describeScope(scope as Scope) : scope.kind === "line" ? `Line ${scope.line}` : "Network");
  const inc: Incident = {
    id: input.id ?? `i-${randomUUID().slice(0, 8)}`,
    title: input.title,
    description: input.description ?? "",
    severity: input.severity ?? "major",
    type: input.type,
    reasonCode: input.reasonCode,
    scope,
    where,
    disruptionId: input.disruptionId,
    geometry: input.geometry ?? scopeGeometry(scope),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  incidents.set(inc.id, inc);
  return inc;
}
