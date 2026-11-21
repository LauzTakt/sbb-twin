// HTTP control API for staff (provoke/end disruptions, mark/unmark incidents, sync) and read helpers.
import { Hono } from "hono";
import { InputError, TYPES, createDisruption, createIncident, disruptions, incidents } from "./disruptions.ts";
import { byTrainId, sync, trains } from "./engine.ts";
import { searchStations } from "./timetable.ts";
import { networkGeoJson } from "./geometry.ts";
import { disruptionPayload, event, incidentPayload, infoPayload, positionPayload, removeDisruption, statusPayload } from "./feed.ts";
import { clear, publish } from "./mqtt.ts";
import { GRID, weather } from "./weather.ts";

const trainLookup = (id: string) => {
  const tr = byTrainId.get(id);
  if (!tr) return undefined;
  const next = tr.leg >= 0 ? tr.leg + 1 : tr.call + 1;
  return { label: `${tr.trip.line} → ${tr.trip.head}`, nextStation: next < tr.trip.stops.length - 1 ? tr.trip.stops[next] : undefined };
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

export function api() {
  const app = new Hono().basePath("/api");
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
  app.get("/network.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=3600");
    return c.body(networkGeoJson());
  });

  app.get("/weather", (c) => c.json({ stations: [...weather.stations.values()], fetchedAt: weather.fetchedAt, measuredAt: weather.grid?.measuredAt ?? null }));
  app.get("/weather/temperature-grid", (c) => c.json(weather.grid ? { bbox: [GRID.west, GRID.south, GRID.east, GRID.north], step: GRID.step, ...weather.grid } : { error: "not ready" }));

  // Provoke disruptions (ground truth: trains really change behaviour)
  app.get("/disruption-types", (c) => c.json(TYPES));
  app.get("/disruptions", (c) => c.json([...disruptions.values()].map(disruptionPayload)));
  app.post("/disruptions", async (c) => {
    const b = await body(c);
    const d = createDisruption(b as Parameters<typeof createDisruption>[0], trainLookup);
    publish(`truth/disruptions/${d.id}`, disruptionPayload(d), { retain: true, qos: 1 });
    event("disruption", { type: "disruption.started", id: d.id, label: d.label, where: d.where });
    const incident = b.mark
      ? markIncident({ title: `${d.label}: ${d.where}`, description: String(b.note ?? ""), severity: severityFor[d.effect], type: d.type, reasonCode: d.reasonCode, scope: d.scope, where: d.where, disruptionId: d.id })
      : undefined;
    return c.json({ disruption: disruptionPayload(d), incident: incident ? incidentPayload(incident) : null }, 201);
  });
  app.post("/disruptions/:id/end", (c) => {
    const d = endDisruption(c.req.param("id"));
    return d ? c.json(disruptionPayload(d)) : c.json({ error: "Unknown disruption" }, 404);
  });
  app.delete("/disruptions/:id", (c) => {
    const d = endDisruption(c.req.param("id"));
    if (!d) return c.json({ error: "Unknown disruption" }, 404);
    removeDisruption(d.id);
    return c.json({ removed: d.id });
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
