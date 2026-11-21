// What sbb-twin publishes on MQTT: payload builders and the per-tick publication.
import { randomUUID } from "node:crypto";
import { clear, publish, brokerStats } from "./mqtt.ts";
import * as channel from "./channel.ts";
import { alertsState } from "./alerts.ts";
import { config } from "./config.ts";
import { byTrainId, collisions, delayOf, edgeName, expectedArrival, expectedDeparture, nextCall, settings, timetableDate, trains, tripMeta, type Train } from "./engine.ts";
import { stops } from "./timetable.ts";
import { disruptions, incidents, type Disruption, type Incident } from "./disruptions.ts";
import { live } from "./realtime.ts";
import { overridePayload, weather } from "./weather.ts";

export const VERSION = "1.0.0";
export const startedAt = Date.now();
export const streamId = randomUUID().replaceAll("-", "").slice(0, 16); // changes on every restart of sbb-twin
let tickNo = 0;
/** Observable movement only: whether a train is moving and where it stands (no intent such as "held"). */
const motionOf = (tr: Train) => (tr.speed >= 0.3 && tr.leg >= 0 ? "moving" : "stopped");
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r1 = (x: number) => Math.round(x * 10) / 10;
const num = (x: number) => (Number.isNaN(x) ? null : Math.round(x));

export function positionPayload(tr: Train, t: number) {
  const k = nextCall(tr);
  const here = tr.leg >= 0 ? tr.leg : tr.call;
  const prev = stops[tr.trip.stops[here]];
  const next = stops[tr.trip.stops[k]];
  return {
    v: 1,
    streamId,
    tick: tickNo,
    ts: t,
    trainId: tr.trip.trainId,
    lat: r6(tr.lat),
    lon: r6(tr.lon),
    bearing: r1(tr.bearing),
    speedKmh: r1(tr.speed * 3.6),
    motion: tr.cancelled ? "stopped" : motionOf(tr),
    delaySec: delayOf(tr, t),
    line: tr.trip.line,
    category: tr.trip.cat,
    headsign: tr.trip.head,
    atStop: tr.leg < 0 ? { id: prev.id, name: prev.name } : null,
    prevStop: { id: prev.id, name: prev.name },
    nextStop: k !== here ? { id: next.id, name: next.name, plannedArr: tr.trip.arr[k], expectedArr: Math.round(expectedArrival(tr, k, t)) } : null,
    edgeId: edgeName(tr) ?? null,
    track: tr.bav ? "bav" : "approx",
    continuity: tr.continuity,
  };
}

export function infoPayload(tr: Train, t: number) {
  const m = tripMeta(tr.trip.tripId);
  const n = tr.trip.arr.length;
  const passed = tr.leg >= 0 ? tr.leg : tr.call;
  const stop = (i: number) => stops[tr.trip.stops[i]];
  return {
    v: 1,
    trainId: tr.trip.trainId,
    tripId: tr.trip.tripId,
    serviceDate: tr.trip.serviceDate,
    line: tr.trip.line,
    category: tr.trip.cat,
    number: m?.[0] || null,
    operator: m?.[1] || null,
    headsign: tr.trip.head,
    status: tr.cancelled ? "cancelled" : "active",
    origin: { id: stop(0).id, name: stop(0).name },
    destination: { id: stop(n - 1).id, name: stop(n - 1).name },
    calls: Array.from({ length: n }, (_, i) => ({
      stopId: stop(i).id,
      name: stop(i).name,
      lat: r6(stop(i).lat),
      lon: r6(stop(i).lon),
      plannedArr: i > 0 ? tr.trip.arr[i] : null,
      plannedDep: i < n - 1 ? tr.trip.dep[i] : null,
      expectedArr: i > 0 && i > passed ? Math.round(expectedArrival(tr, i, t)) : null,
      expectedDep: i < n - 1 && i >= passed && !(i === passed && tr.leg >= 0) ? Math.round(expectedDeparture(tr, i, t)) : null,
      actualArr: i > 0 ? num(tr.actArr[i]) : null,
      actualDep: i < n - 1 ? num(tr.actDep[i]) : null,
      skipped: Boolean(tr.skipped[i]),
    })),
    updatedAt: t,
  };
}

