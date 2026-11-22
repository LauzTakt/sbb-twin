// Automatic incident detection: an independent rule set that only watches what the trains do (positions, speeds,
// times; never what was provoked) and opens public incidents (incidents/{id}, source "auto") on the track section,
// station or train concerned. Each closes by itself once the situation is over (after a short grace period).
//
//   section  trains stopped on the open line for 30 s                     major (critical after a collision)
//   section  slow running: steadily under 40 % of the timetable pace, 60 s minor
//   station  trains held: still there 3 min after they should have left   minor (major from 2 trains)
//   train    10 min late, or 4 min late and losing time (2 min in 3 min)  minor, until under 4 min late
//   train    cancelled                                                    minor
import { createHash } from "node:crypto";
import { byTrainId, delayOf, trains, type Train } from "./engine.ts";
import { stops } from "./timetable.ts";
import { edgesGeometry, pathBetween, sectionEdges } from "./geometry.ts";
import { incidents, tripChanges, type Incident } from "./disruptions.ts";

const STOPPED_S = 30;
const SLOW_S = 60;
const SLOW_RATIO = 0.4;
const HELD_S = 180;
const LATE_ON_S = 600;
const LATE_OFF_S = 240;
const LOSING_S = 120;
const GRACE_MS = 20_000;

const open = new Map<string, number>(); // incident id -> last time its condition held
const since = new Map<string, number>(); // condition key -> when it started
const delayLog = new Map<string, { t: number; d: number }[]>(); // a delay sample every 30 s, ~3 minutes
const collided = new Map<string, number>(); // trainId -> impact speed (km/h)
const sectionCache = new Map<string, { name: string; geometry: Incident["geometry"]; scope: Incident["scope"] }>();

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const label = (tr: Train) => `${tr.trip.line} to ${tr.trip.head}`;
const nameOf = (k: number) => stops[k]?.name ?? "";
const onMap = (tr: Train) => tr.lon >= 5.4 && tr.lon <= 11.0 && tr.lat >= 45.55 && tr.lat <= 48.05;
const where = (tr: Train) => (tr.leg >= 0 ? `between ${nameOf(tr.trip.stops[tr.leg])} and ${nameOf(tr.trip.stops[tr.leg + 1])}` : `at ${nameOf(tr.trip.stops[tr.call])}`);
/** True once `cond` has held for `seconds` without interruption. */
function lasting(key: string, cond: boolean, t: number, seconds: number) {
  if (!cond) {
    since.delete(key);
    return false;
  }
  if (!since.has(key)) since.set(key, t);
  return t - since.get(key)! >= seconds * 1000;
}
/** The track section a train is on (stations ordered, so both directions share it). */
function sectionOf(tr: Train) {
  const a = tr.trip.stops[tr.leg];
  const b = tr.trip.stops[tr.leg + 1];
  const [x, y] = a < b ? [a, b] : [b, a];
  const key = `${x}-${y}`;
  let s = sectionCache.get(key);
  if (!s) {
    let geometry: Incident["geometry"] = null;
    try {
      const edges = sectionEdges(stops[x], stops[y]);
      if (edges.size) geometry = edgesGeometry(edges) as Incident["geometry"];
    } catch {
      // no track between them: the incident has no line
    }
    s = { name: `${nameOf(x)} – ${nameOf(y)}`, geometry, scope: { kind: "section", from: stops[x].id, to: stops[y].id } };
    sectionCache.set(key, s);
  }
  return { key, ...s };
}
const push = <K>(m: Map<K, Train[]>, k: K, tr: Train) => (m.get(k) ?? m.set(k, []).get(k)!).push(tr);

type Change = { kind: "opened" | "updated" | "closed"; incident: Incident };
type Wanted = Omit<Incident, "createdAt" | "updatedAt">;

