// Disruptions we provoke deliberately (ground truth) and incidents we mark (public flags).
import { randomUUID } from "node:crypto";
import { edgesGeometry, sectionEdges } from "./geometry.ts";
import { stationIndex, stops } from "./timetable.ts";
import type { DurationType, EffectState, MeasureType, Proposal } from "./catalogue.ts";

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
  { id: "breakdown", label: "Train breakdown", reasonCode: "EG_014", effect: "train_breakdown", scope: "train", defaultMinutes: null, behaviour: "The train stops where it is. Its section becomes an interrupted disruption (train blocking the line), with a bulletin; both end when the train is released." },
  { id: "cancellation", label: "Train cancelled", reasonCode: "EG_063", effect: "cancellation", scope: "train", defaultMinutes: null, behaviour: "The train ends its run at the next station and leaves service." },
];
const ALIASES: Record<string, string> = { rolling_stock_failure: "breakdown", emergency_brake: "breakdown" };

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
  scenario?: Scenario; // a disruption with a cause, an effect state and the control centre's measures (src/scenario.ts)
};

export type Measure = {
  id: string;
  type: MeasureType;
  at: number; // when it takes effect
  announcedAt: number; // when it was decided (published)
  params: Record<string, unknown>;
  withdrawAt?: number; // replacement bus: no departures from then on
  withdrawnAnnouncedAt?: number;
};
export type BulletinMessage = { ts: number; title: string; text: string };
export type Bulletin = {
  id: string;
  version: number;
  ts: number;
  lang: "en" | "de" | "fr" | "it";
  lifecycle: "INFO" | "ENDED";
  title: string;
  description: string;
  lines: string[];
  messages: BulletinMessage[];
  source: "template" | "ai"; // ai: Claude Haiku's wording of the same facts, validated (src/bulletinAI.ts)
  template?: string; // the deterministic text it was written from
};
export type Scenario = {
  cause: { code: string; label: string };
  initial: EffectState;
  start: number;
  durationType: DurationType;
  until: number | null;
  measures: Measure[];
  lines: string[];
  a: string; // section end A (or the station)
  b?: string; // section end B
  inside: string[]; // stations between A and B (closed with the section)
  busStops: string[]; // A, the stations between, B: the replacement bus route
  committed: Record<string, number>; // trip key -> last served call, decided and carried out (stays after a resume)
  committedStart?: Record<string, number>; // trip key -> first served call, for trips that entered service after the section
  bulletins: Bulletin[]; // every version, oldest first
  proposal: Proposal;
  linkedTrain?: string; // created by a train breakdown: ends when the train is released
  warnings?: string[]; // e.g. a section too long for a replacement bus
  resumedAt?: number;
};

/** The effective timetable's changes to one trip (computed from the scenario disruptions, src/scenario.ts). */
export type TripChange = {
  by: string; // disruption id
  cut?: number; // last served call: the run ends there, later calls are cancelled (0 = the whole trip is cancelled)
  startAt?: number; // first served call: its origin side is closed, so it starts after the section (the unit turned there)
  holdAt?: number; // the call where it waits for the section to reopen
  holdUntil?: number; // expected reopening
  reason: "short_turn" | "cancel_lines" | "one_track_open" | "hold";
  committed?: boolean; // the train has reached its cut (set by the engine)
};
export const tripChanges = new Map<string, TripChange>();
/** Bumped whenever the effective timetable is rebuilt (readers can cache until it changes). */
export const effective = { generation: 0 };
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
  source?: "staff" | "auto" | "control"; // "auto": the twin's own detection (src/auto.ts); "control": a scenario disruption's public face
  trainIds?: string[]; // automatic incidents: the trains concerned
  createdAt: number;
  updatedAt: number;
  // scenario disruptions (source "control"): the latest bulletin's facts
  cause?: { code: string; label: string };
  effect?: EffectState | "resumed";
  lines?: string[];
  durationType?: DurationType;
  until?: number | null;
  lifecycle?: "INFO" | "ENDED";
  bulletinVersion?: number;
  messages?: BulletinMessage[];
  replacementBus?: boolean;
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

/** A disruption created by sbb-twin itself (rear-end collisions), not from the API. */
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
  const type = TYPES.find((t) => t.id === (ALIASES[input.type] ?? input.type));
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
