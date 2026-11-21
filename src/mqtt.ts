// Embedded MQTT broker (Aedes): TCP on MQTT_PORT and MQTT over WebSocket at /mqtt on the HTTP port.
// Only sbb-twin publishes under the root, except the namespaces reserved for other teams.
import { createServer } from "node:net";
import type { Server as HttpServer } from "node:http";
import { Aedes } from "aedes";
import { WebSocketServer, createWebSocketStream } from "ws";
import { config } from "./config.ts";

export const topic = (path: string) => `${config.topicRoot}/${path}`;
export const OPEN_NAMESPACES = ["detections/", "ext/"];
let broker: Aedes | undefined;
export const brokerStats = { clients: 0 };

export async function startBroker(http: HttpServer) {
  // ~1,000-2,000 position messages per second: allow many in flight, and never let one frozen subscriber stall the rest.
  broker = await Aedes.createBroker({ id: "sbb-twin", concurrency: 5000, drainTimeout: 10_000, queueLimit: 5000, heartbeatInterval: 30_000 });
  broker.authorizePublish = (client, packet, done) => {
    if (!client) return done(null); // sbb-twin itself
    const t = packet.topic;
    if (OPEN_NAMESPACES.some((ns) => t.startsWith(topic(ns))) || !t.startsWith(`${config.topicRoot}/`)) return done(null);
    done(new Error(`${t} is read-only: other teams may publish under ${topic("detections/")} or ${topic("ext/")}`));
  };
  broker.on("client", () => (brokerStats.clients = broker!.connectedClients));
  broker.on("clientDisconnect", () => (brokerStats.clients = broker!.connectedClients));
  const tcp = createServer((socket) => broker!.handle(socket));
  await new Promise<void>((ok) => tcp.listen(config.mqttPort, config.host === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0", ok));
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("mqtt") ? "mqtt" : protocols.has("mqttv3.1") ? "mqttv3.1" : false),
  });
  http.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/mqtt")) return; // other upgrades (e.g. Vite HMR) handle themselves
    wss.handleUpgrade(req, socket, head, (ws) => broker!.handle(createWebSocketStream(ws), req));
  });
}

export function publish(path: string, payload: unknown, opts: { retain?: boolean; qos?: 0 | 1 } = {}) {
  if (!broker) return;
  const body = payload === null ? Buffer.alloc(0) : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  broker.publish(
    { cmd: "publish", topic: topic(path), payload: body, qos: opts.qos ?? 0, retain: opts.retain ?? false, dup: false } as Parameters<Aedes["publish"]>[0],
    () => {},
  );
}
/** Remove a retained message (consumers receive an empty payload). */
export const clear = (path: string) => publish(path, null, { retain: true, qos: 1 });
