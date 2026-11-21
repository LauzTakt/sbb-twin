import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// On the dev box secrets live in a private env file; in Docker they arrive as environment variables.
const envFile = process.env.RAIL_ENV_FILE ?? `${homedir()}/.config/lauzhack/.env`;
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  mqttPort: Number(process.env.MQTT_PORT ?? 1883),
  // external broker (the team's): when set, everything is published there instead of the embedded broker
  mqttUrl: process.env.MQTT_URL ?? "",
  mqttUsername: process.env.MQTT_USERNAME ?? undefined,
  mqttPassword: process.env.MQTT_PASSWORD ?? undefined,
  dataDir: process.env.RAIL_DATA_DIR ?? here("../data/"),
  daysDir: process.env.RAIL_DAYS_DIR ?? (existsSync(here("../data/days/")) ? here("../data/days/") : "/workspace/sbb/gtfs/"),
  gtfsRtKey: process.env.OTD_GTFS_RT_KEY ?? "",
  gtfsRtUrl: process.env.OTD_GTFS_RT_URL ?? "https://api.opentransportdata.swiss/la/gtfs-rt",
  rtIntervalMs: Number(process.env.RT_INTERVAL_MS ?? 30_000),
  // real service alerts (a separate opentransportdata.swiss key)
  gtfsSaKey: process.env.OTD_GTFS_SA_KEY ?? "",
  gtfsSaUrl: process.env.OTD_GTFS_SA_URL ?? "https://api.opentransportdata.swiss/la/gtfs-sa",
  saIntervalMs: Number(process.env.SA_INTERVAL_MS ?? 180_000),
  topicRoot: process.env.TOPIC_ROOT ?? "sbb-twin/v1",
  production: process.env.NODE_ENV === "production",
  viewerDir: here("../viewer/"),
};
