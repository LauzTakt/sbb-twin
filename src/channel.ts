// The control page's own link to the twin: a WebSocket at /live fed straight from the engine's state, not through
// the MQTT broker (the broker is the output for other teams). A page gets everything when it connects; then the
// fleet and status every tick, the whole control state whenever it changes, events as they
// happen, and the train it is watching.
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

type Page = { ws: WebSocket; watch: string | null };
const pages = new Set<Page>();
const last = new Map<string, string>(); // latest message per key, replayed to a page that connects
const recent: string[] = []; // latest events, newest first

export function startChannel(http: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/live" && !req.url?.startsWith("/live?")) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const page: Page = { ws, watch: null };
      pages.add(page);
      for (const m of last.values()) ws.send(m);
      ws.send(`{"type":"events","events":[${recent.join(",")}]}`);
      ws.on("message", (data) => {
        try {
          const m = JSON.parse(String(data)) as { watch?: unknown };
          if ("watch" in m) page.watch = typeof m.watch === "string" ? m.watch : null;
        } catch {
          // ignore anything that is not a watch request
        }
      });
      const gone = () => pages.delete(page);
      ws.on("close", gone);
      ws.on("error", gone);
    });
  });
}

const open = (p: Page) => p.ws.readyState === p.ws.OPEN;

/** To every page. With a key the message is also kept and replayed to pages that connect later. */
export function send(key: string | null, msg: object, opts: { droppable?: boolean } = {}) {
  const s = JSON.stringify(msg);
  if (key) last.set(key, s);
  for (const p of pages) if (open(p) && !(opts.droppable && p.ws.bufferedAmount > 4e6)) p.ws.send(s);
}
export function sendEvent(ev: object) {
  const s = JSON.stringify(ev);
  recent.unshift(s);
  if (recent.length > 80) recent.pop();
  const m = `{"type":"event","event":${s}}`;
  for (const p of pages) if (open(p)) p.ws.send(m);
}
/** Train ids some page is watching. */
export function watched() {
  const ids = new Set<string>();
  for (const p of pages) if (p.watch) ids.add(p.watch);
  return ids;
}
export function sendToWatchers(trainId: string, msg: object) {
  const s = JSON.stringify(msg);
  for (const p of pages) if (p.watch === trainId && open(p)) p.ws.send(s);
}
export const pageCount = () => pages.size;
