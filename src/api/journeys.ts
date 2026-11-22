import { Hono } from "hono";
import { brief } from "../brief.ts";
import { InputError } from "../disruptions.ts";
import { journeyDetail, journeyGeometry, plan, sectionGeometry, situation, trainGeometry } from "../planner.ts";

export const journeyRoutes = new Hono();

journeyRoutes.get("/plan", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) throw new InputError("from and to are required (station id or name)");
  const after = Number(c.req.query("after") ?? Date.now()) || Date.now();
  const limit = Math.max(1, Math.min(6, Number(c.req.query("limit") ?? 4) || 4));
  const maxTransfers = c.req.query("maxTransfers");
  const includeWait = c.req.query("includeWait");
  const result = plan(from, to, after, limit, {
    maxTransfers: maxTransfers === undefined ? undefined : Number(maxTransfers),
    via: c.req.query("via") || undefined,
    includeWait: includeWait === "true" || includeWait === "1",
  });
  return "error" in result ? c.json({ error: result.error }, 404) : c.json(result);
});
journeyRoutes.get("/brief", (c) => {
  const r = brief({ station: c.req.query("station"), from: c.req.query("from"), to: c.req.query("to"), lat: c.req.query("lat"), lon: c.req.query("lon") });
  return "error" in r ? c.json({ error: r.error }, 404) : c.json(r);
});
journeyRoutes.get("/situation", (c) => {
  const r = situation({ station: c.req.query("station"), trainId: c.req.query("trainId"), from: c.req.query("from"), to: c.req.query("to") });
  return "error" in r ? c.json({ error: r.error }, 404) : c.json(r);
});
journeyRoutes.get("/geometry/section", (c) => {
  const r = sectionGeometry(c.req.query("from") ?? "", c.req.query("to") ?? "");
  return r ? c.json(r) : c.json({ error: "Unknown stations" }, 404);
});
// one journey stop by stop, with live times and the stops that are not served (itineraries, printed reports)
journeyRoutes.get("/journeys/:id", (c) => {
  const r = journeyDetail(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Unknown or expired journey (plan again)" }, 404);
});
journeyRoutes.get("/geometry/journey/:id", (c) => {
  const r = journeyGeometry(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Unknown or expired journey (plan again)" }, 404);
});
journeyRoutes.get("/geometry/train/:trainId", (c) => {
  const r = trainGeometry(c.req.param("trainId"), c.req.query("from"), c.req.query("to"));
  return r ? c.json(r) : c.json({ error: "Unknown train or stops" }, 404);
});