function infoSignature(tr: Train, t: number) {
  const k = nextCall(tr);
  return `${tr.cancelled}|${Math.round(delayOf(tr, t) / 30)}|${k}|${Array.from(tr.skipped).join("")}`;
}

/** Ground truth for a train a provoked disruption took over (never in the public payloads). */
const truthTrain = (tr: Train) => ({ v: 1, trainId: tr.trip.trainId, mode: "simulated", state: tr.motion, causes: [...tr.causes], ts: Date.now() });

export function disruptionPayload(d: Disruption) {
  return {
    v: 1,
    id: d.id,
    type: d.type,
    label: d.label,
    reasonCode: d.reasonCode,
    effect: d.effect,
    scope: d.scope,
    where: d.where,
    params: d.params,
    note: d.note ?? null,
    status: d.endedAt ? "ended" : "active",
    startedAt: d.startedAt,
    endsAt: d.endsAt,
    endedAt: d.endedAt ?? null,
    geometry: d.geometry,
    affectedTrains: [...d.affected],
  };
}
export const incidentPayload = (i: Incident) => ({ v: 1, ...i, status: "active" });

/** Public events (observable facts) go to events/{kind}; what we provoked goes to truth/events. */
export function event(kind: "disruption" | "incident" | "train" | "sync" | "system", data: Record<string, unknown>) {
  const body = { v: 1, ts: Date.now(), kind, ...data };
  // events are fire-and-forget: QoS 0, not retained
  if (kind === "disruption" || kind === "sync") publish("truth/events", body, { qos: 0 });
  else publish(`events/${kind}`, body, { qos: 0 });
  channel.sendEvent(body);
}

/** Everything the control page shows besides trains and weather: what was provoked, marked or switched. */
export function controlState() {
  return {
    disruptions: [...disruptions.values()].map(disruptionPayload),
    incidents: [...incidents.values()].map(incidentPayload),
    overrides: [...weather.overrides.values()].map(overridePayload),
    protection: settings.protection,
    simulated: [...trains.values()].filter((tr) => tr.mode === "sim").map((tr) => ({ trainId: tr.trip.trainId, causes: [...tr.causes] })),
  };
}
let stateCore = "";
let stateFull = "";
let stateAt = 0;
/** Send the control state to the pages when it changed: at once for changes, every 5 s at most for affected-train lists. */
export function pushState(t = Date.now()) {
  const s = controlState();
  const full = JSON.stringify(s);
  if (full === stateFull) return;
  const core = JSON.stringify({ ...s, disruptions: s.disruptions.map((d) => ({ ...d, affectedTrains: d.affectedTrains.length })) });
  if (core === stateCore && t - stateAt < 5000) return;
  stateCore = core;
  stateFull = full;
  stateAt = t;
  channel.send("state", { type: "state", ts: t, ...s });
}

// ---------------------------------------------------------------- per tick
export const FLEET_FIELDS = ["trainId", "lat", "lon", "bearing", "speedKmh", "motion", "delaySec", "line", "category", "atStopId", "continuity"];
const truthPublished = new Map<string, string>(); // trainId -> causes signature
const disruptionSig = new Map<string, string>();
const disruptionAt = new Map<string, number>();
let lastStatus = 0;

