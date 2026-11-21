// Automatic incidents: what an operations centre flags on its own from what the trains do. Each rule opens a public
// incident (incidents/{id}, source "auto") when its condition starts and removes it when it is over:
//   collision                                   critical   until the train is released or synced
//   stopped on the open line for 2 min or more  major      until it moves again
//   10 min late or more                         minor      until it is under 5 min late or out of service
//   cancelled                                   minor      until it leaves service
import { createHash } from "node:crypto";
import { byTrainId, delayOf, trains, type Train } from "./engine.ts";
import { stops } from "./timetable.ts";
import { incidents, type Incident } from "./disruptions.ts";

type Rule = "collision" | "stopped" | "late" | "cancelled";
const STOPPED_S = 120;
const LATE_ON_S = 600;
const LATE_OFF_S = 300;
const open = new Set<string>(); // ids of the automatic incidents currently open
const stoppedSince = new Map<string, number>();
const collided = new Map<string, { impactKmh: number; withTrain?: string }>();

const idOf = (rule: Rule, trainId: string) => `auto-${rule}-${createHash("sha1").update(trainId).digest("hex").slice(0, 10)}`;
const label = (tr: Train) => `${tr.trip.line} to ${tr.trip.head}`;
const name = (k: number) => stops[k]?.name ?? "";
function where(tr: Train) {
  if (tr.leg >= 0) return `between ${name(tr.trip.stops[tr.leg])} and ${name(tr.trip.stops[tr.leg + 1])}`;
  return `at ${name(tr.trip.stops[tr.call])}`;
}

type Change = { kind: "opened" | "updated" | "closed"; incident: Incident };
/** Called once per tick with the collisions of that tick; returns what changed (to publish). */
export function autoIncidents(t: number, crashes: { trainId: string; impactKmh: number; withTrain?: string }[]): Change[] {
  for (const c of crashes) collided.set(c.trainId, { impactKmh: c.impactKmh, withTrain: c.withTrain });
  const want = new Map<string, Omit<Incident, "createdAt" | "updatedAt">>();
  const add = (rule: Rule, tr: Train, severity: Incident["severity"], title: string, point: boolean) => {
    const id = idOf(rule, tr.trip.trainId);
    want.set(id, {
      id,
      title,
      description: "",
      severity,
      type: `auto.${rule}`,
      scope: { kind: "train", trainId: tr.trip.trainId },
      where: where(tr),
      geometry: point ? { type: "Point", coordinates: [Math.round(tr.lon * 1e6) / 1e6, Math.round(tr.lat * 1e6) / 1e6] } : null,
      source: "auto",
    });
  };
  for (const [trainId, c] of collided) {
    const tr = byTrainId.get(trainId);
    if (!tr || tr.mode !== "sim" || tr.speed >= 0.5) {
      collided.delete(trainId);
      continue;
    }
    add("collision", tr, "critical", `Collision: ${label(tr)} (${Math.round(c.impactKmh)} km/h)`, true);
  }
  for (const tr of trains.values()) {
    const id = tr.trip.trainId;
    // only where the twin's map is (cross-border trains far into France, Germany or Italy are not flagged)
    if (tr.lon < 5.4 || tr.lon > 11.0 || tr.lat < 45.55 || tr.lat > 48.05) continue;
    if (tr.cancelled) {
      add("cancelled", tr, "minor", `Cancelled: ${label(tr)}`, false);
      continue;
    }
    // stopped on the open line (a collided train already has its incident)
    if (tr.leg >= 0 && tr.speed < 0.5) {
      if (!stoppedSince.has(id)) stoppedSince.set(id, t);
      if (t - stoppedSince.get(id)! >= STOPPED_S * 1000 && !collided.has(id)) add("stopped", tr, "major", `Train stopped on the line: ${label(tr)}`, true);
    } else stoppedSince.delete(id);
    const delay = delayOf(tr, t);
    const lateId = idOf("late", id);
    if (delay >= LATE_ON_S || (open.has(lateId) && delay >= LATE_OFF_S)) add("late", tr, "minor", `${label(tr)}: ${Math.round(delay / 60)} min late`, false);
  }
  for (const id of stoppedSince.keys()) if (!byTrainId.has(id)) stoppedSince.delete(id);
  // reconcile with what is open
  const changes: Change[] = [];
  for (const [id, w] of want) {
    const cur = incidents.get(id);
    if (!cur) {
      const inc: Incident = { ...w, createdAt: t, updatedAt: t };
      incidents.set(id, inc);
      open.add(id);
      changes.push({ kind: "opened", incident: inc });
    } else if (cur.title !== w.title || cur.where !== w.where) {
      // a stopped or collided train does not move: keep where it was flagged
      Object.assign(cur, { title: w.title, where: w.geometry ? cur.where : w.where, updatedAt: t });
      changes.push({ kind: "updated", incident: cur });
    }
  }
  for (const id of [...open]) {
    if (want.has(id)) continue;
    open.delete(id);
    const cur = incidents.get(id);
    incidents.delete(id);
    if (cur) changes.push({ kind: "closed", incident: cur });
  }
  return changes;
}
