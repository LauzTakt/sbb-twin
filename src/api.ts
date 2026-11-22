import { Hono } from "hono";
import { controlRoutes } from "./api/control.ts";
import { forecastRoutes } from "./api/forecasts.ts";
import { journeyRoutes } from "./api/journeys.ts";
import { createNetworkRoutes } from "./api/network.ts";
import { InputError } from "./disruptions.ts";
import { pushState, statusPayload } from "./feed.ts";
import { forecastTick } from "./forecast.ts";
import { scenarioTick } from "./scenario.ts";

export function api() {
  const app = new Hono().basePath("/api");
  // every change reaches the control pages at once (the engine also checks every tick)
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET") {
      scenarioTick(Date.now(), true); // bulletins and the effective timetable follow at once
      forecastTick(Date.now()); // forecasts follow at once (a resumption is scored at once)
      pushState();
    }
  });
  app.onError((err, c) => {
    if (err instanceof InputError) return c.json({ error: err.message }, 422);
    console.error("[api]", err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/status", (c) => c.json(statusPayload()));
  app.route("/", createNetworkRoutes());
  app.route("/", journeyRoutes);
  app.route("/forecasts", forecastRoutes);
  app.route("/", controlRoutes);
  return app;
}