export function publishTick(t: number, removed: Train[]) {
  tickNo++;
  for (const c of collisions.splice(0)) event("disruption", { type: "train.collision", trainId: c.trainId, id: c.disruptionId, impactKmh: c.impactKmh, withTrain: c.withTrain ?? null });
  const fleet: unknown[] = [];
  for (const tr of trains.values()) {
    const id = tr.trip.trainId;
    publish(`trains/${id}/position`, positionPayload(tr, t));
    const sig = infoSignature(tr, t);
    if (sig !== tr.infoSig && (t - tr.infoAt >= 10_000 || !tr.infoSig || sig.split("|")[0] !== tr.infoSig.split("|")[0])) {
      if (tr.cancelled && !tr.infoSig.startsWith("true")) event("train", { type: "train.cancelled", trainId: id, line: tr.trip.line });
      tr.infoSig = sig;
      tr.infoAt = t;
      publish(`trains/${id}/info`, infoPayload(tr, t), { retain: true, qos: 1 });
    }
    const causesSig = [...tr.causes].join(",");
    if (tr.mode === "sim" && truthPublished.get(id) !== causesSig) {
      truthPublished.set(id, causesSig);
      publish(`truth/trains/${id}`, truthTrain(tr), { retain: true, qos: 1 });
    } else if (tr.mode === "real" && truthPublished.has(id)) {
      truthPublished.delete(id);
      clear(`truth/trains/${id}`);
    }
    fleet.push([id, r6(tr.lat), r6(tr.lon), r1(tr.bearing), r1(tr.speed * 3.6), tr.cancelled ? "cancelled" : motionOf(tr), delayOf(tr, t), tr.trip.line, tr.trip.cat, tr.leg < 0 ? stops[tr.trip.stops[tr.call]].id : null, tr.continuity]);
  }
  for (const tr of removed) {
    const id = tr.trip.trainId;
    clear(`trains/${id}/info`);
    if (truthPublished.delete(id)) clear(`truth/trains/${id}`);
  }
  publish("fleet", { v: 1, streamId, tick: tickNo, ts: t, fields: FLEET_FIELDS, trains: fleet });
  channel.send("tick", { type: "tick", ts: t, trains: fleet, status: statusPayload(t) }, { droppable: true });
  for (const id of channel.watched()) {
    const tr = byTrainId.get(id);
    channel.sendToWatchers(id, { type: "train", trainId: id, position: tr ? positionPayload(tr, t) : null, info: tr ? infoPayload(tr, t) : null });
  }
  for (const d of disruptions.values()) {
    // state changes go out at once; a growing list of affected trains at most every 15 s
    const state = `${d.endedAt ?? ""}|${d.params.collidedAt ?? ""}`;
    const prev = disruptionSig.get(d.id);
    const sig = `${state}|${d.affected.size}`;
    if (prev === sig) continue;
    if (prev && prev.startsWith(`${state}|`) && t - (disruptionAt.get(d.id) ?? 0) < 15_000) continue;
    disruptionAt.set(d.id, t);
    if (d.endedAt && prev && !prev.startsWith(String(d.endedAt))) event("disruption", { type: "disruption.ended", id: d.id, label: d.label, where: d.where });
    disruptionSig.set(d.id, sig);
    publish(`truth/disruptions/${d.id}`, disruptionPayload(d), { retain: true, qos: 1 });
  }
  // ended disruptions stay visible for 30 minutes
  for (const d of [...disruptions.values()]) if (d.endedAt && t - d.endedAt > 30 * 60_000) removeDisruption(d.id);
  pushState(t);
  if (t - lastStatus >= 10_000) {
    lastStatus = t;
    publish("status", statusPayload(t), { retain: true, qos: 1 });
  }
}

export function removeDisruption(id: string) {
  disruptions.delete(id);
  disruptionSig.delete(id);
  clear(`truth/disruptions/${id}`);
}

export function statusPayload(t = Date.now()) {
  let simulated = 0;
  for (const tr of trains.values()) if (tr.mode === "sim") simulated++;
  return {
    v: 1,
    ts: t,
    service: "sbb-twin",
    version: VERSION,
    streamId,
    tick: tickNo,
    startedAt,
    timetableDate: timetableDate(),
    trainsActive: trains.size,
    trainsSimulated: simulated,
    realtime: { enabled: live.enabled(), feedAgeSec: live.fetchedAt ? Math.round((t - live.fetchedAt) / 1000) : null, trips: live.trips.size, error: live.error ?? null },
    disruptionsActive: [...disruptions.values()].filter((d) => !d.endedAt).length,
    incidentsMarked: incidents.size,
    weather: { stations: weather.stations.size, feedAgeSec: weather.fetchedAt ? Math.round((t - weather.fetchedAt) / 1000) : null, measuredAt: weather.grid?.measuredAt ?? null, error: weather.error ?? null },
    broker: { mode: brokerStats.mode, connected: brokerStats.connected, webSocketClients: brokerStats.clients },
    alerts: { enabled: Boolean(config.gtfsSaKey), active: alertsState.alerts.size, feedAgeSec: alertsState.fetchedAt ? Math.round((t - alertsState.fetchedAt) / 1000) : null, error: alertsState.error ?? null },
    controlPages: channel.pageCount(),
  };
}
export const trainById = (id: string) => byTrainId.get(id);