/** Called once per tick with that tick's collisions; returns the incidents to publish. */
export function autoIncidents(t: number, crashes: { trainId: string; impactKmh: number }[]): Change[] {
  for (const c of crashes) collided.set(c.trainId, c.impactKmh);
  const want = new Map<string, Wanted>();
  const stoppedOn = new Map<string, Train[]>(); // section key -> trains stopped there
  const slowOn = new Map<string, Train[]>();
  const heldAt = new Map<number, Train[]>(); // station index -> trains held there
  const section = new Map<string, ReturnType<typeof sectionOf>>();

  for (const tr of trains.values()) {
    const id = tr.trip.trainId;
    if (collided.has(id) && (tr.mode !== "sim" || tr.speed >= 0.5)) collided.delete(id); // released or synced
    if (!onMap(tr)) continue;
    // already explained in public: a control-centre disruption cut, cancelled or holds this trip (its bulletin says so)
    const explained = tripChanges.has(tr.trip.key);
    if (tr.cancelled && explained) continue;
    if (tr.cancelled) {
      want.set(`auto-cancelled-${hash(id)}`, train("cancelled", tr, "minor", `Cancelled: ${label(tr)}`));
      continue;
    }
    if (tr.leg >= 0) {
      const sec = sectionOf(tr);
      section.set(sec.key, sec);
      // stopped on the open line
      if (lasting(`stop:${id}`, tr.speed < 0.5, t, STOPPED_S) || collided.has(id)) push(stoppedOn, sec.key, tr);
      // slow running in the middle of the section, compared with the pace the timetable needs
      const path = pathBetween(stops[tr.trip.stops[tr.leg]], stops[tr.trip.stops[tr.leg + 1]]);
      const planned = (tr.trip.arr[tr.leg + 1] - tr.trip.dep[tr.leg]) / 1000;
      const pace = planned > 30 ? path.len / planned : 0;
      // running steadily (not accelerating away from a stop or braking for one), away from both ends
      const steady = Math.abs(tr.accel) < 0.05 && tr.s > 800 && tr.s < path.len - 800;
      if (lasting(`slow:${id}`, pace > 0 && steady && tr.speed >= 0.5 && tr.speed < pace * SLOW_RATIO, t, SLOW_S)) push(slowOn, sec.key, tr);
    } else {
      since.delete(`stop:${id}`);
      since.delete(`slow:${id}`);
      // held at a station: it should have left (planned departure and planned dwell both passed) 3 min ago
      const k = tr.call;
      const arrived = tr.actArr[k];
      if (k < tr.trip.stops.length - 1 && Number.isFinite(arrived)) {
        const due = Math.max(tr.trip.dep[k], arrived + (tr.trip.dep[k] - tr.trip.arr[k]));
        if (t - due >= HELD_S * 1000 && !explained) push(heldAt, tr.trip.stops[k], tr);
      }
    }
    // late, or losing time fast
    const delay = delayOf(tr, t);
    const log = delayLog.get(id) ?? [];
    if (!log.length || t - log[log.length - 1].t >= 30_000) {
      log.push({ t, d: delay });
      while (t - log[0].t > 200_000) log.shift();
      delayLog.set(id, log);
    }
    const before = log.find((x) => t - x.t >= 170_000);
    const losing = before !== undefined && delay - before.d >= LOSING_S;
    const lateId = `auto-late-${hash(id)}`;
    if (delay >= LATE_ON_S || (delay >= LATE_OFF_S && (losing || open.has(lateId)))) want.set(lateId, train("late", tr, "minor", `${label(tr)}: ${Math.round(delay / 60)} min late${losing ? ", losing time" : ""}`));
  }
  for (const [key, list] of stoppedOn) {
    const sec = section.get(key)!;
    const crash = list.find((tr) => collided.has(tr.trip.trainId));
    const title = crash ? `Collision: ${label(crash)} (${Math.round(collided.get(crash.trip.trainId)!)} km/h)` : list.length === 1 ? `Train stopped: ${label(list[0])}` : `${list.length} trains stopped on the line`;
    want.set(`auto-stopped-${hash(key)}`, { ...base("stopped", crash ? "critical" : "major", title, list), scope: sec.scope, where: sec.name, geometry: sec.geometry });
  }
  for (const [key, list] of slowOn) {
    const sec = section.get(key)!;
    want.set(`auto-slow-${hash(key)}`, { ...base("slow", "minor", list.length === 1 ? `Slow running: ${label(list[0])}` : `Slow running: ${list.length} trains`, list), scope: sec.scope, where: sec.name, geometry: sec.geometry });
  }
  for (const [k, list] of heldAt) {
    const st = stops[k];
    want.set(`auto-held-${hash(String(st.id))}`, { ...base("held", list.length > 1 ? "major" : "minor", list.length === 1 ? `Train held: ${label(list[0])}` : `${list.length} trains held`, list), scope: { kind: "station", station: st.id }, where: `at ${st.name}`, geometry: { type: "Point", coordinates: [st.lon, st.lat] } });
  }
  for (const key of [...since.keys()]) if (!byTrainId.has(key.slice(key.indexOf(":") + 1))) since.delete(key);
  for (const id of [...delayLog.keys()]) if (!byTrainId.has(id)) delayLog.delete(id);
  for (const id of [...collided.keys()]) if (!byTrainId.has(id)) collided.delete(id);

  // open, update and (after a grace period) close
  const changes: Change[] = [];
  for (const [id, w] of want) {
    open.set(id, t);
    const cur = incidents.get(id);
    if (!cur) {
      const inc: Incident = { ...w, id, createdAt: t, updatedAt: t };
      incidents.set(id, inc);
      changes.push({ kind: "opened", incident: inc });
    } else if (cur.title !== w.title || cur.severity !== w.severity || cur.description !== w.description || cur.where !== w.where) {
      Object.assign(cur, { title: w.title, severity: w.severity, description: w.description, where: w.where, trainIds: w.trainIds, updatedAt: t });
      changes.push({ kind: "updated", incident: cur });
    }
  }
  for (const [id, last] of [...open]) {
    if (want.has(id) || (incidents.has(id) && t - last < GRACE_MS)) continue;
    open.delete(id);
    const cur = incidents.get(id);
    incidents.delete(id);
    if (cur) changes.push({ kind: "closed", incident: cur });
  }
  return changes;
}

function base(rule: string, severity: Incident["severity"], title: string, list: Train[]) {
  return { id: "", title, description: list.map(label).join(", "), severity, type: `auto.${rule}`, source: "auto" as const, trainIds: list.map((tr) => tr.trip.trainId) };
}
function train(rule: string, tr: Train, severity: Incident["severity"], title: string): Wanted {
  return { ...base(rule, severity, title, [tr]), description: "", scope: { kind: "train", trainId: tr.trip.trainId }, where: where(tr), geometry: null };
}
