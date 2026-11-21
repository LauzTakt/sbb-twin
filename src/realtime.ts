// Live delays, skipped stops and cancellations from the official Swiss GTFS-RT feed (opentransportdata.swiss).
// The feed has no vehicle positions; the engine places trains on their tracks using these predictions.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { config } from "./config.ts";

const { transit_realtime: rt } = GtfsRealtimeBindings;
export type StopUpdate = { stopId?: string; seq?: number; arrDelay?: number; depDelay?: number; arrTime?: number; depTime?: number; skipped: boolean };
export type TripLive = { cancelled: boolean; updates: StopUpdate[] };

export const live = {
  trips: new Map<string, TripLive>(), // key "YYYYMMDD/<trip_id>" (same as the day index)
  fetchedAt: 0,
  feedTime: 0,
  error: undefined as string | undefined,
  enabled: () => Boolean(config.gtfsRtKey),
};
const num = (v: unknown) => (v == null ? undefined : Number(String(v)));
// Stops come as Swiss Location IDs ("ch:1:sloid:10665:0:19728" = quay 19728 of service point 10665 = station 8510665)
// or, rarely, as numeric station ids ("8503000", "8503000:0:5", "Parent8503000").
export function station(stopId: string) {
  const sloid = stopId.match(/^ch:1:sloid:(\d+)/);
  if (sloid) return `85${sloid[1].padStart(5, "0")}`;
  return stopId.replace(/^Parent/, "").split(":")[0];
}

export async function pollRealtime() {
  if (!config.gtfsRtKey) return false;
  try {
    const r = await fetch(config.gtfsRtUrl, {
      headers: { Authorization: `Bearer ${config.gtfsRtKey}`, "User-Agent": "rail-twin (LauzHack 2026)", "Accept-Encoding": "gzip, deflate" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      live.error = `GTFS-RT HTTP ${r.status}`;
      return false;
    }
    const feed = rt.FeedMessage.decode(new Uint8Array(await r.arrayBuffer()));
    const trips = new Map<string, TripLive>();
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      const id = tu?.trip?.tripId;
      if (!tu || !id) continue;
      trips.set(`${tu.trip?.startDate ?? ""}/${id}`, {
        cancelled: tu.trip?.scheduleRelationship === rt.TripDescriptor.ScheduleRelationship.CANCELED,
        updates: (tu.stopTimeUpdate ?? []).map((u) => ({
          stopId: u.stopId ? station(u.stopId) : undefined,
          seq: u.stopSequence ?? undefined,
          arrDelay: num(u.arrival?.delay),
          depDelay: num(u.departure?.delay),
          arrTime: num(u.arrival?.time),
          depTime: num(u.departure?.time),
          skipped: u.scheduleRelationship === rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
        })),
      });
    }
    live.trips = trips;
    live.fetchedAt = Date.now();
    live.feedTime = (num(feed.header?.timestamp) ?? 0) * 1000;
    live.error = undefined;
    return true;
  } catch (err) {
    live.error = (err as Error).message;
    return false;
  }
}
