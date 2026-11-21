// rail-twin: live digital twin of every Swiss train, published on MQTT.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { config } from "./config.ts";
import { api } from "./api.ts";
import { startBroker } from "./mqtt.ts";
import { loadGeometry } from "./geometry.ts";
import { applyRealtime, loadTimetable, tick, trains } from "./engine.ts";
import { live, pollRealtime } from "./realtime.ts";
import { event, publishTick } from "./feed.ts";
import { pollWeather, publishWeather, weather } from "./weather.ts";
import { expireWeather } from "./god.ts";

process.on("unhandledRejection", (e) => console.error("[rail-twin] unhandled:", (e as Error)?.message ?? e));

const geo = loadGeometry();
console.log(`[rail-twin] track geometry: ${geo.edges} BAV edges, ${geo.paths} matched station pairs`);
await loadTimetable();
if (live.enabled()) {
  const ok = await pollRealtime();
  console.log(`[rail-twin] GTFS-RT: ${ok ? `${live.trips.size} trips` : live.error}`);
} else console.warn("[rail-twin] no OTD_GTFS_RT_KEY: trains follow the planned timetable only");

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
await startBroker(server);
server.listen(config.port, config.host, () =>
  console.log(`[rail-twin] viewer + API http://${config.host}:${config.port}/ · MQTT tcp://${config.host}:${config.mqttPort} · MQTT/WebSocket ws://${config.host}:${config.port}/mqtt`),
);
event("system", { type: "system.started" });

// One tick per wall-clock second: every train moves, then everything is published with that timestamp.
function loop() {
  const t = Math.floor(Date.now() / 1000) * 1000;
  try {
    const { removed } = tick(t);
    publishTick(t, removed);
  } catch (err) {
    console.error("[rail-twin] tick failed:", err);
  }
  setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
}
loop();
console.log(`[rail-twin] ${trains.size} trains in service`);

setInterval(async () => {
  if (await pollRealtime()) applyRealtime();
}, config.rtIntervalMs).unref();
// MeteoSwiss publishes 10-minute values; poll every 5 minutes.
const refreshWeather = async () => {
  if (await pollWeather()) publishWeather();
  else console.warn("[rail-twin] weather:", weather.error);
};
void refreshWeather().then(() => console.log(`[rail-twin] weather: ${weather.stations.size} MeteoSwiss stations`));
setInterval(refreshWeather, 5 * 60_000).unref();
setInterval(expireWeather, 10_000).unref();
setInterval(async () => {
  if (await loadTimetable().catch((e) => (console.error("[rail-twin] timetable:", e.message), false))) event("system", { type: "system.timetable", note: "new service day loaded" });
}, 60_000).unref();
