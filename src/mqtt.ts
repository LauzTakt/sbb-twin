// Where sbb-twin publishes.
// - MQTT_URL set (the team broker): every message goes there. The viewer reads it through a read-only WebSocket
//   proxy at /mqtt that adds the credentials on the server, so the browser never holds them.
// - otherwise an embedded broker (Aedes), reachable only over WebSocket at /mqtt (no TCP port is opened).
import { connect as tcpConnect } from "node:net";
import type { Server as HttpServer } from "node:http";
import { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import mqttPacket from "mqtt-packet";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { config } from "./config.ts";

export const topic = (path: string) => `${config.topicRoot}/${path}`;
export const OPEN_NAMESPACES = ["detections/", "ext/"];
export const brokerStats = { mode: (config.mqttUrl ? "external" : "embedded") as "external" | "embedded", connected: false, clients: 0 };
let broker: Aedes | undefined;
let upstream: MqttClient | undefined;
const retained = new Map<string, Buffer>(); // the current retained state, sent again after a reconnect
const published = new Set<string>(); // retained topics written by this run

export async function startBroker(http: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("mqtt") ? "mqtt" : p.has("mqttv3.1") ? "mqttv3.1" : false) });
  if (config.mqttUrl) return startUpstream(http, wss);

  // ~1,000-2,000 position messages per second: allow many in flight, and never let one frozen subscriber stall the rest.
  broker = await Aedes.createBroker({ id: "sbb-twin", concurrency: 5000, drainTimeout: 10_000, queueLimit: 5000, heartbeatInterval: 30_000 });
  // Aedes drops a message as a "duplicate" when a later one overtook it on the way out (retained and QoS 1 messages
  // take an extra storage step), so a subscriber to both kinds lost deletions. That check is only for clustered
  // brokers and is skipped when the broker has no id.
  (broker as unknown as { id: string }).id = "";
  broker.authorizePublish = (client, packet, done) => {
    if (!client) return done(null); // sbb-twin itself
    const t = packet.topic;
    if (OPEN_NAMESPACES.some((ns) => t.startsWith(topic(ns))) || !t.startsWith(`${config.topicRoot}/`)) return done(null);
    done(new Error(`${t} is read-only: other teams may publish under ${topic("detections/")} or ${topic("ext/")}`));
  };
  broker.on("client", () => (brokerStats.clients = broker!.connectedClients));
  broker.on("clientDisconnect", () => (brokerStats.clients = broker!.connectedClients));
  brokerStats.connected = true;
  http.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/mqtt")) return; // other upgrades (e.g. Vite HMR) handle themselves
    wss.handleUpgrade(req, socket, head, (ws) => broker!.handle(createWebSocketStream(ws), req));
  });
}

async function startUpstream(http: HttpServer, wss: WebSocketServer) {
  const target = new URL(config.mqttUrl);
  upstream = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: `sbb-twin-${Math.random().toString(36).slice(2, 8)}`,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
    queueQoSZero: false,
  });
  upstream.on("connect", () => {
    brokerStats.connected = true;
    console.log(`[sbb-twin] publishing to ${target.host} under ${config.topicRoot}/`);
    // anything that changed while disconnected: send the current retained state again
    for (const [t, body] of retained) upstream!.publish(t, body, { qos: 1, retain: true });
  });
  upstream.on("close", () => (brokerStats.connected = false));
  upstream.on("error", (e) => console.error("[sbb-twin] MQTT broker:", e.message));
  http.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/mqtt")) return;
    wss.handleUpgrade(req, socket, head, (ws) => proxy(ws, target));
  });
  // do not hold the twin back if the broker is down: publishing starts when it connects
  await new Promise<void>((ok) => {
    upstream!.once("connect", () => ok());
    setTimeout(ok, 8000);
  });
  void sweepStale();
}

/** Browser <-WebSocket-> here <-TCP-> team broker: credentials added here, read-only, limited to our topic root. */
function proxy(ws: WebSocket, target: URL) {
  brokerStats.clients++;
  const tcp = tcpConnect(Number(target.port || 1883), target.hostname);
  const early: Buffer[] = [];
  let open = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    brokerStats.clients = Math.max(0, brokerStats.clients - 1);
    tcp.destroy();
    ws.close();
  };
  tcp.on("connect", () => {
    open = true;
    for (const b of early) tcp.write(b);
    early.length = 0;
  });
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  parser.on("packet", (p) => {
    if (p.cmd === "connect") {
      p.username = config.mqttUsername;
      p.password = Buffer.from(config.mqttPassword ?? "");
    } else if (p.cmd === "publish") return;
    else if (p.cmd === "subscribe" && p.subscriptions.some((s) => !s.topic.startsWith(`${config.topicRoot}/`))) {
      ws.send(mqttPacket.generate({ cmd: "suback", messageId: p.messageId, granted: p.subscriptions.map(() => 128) }));
      return;
    }
    const b = mqttPacket.generate(p);
    if (open) tcp.write(b);
    else early.push(b);
  });
  parser.on("error", close);
  ws.on("message", (data) => parser.parse(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
  tcp.on("data", (chunk) => {
    if (ws.bufferedAmount > 16e6) return close(); // a stalled browser tab reconnects instead of eating memory
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  ws.on("close", close);
  ws.on("error", close);
  tcp.on("close", close);
  tcp.on("error", close);
}

export function publish(path: string, payload: unknown, opts: { retain?: boolean; qos?: 0 | 1 } = {}) {
  const t = topic(path);
  const body = payload === null ? Buffer.alloc(0) : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (opts.retain) {
    published.add(t);
    if (body.length) retained.set(t, body);
    else retained.delete(t);
  }
  if (upstream) {
    if (upstream.connected) upstream.publish(t, body, { qos: opts.qos ?? 0, retain: opts.retain ?? false });
    return;
  }
  broker?.publish({ cmd: "publish", topic: t, payload: body, qos: opts.qos ?? 0, retain: opts.retain ?? false, dup: false } as Parameters<Aedes["publish"]>[0], () => {});
}
/** Remove a retained message (consumers receive an empty payload). */
export const clear = (path: string) => publish(path, null, { retain: true, qos: 1 });

/** The team broker keeps retained messages across restarts: remove ours that the current run no longer publishes. */
async function sweepStale() {
  const found = new Set<string>();
  const peek = mqtt.connect(config.mqttUrl, { username: config.mqttUsername, password: config.mqttPassword, clientId: `sbb-twin-sweep-${Math.random().toString(36).slice(2, 8)}`, reconnectPeriod: 0 });
  peek.on("error", () => {});
  peek.on("connect", () => peek.subscribe(`${config.topicRoot}/#`));
  peek.on("message", (t, p, packet) => packet.retain && p.length && found.add(t));
  await new Promise((r) => setTimeout(r, 5000));
  peek.end(true);
  // the twin republishes its whole state within seconds of starting; whatever is still unclaimed is stale
  setTimeout(() => {
    let n = 0;
    for (const t of found)
      if (!published.has(t) && !OPEN_NAMESPACES.some((ns) => t.startsWith(topic(ns))) && upstream?.connected) {
        upstream.publish(t, Buffer.alloc(0), { qos: 1, retain: true });
        n++;
      }
    if (n) console.log(`[sbb-twin] removed ${n} stale retained messages from an earlier run`);
  }, 60_000);
}
