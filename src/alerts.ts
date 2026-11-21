// Real service alerts from opentransportdata.swiss (GTFS-RT Service Alerts, the consolidated Swiss feed, ~1,500
// alerts for every mode). The ones that touch the railway (a train of today's timetable, a served rail station, or a
// "[train]" line) are placed on the network and published as alerts/{id}. They describe the real world; the trains
// already follow it through GTFS-RT, so nothing here changes the simulation, and Sync all leaves them alone.
import { createHash } from "node:crypto";
import protobuf from "protobufjs";
import { config } from "./config.ts";
import { station } from "./realtime.ts";
import { stationIndex, stops } from "./timetable.ts";
import { edgesGeometry, sectionEdges } from "./geometry.ts";
import { dayTrips, servedStations } from "./engine.ts";
import { clear, publish } from "./mqtt.ts";
import * as channel from "./channel.ts";

// Only what an alert needs. The Swiss feed carries trip fields the official bindings misread, so unknown fields are
// skipped instead of decoded.
const root = protobuf.Root.fromJSON({
  nested: {
    FeedMessage: { fields: { header: { type: "FeedHeader", id: 1 }, entity: { rule: "repeated", type: "FeedEntity", id: 2 } } },
    FeedHeader: { fields: { timestamp: { type: "uint64", id: 3 } } },
    FeedEntity: { fields: { id: { type: "string", id: 1 }, isDeleted: { type: "bool", id: 2 }, alert: { type: "Alert", id: 5 } } },
    Alert: {
      fields: {
        activePeriod: { rule: "repeated", type: "TimeRange", id: 1 },
        informedEntity: { rule: "repeated", type: "EntitySelector", id: 5 },
        cause: { type: "int32", id: 6 },
        url: { type: "TranslatedString", id: 8 },
        headerText: { type: "TranslatedString", id: 10 },
        descriptionText: { type: "TranslatedString", id: 11 },
      },
    },
    TimeRange: { fields: { start: { type: "uint64", id: 1 }, end: { type: "uint64", id: 2 } } },
    EntitySelector: { fields: { agencyId: { type: "string", id: 1 }, routeId: { type: "string", id: 2 }, trip: { type: "TripDescriptor", id: 4 }, stopId: { type: "string", id: 5 } } },
    TripDescriptor: { fields: { tripId: { type: "string", id: 1 }, startDate: { type: "string", id: 3 } } },
    TranslatedString: { fields: { translation: { rule: "repeated", type: "Translation", id: 1 } } },
    Translation: { fields: { text: { type: "string", id: 1 }, language: { type: "string", id: 2 } } },
  },
});
const FeedMessage = root.lookupType("FeedMessage");
type Translated = { translation?: { text?: string; language?: string }[] };
type Feed = {
  header: { timestamp?: number };
  entity?: { id: string; isDeleted?: boolean; alert?: { activePeriod?: { start?: number; end?: number }[]; informedEntity?: { stopId?: string; trip?: { tripId?: string; startDate?: string } }[]; cause?: number; url?: Translated; headerText?: Translated; descriptionText?: Translated } }[];
};
type Geometry = ReturnType<typeof edgesGeometry> | { type: "MultiPoint"; coordinates: number[][] };

export type RealAlert = {
  v: 1;
  id: string;
  source: string;
  title: string;
  description: string;
  language: string;
  cause: string;
  severity: "info" | "minor" | "major";
  url: string | null;
  activePeriods: { start: number | null; end: number | null }[];
  stations: { id: string; name: string }[];
  trainIds: string[];
  geometry: Geometry | null;
  sourceIds: string[]; // the feed often repeats one event per operator or route: merged here
  updatedAt: number;
};
export const alertsState = { alerts: new Map<string, RealAlert>(), fetchedAt: 0, feedAt: 0, error: undefined as string | undefined };

const CAUSES = ["unknown", "unknown", "other", "technical problem", "strike", "demonstration", "accident", "holiday", "weather", "maintenance", "construction", "police activity", "medical emergency"];
const SOURCE = "opentransportdata.swiss GTFS-RT service alerts";
function text(t?: Translated) {
  const all = t?.translation ?? [];
  const pick = all.find((x) => x.language === "en") ?? all.find((x) => x.language === "de") ?? all[0];
  return { text: (pick?.text ?? "").trim(), language: pick?.language ?? "" };
}
function severityOf(s: string): RealAlert["severity"] {
  if (/wheelchair|lift|elevator|escalator|toilet|ticket machine|step-free|accessib/i.test(s)) return "info";
  if (/interrupt|no (train )?service|not running|cancel|suspended|blocked|closed between/i.test(s)) return "major";
  if (/limited|irregular|delay|divert|diversion|replacement|reduced|restriction|disrupt|works/i.test(s)) return "minor";
  return "info";
}

