// The viewer reads sbb-twin exactly as other teams do: MQTT over WebSocket.

export const ROOT = "sbb-twin/v1";
export type SnapshotRow = [trainId: string, lat: number, lon: number, bearing: number, speedKmh: number, motion: string, delaySec: number, line: string, category: string, atStopId: string | null, continuity: number];
export type Disruption = { id: string; type: string; label: string; reasonCode: string; effect: string; where: string; status: "active" | "ended"; startedAt: number; endsAt: number | null; endedAt: number | null; affectedTrains: string[]; scope: Record<string, string>; params: Record<string, number>; geometry: Geometry };
export type Geometry = { type: string; coordinates: unknown } | null;
export type Incident = { id: string; title: string; description: string; severity: string; where: string; createdAt: number; disruptionId?: string; source?: "staff" | "auto"; geometry: Geometry };
export type Status = { ts: number; trainsActive: number; trainsSimulated: number; realtime: { enabled: boolean; feedAgeSec: number | null; trips: number }; broker?: { mode: string; connected: boolean; viewers: number }; timetableDate: string };
export type Event = { ts: number; kind: string; type: string; [k: string]: unknown };
export function brokerUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/mqtt`;
}

export type ControlState = { ts: number; disruptions: Disruption[]; incidents: Incident[]; simulated: { trainId: string; causes: string[] }[] };
type Handlers = {
  connection: (state: "connecting" | "online" | "offline") => void;
  tick: (ts: number, rows: SnapshotRow[], status: Status) => void;
  /** the whole control state: replaces what the page shows */
  state: (s: ControlState) => void;
  events: (list: Event[]) => void;
  event: (e: Event) => void;
};
type TrainUpdate = (position: Record<string, unknown> | null, info: Record<string, unknown> | null) => void;
export type Live = { watch: (trainId: string, cb: TrainUpdate) => () => void; close: () => void };

/** The control page reads the twin directly (WebSocket /live), not through the broker. */
export function connectLive(h: Handlers): Live {
  let ws: WebSocket | undefined;
  let closed = false;
  let watching: { id: string; cb: TrainUpdate } | null = null;
  const tell = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const open = () => {
    h.connection("connecting");
    const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`);
    ws = s;
    s.onopen = () => {
      h.connection("online");
      if (watching) tell({ watch: watching.id });
    };
    s.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type === "tick") h.tick(m.ts, m.trains, m.status);
      else if (m.type === "state") h.state(m);
      else if (m.type === "event") h.event(m.event);
      else if (m.type === "events") h.events(m.events);
      else if (m.type === "train") {
        const w = watching;
        if (w && w.id === m.trainId) w.cb(m.position, m.info);
      }
    };
    s.onclose = () => {
      if (ws !== s) return;
      h.connection("offline");
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return {
    watch(id, cb) {
      watching = { id, cb };
      tell({ watch: id });
      return () => {
        if (watching?.id !== id) return;
        watching = null;
        tell({ watch: null });
      };
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json" }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}
