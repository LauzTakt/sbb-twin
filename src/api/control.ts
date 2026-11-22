import { Hono, type Context } from "hono";
import { CAUSES, MEASURES } from "../catalogue.ts";
import { createTrainDisruption, createIncident, disruptions, incidents, InputError, releaseAll, releaseTrain, TRAIN_ACTIONS, type Disruption } from "../disruptions.ts";
import { byTrainId, sync } from "../engine.ts";
import { bulletins, controlState, disruptionPayload, event, incidentPayload, removeDisruption, statusPayload } from "../feed.ts";
import { clear, publish } from "../mqtt.ts";
import { replayOutcome, replayStatus, startReplay } from "../replay.ts";
import { dropAllResumptions, dropResumption } from "../resumption.ts";
import { acceptProposal, addMeasure, bulletinIn, createScenario, forgetAll, isScenario, latestBulletin, resume, setState, withdrawMeasure } from "../scenario.ts";
import { stops } from "../timetable.ts";

function trainLabel(id: string) {
  const train = byTrainId.get(id);
  return train && `${train.trip.line} → ${train.trip.head}`;
}

function publishDisruptionStarted(disruption: Disruption) {
  publish(`truth/disruptions/${disruption.id}`, disruptionPayload(disruption), { retain: true, qos: 1 });
  event("disruption", { type: "disruption.started", id: disruption.id, label: disruption.label, where: disruption.where });
}

function scenarioResponse(disruption: ReturnType<typeof createScenario>) {
  return { disruption: disruptionPayload(disruption), bulletin: latestBulletin(disruption), warnings: disruption.scenario.warnings ?? [] };
}

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

async function body(c: Context): Promise<Record<string, unknown>> {
  return (await c.req.json<Record<string, unknown>>().catch(() => null)) ?? {};
}

export const controlRoutes = new Hono();

// Scenario disruptions (a cause, an effect state, the control centre's measures) and train-level actions
controlRoutes.get("/disruption-types", (c) => c.json(CAUSES.map((x) => ({ ...x, defaultMinutes: x.minutes }))));
controlRoutes.get("/measure-types", (c) => c.json(MEASURES));
controlRoutes.get("/train-actions", (c) => c.json(TRAIN_ACTIONS));
controlRoutes.get("/disruptions", (c) => c.json([...disruptions.values()].map(disruptionPayload)));
controlRoutes.get("/disruptions/:id", (c) => {
  const d = disruptions.get(c.req.param("id"));
  return d ? c.json(disruptionPayload(d)) : c.json({ error: "Unknown disruption" }, 404);
});
controlRoutes.post("/disruptions", async (c) => {
  const b = await body(c);
  if (b.cause !== undefined) {
    const d = createScenario(b);
    publishDisruptionStarted(d);
    return c.json({ ...scenarioResponse(d), proposal: d.scenario.proposal }, 201);
  }
  const d = createTrainDisruption(b as Parameters<typeof createTrainDisruption>[0], trainLabel);
  publishDisruptionStarted(d);
  const linked = d.effect === "train_breakdown" ? breakdownSection(d.scope.trainId) : undefined;
  const incident = b.mark
    ? markIncident({ title: `${d.label}: ${d.where}`, description: String(b.note ?? ""), severity: d.effect === "train_breakdown" ? "major" : "minor", type: d.type, reasonCode: d.reasonCode, scope: d.scope, where: d.where, disruptionId: d.id })
    : undefined;
  return c.json({ disruption: disruptionPayload(d), incident: incident ? incidentPayload(incident) : null, linked: linked ? disruptionPayload(linked) : null, bulletin: linked ? latestBulletin(linked) : null }, 201);
});
controlRoutes.post("/disruptions/:id/measures", async (c) => {
  const d = scenarioOf(c.req.param("id"));
  if (!d) return c.json({ error: "Unknown disruption" }, 404);
  const b = await body(c);
  const list = Array.isArray(b.measures) ? (b.measures as Record<string, unknown>[]) : [b];
  const added = list.map((m) => addMeasure(d, m));
  event("disruption", { type: "disruption.measure", id: d.id, measures: added.map((m) => m.type) });
  return c.json({ ...scenarioResponse(d), added }, 201);
});
controlRoutes.post("/disruptions/:id/measures/:mid/withdraw", async (c) => {
  const d = scenarioOf(c.req.param("id"));
  if (!d) return c.json({ error: "Unknown disruption" }, 404);
  const b = await body(c);
  withdrawMeasure(d, c.req.param("mid"), b.at, Date.now(), b.replaced === true);
  return c.json(scenarioResponse(d));
});
controlRoutes.post("/disruptions/:id/proposal/accept", (c) => {
  const d = scenarioOf(c.req.param("id"));
  if (!d) return c.json({ error: "Unknown disruption" }, 404);
  const added = acceptProposal(d);
  return c.json({ ...scenarioResponse(d), added }, 201);
});
controlRoutes.post("/disruptions/:id/state", async (c) => {
  const d = scenarioOf(c.req.param("id"));
  if (!d) return c.json({ error: "Unknown disruption" }, 404);
  const b = await body(c);
  setState(d, b.effect, b.at);
  event("disruption", { type: "disruption.state", id: d.id, effect: b.effect });
  return c.json(scenarioResponse(d));
});
controlRoutes.post("/disruptions/:id/end", async (c) => {
  const id = c.req.param("id");
  const s = disruptions.get(id);
  if (s && isScenario(s)) {
    const b = await body(c);
    if (!s.endedAt) resume(s, b.at);
    return c.json(scenarioResponse(s));
  }
  const d = endDisruption(id);
  return d ? c.json(disruptionPayload(d)) : c.json({ error: "Unknown disruption" }, 404);
});
controlRoutes.delete("/disruptions/:id", (c) => {
  const d = endDisruption(c.req.param("id"));
  if (!d) return c.json({ error: "Unknown disruption" }, 404);
  removeDisruption(d.id);
  dropResumption(d.id); // withdrawn, not resumed
  return c.json({ removed: d.id });
});
controlRoutes.get("/bulletins", (c) => c.json(bulletins()));