export async function pollAlerts() {
  if (!config.gtfsSaKey) return;
  try {
    const r = await fetch(config.gtfsSaUrl, { headers: { Authorization: `Bearer ${config.gtfsSaKey}`, "User-Agent": "sbb-twin" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const feed = FeedMessage.toObject(FeedMessage.decode(new Uint8Array(await r.arrayBuffer())), { longs: Number }) as Feed;
    apply(build(feed));
    alertsState.fetchedAt = Date.now();
    alertsState.feedAt = (feed.header.timestamp ?? 0) * 1000;
    alertsState.error = undefined;
  } catch (err) {
    alertsState.error = (err as Error).message;
    console.warn("[alerts] service alerts unavailable:", alertsState.error);
  }
}

function build(feed: Feed) {
  const now = Date.now();
  const served = new Map(servedStations().map((s) => [s.id, s]));
  const byName = new Map([...served.values()].map((s) => [s.name.toLowerCase(), s]));
  const named = (n: string) => byName.get(n.trim().toLowerCase()) ?? byName.get(n.replace(/\s*\((?:F|D|I|A|FL)\)\s*$/i, "").trim().toLowerCase());
  const today = new Set(dayTrips().map((t) => t.trainId));
  const out = new Map<string, RealAlert>();
  for (const e of feed.entity ?? []) {
    const a = e.alert;
    if (!a || e.isDeleted) continue;
    const periods = (a.activePeriod ?? []).map((p) => ({ start: p.start ? p.start * 1000 : null, end: p.end ? p.end * 1000 : null }));
    if (periods.length && !periods.some((p) => (p.start ?? 0) <= now && (p.end ?? Infinity) >= now)) continue;
    const head = text(a.headerText);
    const body = text(a.descriptionText);
    // a line tagged with another mode ("[bus]", "[tram]", "[boat]", "[gondola-lift]") is not ours
    const mode = head.text.match(/\[([^\]]+)\]\s*\.?\s*$/)?.[1]?.toLowerCase();
    const railMode = mode === "train" || mode === "rack railway";
    if (mode && !railMode) continue;
    const stationIds = new Set<string>();
    const trainIds = new Set<string>();
    for (const ie of a.informedEntity ?? []) {
      if (ie.stopId) {
        const id = station(ie.stopId);
        if (served.has(id)) stationIds.add(id);
      }
      if (ie.trip?.tripId && ie.trip.startDate) {
        const id = `${ie.trip.startDate}_${ie.trip.tripId.replace(/^\./, "")}`;
        if (today.has(id)) trainIds.add(id);
      }
    }
    if (!stationIds.size && !trainIds.size && !railMode) continue;
    // where: "between A and B" is the track between them; otherwise the stations it names
    let geometry: Geometry | null = null;
    const plain = head.text.replace(/\s*\[[^\]]+\]\s*\.?\s*$/, "").replace(/\.\s*$/, "");
    let from: ReturnType<typeof named>;
    let to: ReturnType<typeof named>;
    for (const re of [/between (.+?) and (.+?)(?:,|$)/i, /:\s*(.+?)\s+[-–]\s+(.+?)\s*$/, /(?:service|works|closure|interruption)\s+(.+?)\s+[-–]\s+(.+?)\s*$/i]) {
      const m = plain.match(re);
      if (m && named(m[1]) && named(m[2])) {
        from = named(m[1]);
        to = named(m[2]);
        break;
      }
    }
    if (from && to) {
      const ia = stationIndex(from.id);
      const ib = stationIndex(to.id);
      if (ia !== undefined && ib !== undefined) {
        const edges = sectionEdges(stops[ia], stops[ib]);
        if (edges.size) geometry = edgesGeometry(edges);
        stationIds.add(from.id);
        stationIds.add(to.id);
      }
    }
    if (!geometry && stationIds.size) geometry = { type: "MultiPoint", coordinates: [...stationIds].map((id) => [served.get(id)!.lon, served.get(id)!.lat]) };
    const title = head.text.replace(/\s*\[(train|rack railway)\]\s*\.?\s*$/i, "").trim() || "Service information";
    // one event, many alerts (per operator, route or stop list): merge by title
    const key = title.toLowerCase().replace(/[:\-–]/g, " ").replace(/\s+/g, " ").trim();
    const id = `sa-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
    const same = out.get(id);
    if (same) {
      for (const s of stationIds) if (!same.stations.some((x) => x.id === s)) same.stations.push({ id: s, name: served.get(s)!.name });
      for (const t of trainIds) if (!same.trainIds.includes(t)) same.trainIds.push(t);
      if (geometry?.type === "MultiLineString" || (!same.geometry && geometry)) same.geometry = geometry;
      else if (same.geometry?.type === "MultiPoint") same.geometry = { type: "MultiPoint", coordinates: same.stations.map((s) => [served.get(s.id)!.lon, served.get(s.id)!.lat]) };
      if (!same.description && body.text) same.description = body.text;
      same.sourceIds.push(e.id);
      continue;
    }
    out.set(id, {
      v: 1,
      id,
      source: SOURCE,
      title,
      description: body.text,
      language: head.language,
      cause: CAUSES[a.cause ?? 1] ?? "unknown",
      severity: severityOf(`${head.text} ${body.text.slice(0, 200)}`),
      url: text(a.url).text || null,
      activePeriods: periods,
      stations: [...stationIds].map((id) => ({ id, name: served.get(id)!.name })),
      trainIds: [...trainIds],
      geometry,
      sourceIds: [e.id],
      updatedAt: now,
    });
  }
  return out;
}

const sig = (a: RealAlert) => JSON.stringify({ ...a, sourceIds: [...a.sourceIds].sort(), trainIds: [...a.trainIds].sort(), updatedAt: 0 });
function apply(next: Map<string, RealAlert>) {
  const before = alertsState.alerts;
  for (const [id, a] of next) {
    const old = before.get(id);
    if (old && sig(old) === sig(a)) next.set(id, old);
    else publish(`alerts/${id}`, a, { retain: true, qos: 1 });
  }
  for (const id of before.keys()) if (!next.has(id)) clear(`alerts/${id}`);
  alertsState.alerts = next;
  sendAlerts();
}
/** What the control page needs (the affected trains as a count). */
export function sendAlerts() {
  const list = [...alertsState.alerts.values()].map(({ trainIds, sourceIds, ...a }) => ({ ...a, trains: trainIds.length }));
  channel.send("alerts", { type: "alerts", fetchedAt: alertsState.fetchedAt, alerts: list });
}
