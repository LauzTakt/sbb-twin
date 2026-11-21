// The page reads the twin directly over WebSocket /live (trains every second, incidents and alerts when they change).

export type SnapshotRow = [trainId: string, lat: number, lon: number, bearing: number, speedKmh: number, motion: string, delaySec: number, line: string, category: string, atStopId: string | null, continuity: number];
export type Geometry = { type: string; coordinates: unknown } | null;
export type Status = { ts: number; trainsActive: number };
/** A disruption registered in the twin (control-centre view). Fields beyond the first group come with the scenario API. */
export type Disruption = {
  id: string; label?: string; summary?: string; description?: string; where: string; status: "active" | "ended"; effect: string; geometry: Geometry;
  cause?: { code: string; label: string }; durationType?: string; until?: number | null; endsAt?: number | null; lines?: string[]; lifecycle?: string;
  measures?: { id?: string; type: string; label?: string; at?: string; state?: string }[]; bulletinVersion?: number;
};
/** A disruption on the railway: a real SBB alert, or an incident the twin detected itself. */
export type Item = { id: string; title: string; where: string; severity: "info" | "minor" | "major" | "critical"; note: string; trains: number; geometry: Geometry; source: "sbb" | "auto"; trainIds?: string[] };

type Alert = { id: string; title: string; cause: string; severity: "info" | "minor" | "major"; activePeriods: { start: number | null; end: number | null }[]; stations: { name: string }[]; trains: number; geometry: Geometry };
type Incident = { id: string; title: string; where: string; severity: Item["severity"]; createdAt: number; geometry: Geometry; trainIds?: string[]; disruptionId?: string };
type Handlers = {
  connection: (state: "connecting" | "online" | "offline") => void;
  tick: (rows: SnapshotRow[], status: Status) => void;
  items: (list: Item[]) => void;
  disruptions: (list: Disruption[]) => void;
};
type TrainUpdate = (position: Record<string, unknown> | null, info: Record<string, unknown> | null) => void;
export type Live = { watch: (trainId: string, cb: TrainUpdate) => () => void; close: () => void };

const hm = (ms: number) => new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
function endNote(a: Alert) {
  const now = Date.now();
  const p = a.activePeriods.find((x) => (x.start ?? 0) <= now && (x.end ?? Infinity) >= now) ?? a.activePeriods[0];
  const cause = a.cause !== "unknown" && a.cause !== "other" ? a.cause : "";
  const end = p?.end ? (new Date(p.end).toDateString() === new Date().toDateString() ? `until ${hm(p.end)}` : `until ${new Date(p.end).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`) : "";
  return [cause, end].filter(Boolean).join(" · ");
}

export function connectLive(h: Handlers): Live {
  let ws: WebSocket | undefined;
  let closed = false;
  let watching: { id: string; cb: TrainUpdate } | null = null;
  let alerts: Item[] = [];
  let incidents: Item[] = [];
  const tell = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const push = () => h.items([...alerts, ...incidents]);
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
      if (m.type === "tick") h.tick(m.trains, m.status);
      else if (m.type === "alerts") {
        // only real disruptions: the feed also carries notices ("stop moved", "access restricted", "Information") that are not
        alerts = (m.alerts as Alert[]).filter((a) => /^(Interrupted|Limited|Irregular) service/i.test(a.title)).map((a) => ({ id: a.id, title: a.title, where: a.stations.slice(0, 3).map((x) => x.name).join(", "), severity: a.severity, note: endNote(a), trains: a.trains, geometry: a.geometry, source: "sbb" as const }));
        push();
      } else if (m.type === "state") {
        h.disruptions(m.disruptions as Disruption[]);
        incidents = (m.incidents as Incident[])
          .filter((i) => i.geometry && !i.disruptionId)
          .map((i) => ({ id: i.id, title: i.title, where: i.where, severity: i.severity, note: `since ${hm(i.createdAt)}`, trains: i.trainIds?.length ?? 0, trainIds: i.trainIds, geometry: i.geometry, source: "auto" as const }));
        push();
      } else if (m.type === "train") {
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
export async function api<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
export async function send<T>(method: "POST" | "DELETE", path: string, json?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}