controlRoutes.get("/bulletins/:id", async (c) => {
  const d = disruptions.get(c.req.param("id"));
  if (!d || !isScenario(d)) return c.json({ error: "Unknown disruption" }, 404);
  const lang = (c.req.query("lang") ?? "en").toLowerCase();
  if (lang !== "en") {
    if (!["de", "fr", "it"].includes(lang)) throw new InputError("lang is en, de, fr or it");
    return c.json({ latest: await bulletinIn(d, lang as "de" | "fr" | "it"), versions: d.scenario.bulletins });
  }
  return c.json({ latest: latestBulletin(d), versions: d.scenario.bulletins });
});

controlRoutes.get("/incidents", (c) => c.json([...incidents.values()].map(incidentPayload)));
controlRoutes.post("/incidents", async (c) => {
  const b = await body(c);
  if (!b.title || typeof b.title !== "string") throw new InputError("An incident needs a title");
  return c.json(incidentPayload(markIncident(b as Parameters<typeof createIncident>[0])), 201);
});
controlRoutes.delete("/incidents/:id", (c) => {
  const i = incidents.get(c.req.param("id"));
  if (!i) return c.json({ error: "Unknown incident" }, 404);
  incidents.delete(i.id);
  clear(`incidents/${i.id}`);
  event("incident", { type: "incident.unmarked", id: i.id, title: i.title });
  return c.json({ removed: i.id });
});

controlRoutes.get("/control/state", (c) => c.json({ ...controlState(), status: statusPayload() }));

controlRoutes.get("/replays", (c) => c.json(replayStatus()));
controlRoutes.get("/replays/outcome", (c) => c.json(replayOutcome()));
controlRoutes.post("/replays/:name/start", (c) => c.json(startReplay(c.req.param("name")), 201));

// Back to reality: delete everything we created (disruptions, marked incidents)
// and every train snaps back to the real data.
controlRoutes.post("/control/reset", (c) => {
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
  dropAllResumptions();
  const synced = sync();
  event("sync", { type: "reset", removed, trainIds: synced });
  return c.json({ removed, synced: synced.length });
});
controlRoutes.post("/control/release-all", (c) => {
  const n = releaseAll();
  event("disruption", { type: "release.all", count: n });
  return c.json({ ended: n });
});
controlRoutes.post("/trains/:id/release", (c) => {
  const ended = releaseTrain(c.req.param("id"));
  event("disruption", { type: "train.released", trainId: c.req.param("id"), ended });
  return c.json({ ended });
});
// Back to reality
controlRoutes.post("/sync", async (c) => {
  const b = await body(c);
  const ids = Array.isArray(b.trainIds) && b.trainIds.length ? (b.trainIds as string[]) : undefined;
  const synced = sync(ids);
  event("sync", { type: ids ? "sync.trains" : "sync.all", trainIds: synced });
  return c.json({ synced });
});
