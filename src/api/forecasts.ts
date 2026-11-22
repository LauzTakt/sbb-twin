import { Hono } from "hono";
import { forecastsPayload, scorecards, segmentsGeoJson, shadowReport } from "../forecast.ts";
import { resumptionOf, resumptions } from "../resumption.ts";

export const forecastRoutes = new Hono();

forecastRoutes.get("/", (c) => c.json(forecastsPayload()));

forecastRoutes.get("/scorecards", (c) => c.json(scorecards()));

forecastRoutes.get("/shadow", (c) => c.json(shadowReport()));

forecastRoutes.get("/section-risk.geojson", (c) => {
  c.header("content-type", "application/geo+json");
  c.header("cache-control", "public, max-age=300");
  return c.body(segmentsGeoJson());
});

forecastRoutes.get("/post-resumption", (c) => {
  const id = c.req.query("disruptionId");
  if (!id) return c.json(resumptions());
  const f = resumptionOf(id);
  return f ? c.json(f) : c.json({ error: "No forecast for this disruption (it has not resumed, or its hour is over)" }, 404);
});
