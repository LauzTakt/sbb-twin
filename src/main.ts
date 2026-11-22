// sbb-twin: live digital twin of every Swiss train, published on MQTT.
import { nextTickIn } from "./clock.ts"; // first: a replay replaces the clock before anything reads it
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { config } from "./config.ts";
import { api } from "./api.ts";
import { startBroker } from "./mqtt.ts";
import { startChannel } from "./channel.ts";
import { loadGeometry } from "./geometry.ts";
import { applyRealtime, loadTimetable, tick, trains } from "./engine.ts";
import { live, pollRealtime } from "./realtime.ts";
import { event, publishTick } from "./feed.ts";
import { loadState, saveState } from "./persist.ts";
import { incidents } from "./disruptions.ts";
import { incidentPayload } from "./feed.ts";
import { publish } from "./mqtt.ts";
import { alertsState, pollAlerts } from "./alerts.ts";
import { bulletins } from "./feed.ts";
import { scenarioTick } from "./scenario.ts";
import { recordRemoved, replayTick, startReplay } from "./replay.ts";
import { warmPlanner } from "./planner.ts";

process.on("unhandledRejection", (e) => console.error("[sbb-twin] unhandled:", (e as Error)?.message ?? e));

const geo = loadGeometry();
console.log(`[sbb-twin] track geometry: ${geo.edges} BAV edges, ${geo.paths} matched station pairs`);
await loadTimetable();
if (live.enabled()) {
  const ok = await pollRealtime();
  console.log(`[sbb-twin] GTFS-RT: ${ok ? `${live.trips.size} trips` : live.error}`);
} else console.warn("[sbb-twin] no OTD_GTFS_RT_KEY: trains follow the planned timetable only");

const handleApi = getRequestListener(api().fetch);
type Vite = { middlewares: (req: IncomingMessage, res: ServerResponse) => void };
let vite: Vite | undefined;
const dist = join(config.viewerDir, "dist");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
async function serveViewer(req: IncomingMessage, res: ServerResponse) {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || path.endsWith("/")) file = join(dist, "index.html");
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  res.end(await readFile(file));
}
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) return handleApi(req, res);
  if (vite) return vite.middlewares(req, res);
  void serveViewer(req, res);
});
if (!config.production) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({ configFile: join(config.viewerDir, "vite.config.ts"), server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: "spa" });
}
startChannel(server);
await startBroker(server);
// god-mode state from before a restart: disruptions republish on the first tick, the rest here
const restored = loadState();
if (restored.disruptions + restored.incidents) console.log(`[sbb-twin] restored ${restored.disruptions} disruptions, ${restored.incidents} incidents`);
for (const i of incidents.values()) publish(`incidents/${i.id}`, incidentPayload(i), { retain: true, qos: 1 });
for (const b of bulletins()) publish(`bulletins/${b.id}`, { v: 1, ...b }, { retain: true, qos: 1 });
setInterval(saveState, 2000).unref();
server.listen(config.port, config.host, () =>
  console.log(`[sbb-twin] viewer + API http://${config.host}:${config.port}/ · MQTT ${config.mqttUrl ? `on ${new URL(config.mqttUrl).host} (read-only WebSocket proxy at /mqtt)` : `ws://${config.host}:${config.port}/mqtt`}`),
);
event("system", { type: "system.started" });
if (process.env.RAIL_REPLAY_SCENARIO) console.log("[replay]", JSON.stringify(startReplay(process.env.RAIL_REPLAY_SCENARIO).upcoming?.length ?? 0), "steps to come");

// One tick per wall-clock second: every train moves, then everything is published with that timestamp.
function loop() {
  const t = Math.floor(Date.now() / 1000) * 1000;
  try {
    replayTick(t); // a scripted replay's decisions at their real times
    scenarioTick(t); // decisions taking effect, the effective timetable, buses and bulletins
    const { removed } = tick(t);
    recordRemoved(removed);
    publishTick(t, removed);
  } catch (err) {
    console.error("[sbb-twin] tick failed:", err);
  }
  setTimeout(loop, nextTickIn());
}
loop();
console.log(`[sbb-twin] ${trains.size} trains in service`);

setInterval(warmPlanner, 4000).unref(); // journeys and briefs answer from a ready connection list
setInterval(async () => {
  if (await pollRealtime()) applyRealtime();
}, config.rtIntervalMs).unref();
// MeteoSwiss publishes 10-minute values; poll every 5 minutes.
// real SBB service alerts (when a key is set): at start and every few minutes
void pollAlerts().then(() => config.gtfsSaKey && console.log(`[sbb-twin] service alerts: ${alertsState.alerts.size} touch the railway`));
setInterval(() => void pollAlerts(), config.saIntervalMs).unref();
setInterval(async () => {
  if (await loadTimetable().catch((e) => (console.error("[sbb-twin] timetable:", e.message), false))) event("system", { type: "system.timetable", note: "new service day loaded" });
}, 60_000).unref();
