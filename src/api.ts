// HTTP control API for staff (provoke/end disruptions, mark/unmark incidents, sync) and read helpers.
import { Hono } from "hono";
import { InputError, TYPES, createDisruption, createIncident, disruptions, incidents } from "./disruptions.ts";
import { byTrainId, neighbours, obstacleAhead, servedStations, stationBoard, sync, trains } from "./engine.ts";
import { searchStations, stationIndex } from "./timetable.ts";
import { abroadGeoJson, networkGeoJson } from "./geometry.ts";
import { bulletins, controlState, disruptionPayload, event, incidentPayload, infoPayload, positionPayload, pushState, removeDisruption, statusPayload } from "./feed.ts";
import { CAUSES, MEASURES } from "./catalogue.ts";
import { acceptProposal, addMeasure, createScenario, forgetAll, isScenario, latestBulletin, resume, scenarioTick, setState, withdrawMeasure, type ScenarioInput } from "./scenario.ts";
import { stops } from "./timetable.ts";
import { replayOutcome, replayStatus, startReplay } from "./replay.ts";
import { clear, publish } from "./mqtt.ts";
import { releaseAll, releaseTrain } from "./god.ts";
import { alertsState } from "./alerts.ts";
import { journeyGeometry, plan, sectionGeometry, situation, trainGeometry } from "./planner.ts";

const trainLookup = (id: string) => {
  const tr = byTrainId.get(id);
  if (!tr) return undefined;
  const next = tr.leg >= 0 ? tr.leg + 1 : tr.call + 1;
  return { label: `${tr.trip.line} → ${tr.trip.head}`, nextStation: next < tr.trip.stops.length - 1 ? tr.trip.stops[next] : undefined, obstacleAt: (m: number) => obstacleAhead(tr, m) };
};
const severityFor: Record<string, "minor" | "major" | "critical"> = {
  section_closure: "critical",
  train_breakdown: "major",
  signal_failure: "major",
  station_closure: "major",
  speed_restriction: "minor",
  train_delay: "minor",
  cancellation: "minor",
  train_speed: "minor",
  skip_stop: "minor",
  target_speed: "minor",
  obstacle: "critical",
};

function markIncident(input: Parameters<typeof createIncident>[0]) {
  const i = createIncident(input);
  publish(`incidents/${i.id}`, incidentPayload(i), { retain: true, qos: 1 });
  event("incident", { type: "incident.marked", id: i.id, title: i.title, severity: i.severity, where: i.where });
  return i;
}
function endDisruption(id: string) {
  const d = disruptions.get(id);
  if (!d) return undefined;
  if (!d.endedAt) d.endedAt = Date.now();
  return d;
}
const scenarioOf = (id: string) => {
  const d = disruptions.get(id);
  if (!d) return undefined;
  if (!isScenario(d)) throw new InputError("This is a train-level disruption: only scenario disruptions take measures");
  return d;
};
/** A train breakdown blocks its section: an interrupted disruption (train blocking the line) with a bulletin. */
function breakdownSection(trainId: string) {
  const tr = byTrainId.get(trainId);
  if (!tr) return undefined;
  const n = tr.trip.stops.length;
  const i = tr.leg >= 0 ? tr.leg : Math.min(tr.call, n - 2);
  if (i < 0) return undefined;
  try {
    return createScenario({ cause: "EG_014", scope: { kind: "section", from: stops[tr.trip.stops[i]].id, to: stops[tr.trip.stops[i + 1]].id }, effect: "interrupted", durationType: "UNKNOWN", linkedTrain: trainId });
  } catch {
    return undefined; // no section to close (e.g. a train abroad): the breakdown still stops the train
  }
}

