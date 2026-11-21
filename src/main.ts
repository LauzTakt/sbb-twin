// sbb-twin: live digital twin of every Swiss train, published on MQTT.
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
import { overridePayload, pollWeather, publishWeather, weather } from "./weather.ts";
import { expireWeather } from "./god.ts";
import { loadState, saveState } from "./persist.ts";
import { incidents } from "./disruptions.ts";
import { settings } from "./engine.ts";
import { incidentPayload } from "./feed.ts";
import { publish } from "./mqtt.ts";

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
if (restored.disruptions + restored.overrides + restored.incidents) console.log(`[sbb-twin] restored ${restored.disruptions} disruptions, ${restored.overrides} weather changes, ${restored.incidents} incidents`);
for (const i of incidents.values()) publish(`incidents/${i.id}`, incidentPayload(i), { retain: true, qos: 1 });
publish("truth/settings", { v: 1, ...settings, ts: Date.now() }, { retain: true, qos: 1 });
setInterval(saveState, 2000).unref();
server.listen(config.port, config.host, () =>
  console.log(`[sbb-twin] viewer + API http://${config.host}:${config.port}/ · MQTT ${config.mqttUrl ? `on ${new URL(config.mqttUrl).host} (read-only WebSocket proxy at /mqtt)` : `tcp://${config.host}:${config.mqttPort} + ws://${config.host}:${config.port}/mqtt`}`),
);
event("system", { type: "system.started" });

// One tick per wall-clock second: every train moves, then everything is published with that timestamp.
function loop() {
  const t = Math.floor(Date.now() / 1000) * 1000;
  try {
    const { removed } = tick(t);
    publishTick(t, removed);
  } catch (err) {
    console.error("[sbb-twin] tick failed:", err);
  }
  setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
}
loop();
console.log(`[sbb-twin] ${trains.size} trains in service`);

setInterval(async () => {
  if (await pollRealtime()) applyRealtime();
}, config.rtIntervalMs).unref();
// MeteoSwiss publishes 10-minute values; poll every 5 minutes.
const refreshWeather = async () => {
  if (await pollWeather()) publishWeather();
  else console.warn("[sbb-twin] weather:", weather.error);
};
void refreshWeather().then(() => {
  console.log(`[sbb-twin] weather: ${weather.stations.size} MeteoSwiss stations`);
  for (const o of weather.overrides.values()) publish(`truth/weather/${o.id}`, overridePayload(o), { retain: true, qos: 1 });
});
setInterval(refreshWeather, 5 * 60_000).unref();
setInterval(expireWeather, 10_000).unref();
setInterval(async () => {
  if (await loadTimetable().catch((e) => (console.error("[sbb-twin] timetable:", e.message), false))) event("system", { type: "system.timetable", note: "new service day loaded" });
}, 60_000).unref();
