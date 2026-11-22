import { Hono } from "hono";
import { alertsState } from "../alerts.ts";
import { byTrainId, delayOf, expectedArrival, neighbours, nextCall, servedStations, stationBoard, trains, tripMeta } from "../engine.ts";
import { infoPayload, positionPayload } from "../feed.ts";
import { abroadGeoJson, networkGeoJson } from "../geometry.ts";
import { searchStations, stationIndex } from "../timetable.ts";

export function createNetworkRoutes() {
  const app = new Hono();
  app.get("/trains", (c) => {
    const t = Date.now();
    return c.json([...trains.values()].map((tr) => positionPayload(tr, t)));
  });
  app.get("/trains/:id", (c) => {
    const tr = byTrainId.get(c.req.param("id"));
    if (!tr) return c.json({ error: "Train not in service" }, 404);
    const t = Date.now();
    return c.json({ position: positionPayload(tr, t), info: infoPayload(tr, t), truth: { mode: tr.mode === "sim" ? "simulated" : "real", causes: [...tr.causes] } });
  });
  app.get("/stations", (c) => c.json(searchStations(c.req.query("q") ?? "", 10)));
  // the console's search box: stations, lines in service, and trains by public number, line or destination
  let served: { at: number; counts: Map<string, number> } | undefined;
  const fold = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  app.get("/search", (c) => {
    const raw = (c.req.query("q") ?? "").trim().slice(0, 80);
    if (!raw) return c.json({ stations: [], lines: [], trains: [] });
    const t = Date.now();
    if (!served || t - served.at > 600_000) served = { at: t, counts: new Map(servedStations().map((x) => [x.id, x.trains])) };
    const counts = served.counts;
    const q = fold(raw);
    const qn = q.replace(/\s+/g, "");
    const stations = searchStations(raw, 6).map((station) => ({ ...station, trains: counts.get(station.id) ?? 0 }));
    const lines = new Map<string, { line: string; category: string; trains: number }>();
    const found: { trainId: string; line: string; category: string; number: string | null; headsign: string; delaySec: number; lat: number; lon: number; score: number }[] = [];
    for (const tr of trains.values()) {
      if (tr.cancelled) continue;
      const line = String(tr.trip.line ?? "");
      const ln = fold(line).replace(/\s+/g, "");
      const number = tripMeta(tr.trip.tripId)?.[0] ?? null;
      const lineHit = ln !== "" && (ln === qn || (qn.length >= 2 && ln.startsWith(qn)));
      if (lineHit) {
        const e = lines.get(line) ?? { line, category: tr.trip.cat, trains: 0 };
        e.trains++;
        lines.set(line, e);
      }
      const numHit = !!number && (number === qn || `${ln}${number}` === qn || (/^\d{2,}$/.test(qn) && number.startsWith(qn)));
      const headHit = q.length >= 3 && fold(String(tr.trip.head ?? "")).includes(q);
      if (numHit || headHit || lineHit)
        found.push({ trainId: tr.trip.trainId, line, category: tr.trip.cat, number, headsign: String(tr.trip.head ?? ""), delaySec: Math.round(delayOf(tr, t)), lat: tr.lat, lon: tr.lon, score: numHit ? 0 : headHit ? 1 : 2 });
    }
    found.sort((a, b) => a.score - b.score || a.line.localeCompare(b.line, "en", { numeric: true }) || (a.number ?? "").localeCompare(b.number ?? "", "en", { numeric: true }));
    return c.json({
      stations,
      lines: [...lines.values()].sort((a, b) => (fold(a.line) === qn ? -1 : 0) - (fold(b.line) === qn ? -1 : 0) || b.trains - a.trains).slice(0, 5),
      trains: found.slice(0, 8).map(({ score, ...x }) => x),
    });
  });
  app.get("/stations.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=600");
    return c.json({ type: "FeatureCollection", features: servedStations().map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name, trains: s.trains }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) });
  });
  app.get("/stations/:id/board", (c) => {
    const i = stationIndex(c.req.param("id"));
    if (i === undefined) return c.json({ error: "Unknown station" }, 404);
    return c.json(stationBoard(i, Date.now()));
  });
  // the trains on their way to a station, nearest first: for a live "your train is arriving" view
  app.get("/stations/:id/arrivals", (c) => {
    const i = stationIndex(c.req.param("id"));
    if (i === undefined) return c.json({ error: "Unknown station" }, 404);
    const t = Date.now();
    const rows = [];
    for (const tr of trains.values()) {
      if (tr.cancelled) continue;
      const n = nextCall(tr);
      for (let k = tr.leg < 0 ? tr.call : n; k < tr.trip.stops.length; k++) {
        if (tr.trip.stops[k] !== i || tr.skipped[k]) continue;
        const atStation = tr.leg < 0 && tr.call === k;
        const eta = atStation ? t : expectedArrival(tr, k, t);
        if (eta - t < -90_000 || eta - t > 90 * 60_000) break;
        rows.push({
          trainId: tr.trip.trainId, line: tr.trip.line, category: tr.trip.cat, headsign: tr.trip.head,
          plannedArr: tr.trip.arr[k], expectedArr: Math.round(eta), etaSec: Math.max(0, Math.round((eta - t) / 1000)), delaySec: delayOf(tr, t),
          stopsAway: Math.max(0, k - n + (tr.leg >= 0 ? 0 : 1)), status: atStation ? "at_station" : "approaching",
          lat: Math.round(tr.lat * 1e6) / 1e6, lon: Math.round(tr.lon * 1e6) / 1e6, speedKmh: Math.round(tr.speed * 3.6),
        });
        break;
      }
    }
    rows.sort((a, b) => a.etaSec - b.etaSec);
    return c.json(rows.slice(0, 12));
  });
  app.get("/stations/:id/neighbours", (c) => {
    const i = stationIndex(c.req.param("id"));
    if (i === undefined) return c.json({ error: "Unknown station" }, 404);
    return c.json(neighbours(i, Math.min(80, Number(c.req.query("km") ?? 40))));
  });
  app.get("/abroad.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=3600");
    return c.body(abroadGeoJson());
  });
  app.get("/network.geojson", (c) => {
    c.header("content-type", "application/geo+json");
    c.header("cache-control", "public, max-age=3600");
    return c.body(networkGeoJson());
  });

  app.get("/alerts", (c) => c.json([...alertsState.alerts.values()]));
  return app;
}