export function api() {
  const app = new Hono().basePath("/api");
  // every change reaches the control pages at once (the engine also checks every tick)
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET") {
      scenarioTick(Date.now(), true); // bulletins and the effective timetable follow at once
      pushState();
    }
  });
  app.onError((err, c) => {
    if (err instanceof InputError) return c.json({ error: err.message }, 422);
    console.error("[api]", err);
    return c.json({ error: "Internal error" }, 500);
  });
  const body = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  app.get("/status", (c) => c.json(statusPayload()));
  app.get("/trains", (c) => {
    const t = Date.now();
    return c.json([...trains.values()].map((tr) => positionPayload(tr, t)));
  });
  app.get("/trains/:id", (c) => {
    const tr = byTrainId.get(c.req.param("id"));
    if (!tr) return c.json({ error: "Train not in service" }, 404);
    const t = Date.now();
    return c.json({ position: positionPayload(tr, t), info: infoPayload(tr, t), truth: { mode: tr.mode === "sim" ? "simulated" : "real", causes: [...tr.causes] } });
  });
  app.get("/stations", (c) => c.json(searchStations(c.req.query("q") ?? "", 10)));
  app.get("/stations.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=600");
    return c.json({ type: "FeatureCollection", features: servedStations().map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name, trains: s.trains }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) });
  });
  app.get("/stations/:id/board", (c) => {
    const i = stationIndex(c.req.param("id"));
    if (i === undefined) return c.json({ error: "Unknown station" }, 404);
    return c.json(stationBoard(i, Date.now()));
  });
  app.get("/stations/:id/neighbours", (c) => {
    const i = stationIndex(c.req.param("id"));
    if (i === undefined) return c.json({ error: "Unknown station" }, 404);
    return c.json(neighbours(i, Math.min(80, Number(c.req.query("km") ?? 40))));
  });
  app.get("/abroad.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=3600");
    return c.body(abroadGeoJson());
  });
  app.get("/network.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=3600");
    return c.body(networkGeoJson());
  });


  // Scenario disruptions (a cause, an effect state, the control centre's measures) and train-level actions
  app.get("/disruption-types", (c) => c.json(CAUSES.map((x) => ({ ...x, defaultMinutes: x.minutes }))));
  app.get("/measure-types", (c) => c.json(MEASURES));
  app.get("/train-actions", (c) => c.json(TYPES));
  app.get("/disruptions", (c) => c.json([...disruptions.values()].map(disruptionPayload)));
  app.get("/disruptions/:id", (c) => {
    const d = disruptions.get(c.req.param("id"));
    return d ? c.json(disruptionPayload(d)) : c.json({ error: "Unknown disruption" }, 404);
  });
  app.post("/disruptions", async (c) => {
    const b = await body(c);
    if (b.cause !== undefined) {
      const d = createScenario(b as ScenarioInput);
      publish(`truth/disruptions/${d.id}`, disruptionPayload(d), { retain: true, qos: 1 });
      event("disruption", { type: "disruption.started", id: d.id, label: d.label, where: d.where });
      return c.json({ disruption: disruptionPayload(d), bulletin: latestBulletin(d), proposal: d.scenario.proposal }, 201);
    }
    const d = createDisruption(b as Parameters<typeof createDisruption>[0], trainLookup);
    publish(`truth/disruptions/${d.id}`, disruptionPayload(d), { retain: true, qos: 1 });
    event("disruption", { type: "disruption.started", id: d.id, label: d.label, where: d.where });
    const linked = d.effect === "train_breakdown" && d.scope.kind === "train" ? breakdownSection(d.scope.trainId) : undefined;
    const incident = b.mark
      ? markIncident({ title: `${d.label}: ${d.where}`, description: String(b.note ?? ""), severity: severityFor[d.effect], type: d.type, reasonCode: d.reasonCode, scope: d.scope, where: d.where, disruptionId: d.id })
      : undefined;
    return c.json({ disruption: disruptionPayload(d), incident: incident ? incidentPayload(incident) : null, linked: linked ? disruptionPayload(linked) : null, bulletin: linked ? latestBulletin(linked) : null }, 201);
  });
  const answer = (d: Parameters<typeof disruptionPayload>[0] & { scenario?: unknown }) => ({ disruption: disruptionPayload(d), bulletin: isScenario(d) ? latestBulletin(d) : null });
  app.post("/disruptions/:id/measures", async (c) => {
    const d = scenarioOf(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    const b = await body(c);
    const list = Array.isArray(b.measures) ? (b.measures as Record<string, unknown>[]) : [b];
    const added = list.map((m) => addMeasure(d, m));
    event("disruption", { type: "disruption.measure", id: d.id, measures: added.map((m) => m.type) });
    return c.json({ ...answer(d), added }, 201);
  });
  app.post("/disruptions/:id/measures/:mid/withdraw", async (c) => {
    const d = scenarioOf(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    const b = await body(c);
    withdrawMeasure(d, c.req.param("mid"), b.at, Date.now(), b.replaced === true);
    return c.json(answer(d));
  });
  app.post("/disruptions/:id/proposal/accept", (c) => {
    const d = scenarioOf(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    const added = acceptProposal(d);
    return c.json({ ...answer(d), added }, 201);
  });
  app.post("/disruptions/:id/state", async (c) => {
    const d = scenarioOf(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    const b = await body(c);
    setState(d, b.effect, b.at);
    event("disruption", { type: "disruption.state", id: d.id, effect: b.effect });
    return c.json(answer(d));
  });
  app.post("/disruptions/:id/end", async (c) => {
    const id = c.req.param("id");
    const s = disruptions.get(id);
    if (s && isScenario(s)) {
      const b = await body(c);
      if (!s.endedAt) resume(s, b.at);
      return c.json(answer(s));
    }
    const d = endDisruption(id);
    return d ? c.json(disruptionPayload(d)) : c.json({ error: "Unknown disruption" }, 404);
  });
  app.delete("/disruptions/:id", (c) => {
    const d = endDisruption(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    removeDisruption(d.id);
    return c.json({ removed: d.id });
  });
  app.get("/bulletins", (c) => c.json(bulletins()));
  app.get("/replays", (c) => c.json(replayStatus()));
  app.get("/replays/outcome", (c) => c.json(replayOutcome()));
  app.post("/replays/:name/start", (c) => c.json(startReplay(c.req.param("name")), 201));
  app.get("/bulletins/:id", (c) => {
    const d = disruptions.get(c.req.param("id"));
    if (!d || !isScenario(d)) return c.json({ error: "Unknown disruption" }, 404);
    return c.json({ latest: latestBulletin(d), versions: d.scenario.bulletins });
  });

  // Mark / unmark incidents (public flags)
  app.get("/incidents", (c) => c.json([...incidents.values()].map(incidentPayload)));
  app.post("/incidents", async (c) => {
    const b = await body(c);
    if (!b.title || typeof b.title !== "string") throw new InputError("An incident needs a title");
    return c.json(incidentPayload(markIncident(b as Parameters<typeof createIncident>[0])), 201);
  });
  app.delete("/incidents/:id", (c) => {
    const i = incidents.get(c.req.param("id"));
    if (!i) return c.json({ error: "Unknown incident" }, 404);
    incidents.delete(i.id);
    clear(`incidents/${i.id}`);
    event("incident", { type: "incident.unmarked", id: i.id, title: i.title });
    return c.json({ removed: i.id });
  });

  app.get("/control/state", (c) => c.json({ ...controlState(), status: statusPayload() }));
  app.get("/alerts", (c) => c.json([...alertsState.alerts.values()]));
  // passenger assistant: journeys on the live twin, what a passenger should know, and the track to draw
  app.get("/plan", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new InputError("from and to are required (station id or name)");
    const after = Number(c.req.query("after") ?? Date.now()) || Date.now();
    const limit = Math.max(1, Math.min(6, Number(c.req.query("limit") ?? 4) || 4));
    const r = plan(from, to, after, limit);
    return "error" in r ? c.json({ error: r.error }, 404) : c.json(r);
  });
  app.get("/situation", (c) => {
    const r = situation({ station: c.req.query("station"), trainId: c.req.query("trainId"), from: c.req.query("from"), to: c.req.query("to") });
    return "error" in r ? c.json({ error: r.error }, 404) : c.json(r);
  });
  app.get("/geometry/section", (c) => {
    const r = sectionGeometry(c.req.query("from") ?? "", c.req.query("to") ?? "");
    return r ? c.json(r) : c.json({ error: "Unknown stations" }, 404);
  });
  app.get("/geometry/journey/:id", (c) => {
    const r = journeyGeometry(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "Unknown or expired journey (plan again)" }, 404);
  });
  app.get("/geometry/train/:trainId", (c) => {
    const r = trainGeometry(c.req.param("trainId"), c.req.query("from"), c.req.query("to"));
    return r ? c.json(r) : c.json({ error: "Unknown train or stops" }, 404);
  });
  // Back to reality: delete everything we created (disruptions, marked incidents)
  // and every train snaps back to the real data.
  app.post("/control/reset", (c) => {
    const t = Date.now();
    let removed = 0;
    for (const d of [...disruptions.values()]) {
      if (!d.endedAt) d.endedAt = t;
      removeDisruption(d.id);
      removed++;
    }
    for (const i of [...incidents.values()]) {
      incidents.delete(i.id);
      clear(`incidents/${i.id}`);
      removed++;
    }
    forgetAll(); // replacement buses and every timetable change
    const synced = sync();
    event("sync", { type: "reset", removed, trainIds: synced });
    return c.json({ removed, synced: synced.length });
  });
  app.post("/control/release-all", (c) => {
    const n = releaseAll();
    event("disruption", { type: "release.all", count: n });
    return c.json({ ended: n });
  });
  app.post("/trains/:id/release", (c) => {
    const ended = releaseTrain(c.req.param("id"));
    event("disruption", { type: "train.released", trainId: c.req.param("id"), ended });
    return c.json({ ended });
  });
  // Back to reality
  app.post("/sync", async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.trainIds) && b.trainIds.length ? (b.trainIds as string[]) : undefined;
    const synced = sync(ids);
    event("sync", { type: ids ? "sync.trains" : "sync.all", trainIds: synced });
    return c.json({ synced });
  });
  return app;
}
