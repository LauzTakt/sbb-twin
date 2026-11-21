// The viewer reads rail-twin exactly as other teams do: MQTT over WebSocket.
import mqtt, { type MqttClient } from "mqtt";

export const ROOT = "rail/v1";
export type SnapshotRow = [trainId: string, lat: number, lon: number, bearing: number, speedKmh: number, motion: string, delaySec: number, line: string, category: string, atStopId: string | null, continuity: number];
export type Disruption = { id: string; type: string; label: string; reasonCode: string; effect: string; where: string; status: "active" | "ended"; startedAt: number; endsAt: number | null; endedAt: number | null; affectedTrains: string[]; scope: Record<string, string>; params: Record<string, number>; geometry: Geometry };
export type Geometry = { type: string; coordinates: unknown } | null;
export type Incident = { id: string; title: string; description: string; severity: string; where: string; createdAt: number; disruptionId?: string; geometry: Geometry };
export type Status = { ts: number; trainsActive: number; trainsSimulated: number; realtime: { enabled: boolean; feedAgeSec: number | null; trips: number }; brokerClients: number; timetableDate: string };
export type Event = { ts: number; kind: string; type: string; [k: string]: unknown };
export type WeatherSnapshot = { ts: number; measuredAt: number | null; fields: string[]; stations: [string, string, number, number, number, number | null, number | null, number | null, number | null][] };
export type TemperatureGrid = { ts: number; measuredAt: number; bbox: [number, number, number, number]; step: number; cols: number; rows: number; values: (number | null)[] };

export function brokerUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/mqtt`;
}

type Handlers = {
  snapshot: (ts: number, rows: SnapshotRow[]) => void;
  status: (s: Status) => void;
  disruption: (id: string, d: Disruption | null) => void;
  incident: (id: string, i: Incident | null) => void;
  simulated: (trainId: string, on: boolean) => void;
  event: (e: Event) => void;
  connection: (state: "connecting" | "online" | "offline") => void;
  weather: (w: WeatherSnapshot) => void;
  grid: (g: TemperatureGrid) => void;
};

export function connectFeed(h: Handlers): MqttClient {
  h.connection("connecting");
  const c = mqtt.connect(brokerUrl(), { reconnectPeriod: 2000, clientId: `viewer-${Math.random().toString(36).slice(2, 8)}` });
  c.on("connect", () => {
    h.connection("online");
    c.subscribe([`${ROOT}/fleet`, `${ROOT}/status`, `${ROOT}/truth/disruptions/+`, `${ROOT}/incidents/+`, `${ROOT}/truth/trains/+`, `${ROOT}/events/#`, `${ROOT}/truth/events`, `${ROOT}/weather/snapshot`, `${ROOT}/weather/temperature-grid`]);
  });
  c.on("close", () => h.connection("offline"));
  c.on("message", (topic, payload) => {
    const text = payload.toString();
    const parts = topic.split("/");
    const last = parts[parts.length - 1];
    const body = text ? JSON.parse(text) : null;
    if (topic.endsWith("/fleet")) h.snapshot(body.ts, body.trains);
    else if (topic.endsWith("/status")) h.status(body);
    else if (topic.includes("/truth/disruptions/")) h.disruption(last, body);
    else if (topic.includes("/incidents/")) h.incident(last, body);
    else if (topic.includes("/truth/trains/")) h.simulated(last, Boolean(body));
    else if ((topic.includes("/events/") || topic.endsWith("/truth/events")) && body) h.event(body);
    else if (topic.endsWith("/weather/snapshot") && body) h.weather(body);
    else if (topic.endsWith("/weather/temperature-grid") && body) h.grid(body);
  });
  return c;
}

/** Live position + info of one train (for the details panel). */
export function watchTrain(c: MqttClient, trainId: string, onPosition: (p: Record<string, unknown>) => void, onInfo: (i: Record<string, unknown>) => void) {
  const pos = `${ROOT}/trains/${trainId}/position`;
  const info = `${ROOT}/trains/${trainId}/info`;
  const handler = (topic: string, payload: Buffer) => {
    if (!payload.length) return;
    if (topic === pos) onPosition(JSON.parse(payload.toString()));
    else if (topic === info) onInfo(JSON.parse(payload.toString()));
  };
  c.on("message", handler);
  c.subscribe([pos, info]);
  return () => {
    c.unsubscribe([pos, info]);
    c.off("message", handler);
  };
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json" }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}
