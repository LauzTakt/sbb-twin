import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, ImageSource, Map as LibreMap } from "maplibre-gl";
import type { MqttClient } from "mqtt";
import { Activity, CloudSun, Crosshair, Layers, Link2, Pause, RefreshCcw, Siren, TrainFront, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, brokerUrl, connectFeed, watchTrain, type Disruption, type Event, type Incident, type Status, type TemperatureGrid, type WeatherSnapshot } from "./feed";
import { basemap, type Basemap } from "./map";
import { COLOURS, TrainCanvas } from "./trains";
import { gridImage, RAMP, rampColour, temperatureAt } from "./weatherLayer";

type FC = { type: "FeatureCollection"; features: { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };

(maplibregl as unknown as { setWorkerUrl?: (u: string) => void }).setWorkerUrl?.(workerUrl);

type DType = { id: string; label: string; reasonCode: string; effect: string; scope: "section" | "station" | "train"; defaultMinutes: number | null; params?: { maxKmh?: number; holdMinutes?: number }; behaviour: string };
type Station = { id: string; name: string; lon: number; lat: number };
type Pos = { trainId: string; ts: number; lat: number; lon: number; speedKmh: number; motion: string; delaySec: number; line: string; category: string; headsign: string; atStop: { name: string } | null; nextStop: { name: string; plannedArr: number; expectedArr: number } | null; track: string; edgeId: string | null };
type Call = { stopId: string; name: string; plannedArr: number | null; plannedDep: number | null; expectedArr: number | null; expectedDep: number | null; actualArr: number | null; actualDep: number | null; skipped: boolean };
type Info = { number: string | null; operator: string | null; status: string; origin: { name: string }; destination: { name: string }; calls: Call[] };

const hm = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "");
const hms = (ms: number) => new Date(ms).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich" });
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};
const lineColour = (cat: string) => (/^(IC|ICE|EC|IR|TGV|RJX|EN|NJ|ICN)$/.test(cat) ? "#eb0000" : cat === "EV" ? "#ff9f1c" : /^(RE|IRE)$/.test(cat) ? "#2d327d" : "#39424e");
const empty = { type: "FeatureCollection" as const, features: [] };

function StationPicker({ label, value, onChange }: { label: string; value?: Station; onChange: (s?: Station) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Station[]>([]);
  useEffect(() => {
    if (!q.trim() || value?.name === q) return setHits([]);
    const id = setTimeout(() => api<Station[]>(`/stations?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])), 150);
    return () => clearTimeout(id);
  }, [q, value]);
  return (
    <label className="field picker">
      <span>{label}</span>
      <input
        value={value?.name ?? q}
        placeholder="Search a station"
        onChange={(e) => {
          onChange(undefined);
          setQ(e.target.value);
        }}
      />
      {hits.length > 0 && (
        <ul>
          {hits.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(s);
                  setQ(s.name);
                  setHits([]);
                }}
              >
                {s.name} <small>{s.id}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | undefined>(undefined);
  const layer = useRef<TrainCanvas | undefined>(undefined);
  const client = useRef<MqttClient | undefined>(undefined);
  const [conn, setConn] = useState<"connecting" | "online" | "offline">("connecting");
  const [status, setStatus] = useState<Status>();
  const [disruptions, setDisruptions] = useState<Record<string, Disruption>>({});
  const [incidents, setIncidents] = useState<Record<string, Incident>>({});
  const [simulated, setSimulated] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<Event[]>([]);
  const [weather, setWeather] = useState<WeatherSnapshot>();
  const [grid, setGrid] = useState<TemperatureGrid>();
  const [style, setStyle] = useState<Basemap>("dark");
  const [showTemp, setShowTemp] = useState(false);
  const [showTrains, setShowTrains] = useState(true);
  const [tab, setTab] = useState<"provoke" | "incidents" | "events" | "connect">("provoke");
  const [selected, setSelected] = useState<string>();
  const [following, setFollowing] = useState(false);
  const [toast, setToast] = useState<string>();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const say = (t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? undefined : x)), 4000);
  };

  // ---- map + feed
  useEffect(() => {
    let alive = true;
    void (async () => {
      const m = new maplibregl.Map({ container: mapEl.current!, style: await basemap("dark"), center: [8.2, 46.8], zoom: 7.3, attributionControl: { compact: true }, maxPitch: 60 });
      if (!alive) return m.remove();
      mapRef.current = m;
      layer.current = new TrainCanvas(m);
      m.on("style.load", () => addOverlays(m));
      m.on("click", (e) => {
        const id = layer.current?.hit(e.point.x, e.point.y);
        setSelected(id);
        if (!id) setFollowing(false);
      });
      m.on("dragstart", () => setFollowing(false));
      client.current = connectFeed({
        connection: setConn,
        snapshot: (_ts, rows) => layer.current?.update(rows),
        status: setStatus,
        disruption: (id, d) => setDisruptions((x) => (d ? { ...x, [id]: d } : Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)))),
        incident: (id, i) => setIncidents((x) => (i ? { ...x, [id]: i } : Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)))),
        simulated: (id, on) =>
          setSimulated((x) => {
            const n = new Set(x);
            if (on) n.add(id);
            else n.delete(id);
            return n;
          }),
        event: (e) => setEvents((x) => [e, ...x].slice(0, 80)),
        weather: setWeather,
        grid: setGrid,
      });
    })();
    return () => {
      alive = false;
      client.current?.end(true);
      layer.current?.destroy();
      mapRef.current?.remove();
    };
  }, []);
  useEffect(() => {
    if (layer.current) layer.current.simulated = simulated;
  }, [simulated]);
  useEffect(() => {
    if (!layer.current) return;
    layer.current.selected = selected;
    layer.current.following = following && Boolean(selected);
    layer.current.visible = showTrains;
  }, [selected, following, showTrains]);

  // ---- overlays (re-added after every basemap change)
  const data = useRef({ disruptions: empty as FC, weather: empty as FC, grid: undefined as ReturnType<typeof gridImage> | undefined, temp: false });
  function addTemperature(m: LibreMap) {
    const d = data.current;
    if (!d.grid || m.getSource("temperature")) return;
    m.addSource("temperature", { type: "image", url: d.grid.url, coordinates: d.grid.coordinates });
    m.addLayer(
      { id: "temperature", type: "raster", source: "temperature", paint: { "raster-opacity": 0.6, "raster-resampling": "linear", "raster-fade-duration": 0 }, layout: { visibility: d.temp ? "visible" : "none" } },
      m.getLayer("network") ? "network" : undefined,
    );
  }
  function addOverlays(m: LibreMap) {
    const d = data.current;
    const dark = style !== "light";
    addTemperature(m);
    if (!m.getSource("network")) {
      m.addSource("network", { type: "geojson", data: "/api/network.geojson" });
      m.addLayer({ id: "network", type: "line", source: "network", paint: { "line-color": dark ? "#2f4262" : "#8a95a8", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 10, 1.4, 14, 2.5], "line-opacity": 0.9 } });
    }
    if (!m.getSource("disruptions")) {
      m.addSource("disruptions", { type: "geojson", data: d.disruptions as never });
      m.addLayer({ id: "disruption-glow", type: "line", source: "disruptions", filter: ["==", ["geometry-type"], "MultiLineString"], paint: { "line-color": ["get", "colour"], "line-width": 12, "line-opacity": 0.25, "line-blur": 4 } });
      m.addLayer({ id: "disruption-line", type: "line", source: "disruptions", filter: ["==", ["geometry-type"], "MultiLineString"], paint: { "line-color": ["get", "colour"], "line-width": 3.5, "line-dasharray": [2, 1.2] } });
      m.addLayer({ id: "disruption-point", type: "circle", source: "disruptions", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 3 } });
    }
    if (!m.getSource("weather")) {
      m.addSource("weather", { type: "geojson", data: d.weather as never });
      m.addLayer({ id: "weather-label", type: "symbol", source: "weather", layout: { visibility: d.temp ? "visible" : "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10.5, 10, 13], "text-font": ["Frutiger Neue Bold"], "text-allow-overlap": false, "text-padding": 6 }, paint: { "text-color": "#ffffff", "text-halo-color": "rgba(10,15,23,0.85)", "text-halo-width": 1.8 } });
    }
  }
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    void basemap(style).then((s) => m.setStyle(s, { diff: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);
  useEffect(() => {
    const features = [
      ...Object.values(disruptions)
        .filter((d) => d.status === "active" && d.geometry)
        .map((d) => ({ type: "Feature" as const, properties: { colour: "#ff4d5e" }, geometry: d.geometry as FC["features"][number]["geometry"] })),
      ...Object.values(incidents)
        .filter((i) => i.geometry)
        .map((i) => ({ type: "Feature" as const, properties: { colour: "#ffb020" }, geometry: i.geometry as FC["features"][number]["geometry"] })),
    ];
    data.current.disruptions = { type: "FeatureCollection", features };
    (mapRef.current?.getSource("disruptions") as GeoJSONSource | undefined)?.setData(data.current.disruptions as never);
  }, [disruptions, incidents]);
  useEffect(() => {
    if (!weather) return;
    data.current.weather = {
      type: "FeatureCollection",
      features: weather.stations
        .filter((s) => s[5] !== null)
        .map(([id, name, lat, lon, , t]) => ({ type: "Feature" as const, properties: { id, name, colour: rampColour(t!), label: `${t!.toFixed(1)}°` }, geometry: { type: "Point" as const, coordinates: [lon, lat] } })),
    };
    (mapRef.current?.getSource("weather") as GeoJSONSource | undefined)?.setData(data.current.weather as never);
  }, [weather]);
  useEffect(() => {
    if (!grid) return;
    data.current.grid = gridImage(grid);
    const m = mapRef.current;
    const src = m?.getSource("temperature") as ImageSource | undefined;
    if (src) src.updateImage({ url: data.current.grid.url, coordinates: data.current.grid.coordinates });
    else if (m) {
      try {
        addTemperature(m);
      } catch {
        m.once("idle", () => addTemperature(m));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);
  useEffect(() => {
    data.current.temp = showTemp;
    const m = mapRef.current;
    if (m && showTemp && !m.getSource("temperature")) addTemperature(m);
    for (const id of ["temperature", "weather-label"]) if (m?.getLayer(id)) m.setLayoutProperty(id, "visibility", showTemp ? "visible" : "none");
  }, [showTemp]);

  // ---- actions
  const syncAll = async () => {
    const r = await api<{ synced: string[] }>("/sync", { method: "POST", json: {} }).catch((e) => (say(e.message), null));
    if (r) say(r.synced.length ? `${r.synced.length} trains read the real data again` : "All trains already follow the real data");
  };
  const active = Object.values(disruptions).filter((d) => d.status === "active");
  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <TrainFront size={20} /> rail-twin
          <span className={`conn ${conn}`}>{conn === "online" ? "live" : conn}</span>
        </div>
        <div className="stats">
          <span className="clock">{hms(clock)}</span>
          <span>
            <b>{status?.trainsActive ?? "–"}</b> trains
          </span>
          <span className={simulated.size ? "warn" : ""}>
            <b>{simulated.size}</b> simulated
          </span>
          <span>
            <b>{active.length}</b> disruptions
          </span>
          <span title="Age of the official GTFS-RT predictions">RT {status?.realtime.feedAgeSec ?? "–"} s</span>
          {weather?.measuredAt && <span title="MeteoSwiss measurement time">weather {hm(weather.measuredAt)}</span>}
        </div>
        <div className="tools">
          <div className="seg" role="group" aria-label="Base map">
            {(["dark", "light", "satellite"] as const).map((b) => (
              <button key={b} aria-pressed={style === b} onClick={() => setStyle(b)}>
                {b}
              </button>
            ))}
          </div>
          <button className="toggle" aria-pressed={showTrains} onClick={() => setShowTrains((x) => !x)}>
            <Layers size={15} /> Trains
          </button>
          <button className="toggle" aria-pressed={showTemp} onClick={() => setShowTemp((x) => !x)}>
            <CloudSun size={15} /> Temperature
          </button>
          <button className="primary" onClick={() => void syncAll()} title="Every train reads the real data again">
            <RefreshCcw size={15} /> Sync all
          </button>
        </div>
      </header>
      <div ref={mapEl} className="map" />
      <aside className="side">
        <nav className="tabs">
          {(
            [
              ["provoke", "Provoke", Zap],
              ["incidents", "Incidents", Siren],
              ["events", "Events", Activity],
              ["connect", "Connect", Link2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        <div className="pane">
          {tab === "provoke" && <Provoke selected={selected} disruptions={Object.values(disruptions)} say={say} />}
          {tab === "incidents" && <Incidents incidents={Object.values(incidents)} say={say} />}
          {tab === "events" && <Events events={events} />}
          {tab === "connect" && <Connect />}
        </div>
      </aside>
      {selected && client.current && (
        <TrainCard
          key={selected}
          id={selected}
          client={client.current}
          simulated={simulated.has(selected)}
          mods={Object.values(disruptions).filter((d) => d.status === "active" && d.scope.kind === "train" && d.scope.trainId === selected)}
          following={following}
          grid={grid}
          onFollow={() => setFollowing((f) => !f)}
          onClose={() => {
            setSelected(undefined);
            setFollowing(false);
          }}
          say={say}
        />
      )}
      <div className="legend">
        {(
          [
            ["Moving", COLOURS.moving],
            ["Late ≥ 3 min", COLOURS.late],
            ["At a station", COLOURS.station],
            ["Stopped on the line", COLOURS.stoppedOnLine],
            ["Cancelled", COLOURS.cancelled],
          ] as const
        ).map(([l, c]) => (
          <span key={l}>
            <i style={{ background: c }} />
            {l}
          </span>
        ))}
        <span>
          <i className="ring" />
          Simulated (provoked)
        </span>
        {showTemp && (
          <div className="ramp">
            <div style={{ background: `linear-gradient(90deg, ${RAMP.map(([t, c]) => `${c} ${((t + 20) / 55) * 100}%`).join(",")})` }} />
            <small>
              <span>−20°</span>
              <span>0°</span>
              <span>15°</span>
              <span>35°</span>
            </small>
          </div>
        )}
      </div>
      {toast && <p className="toast">{toast}</p>}
    </div>
  );
}

function TrainCard({ id, client, simulated, mods, following, grid, onFollow, onClose, say }: { id: string; client: MqttClient; simulated: boolean; mods: Disruption[]; following: boolean; grid?: TemperatureGrid; onFollow: () => void; onClose: () => void; say: (t: string) => void }) {
  const [pos, setPos] = useState<Pos>();
  const [info, setInfo] = useState<Info>();
  const [maxKmh, setMaxKmh] = useState("60");
  const [hold, setHold] = useState("8");
  const stopped = mods.find((d) => d.effect === "train_breakdown");
  useEffect(() => watchTrain(client, id, (p) => setPos(p as unknown as Pos), (i) => setInfo(i as unknown as Info)), [client, id]);
  const provoke = async (type: string, params?: Record<string, number>) => {
    const r = await api<{ disruption: { label: string } }>("/disruptions", { method: "POST", json: { type, scope: { kind: "train", trainId: id }, params } }).catch((e) => (say(e.message), null));
    if (r) say(`${r.disruption.label}: provoked`);
  };
  const sync = async () => {
    const r = await api<{ synced: string[] }>("/sync", { method: "POST", json: { trainIds: [id] } }).catch((e) => (say(e.message), null));
    if (r) say(r.synced.length ? "Back on the real data" : "Already on the real data");
  };
  const temp = grid && pos ? temperatureAt(grid, pos.lon, pos.lat) : null;
  const passed = (c: Call) => c.actualDep !== null || (c.actualArr !== null && c.plannedDep === null);
  const upcoming = info?.calls.filter((c) => !passed(c)).slice(0, 6) ?? [];
  const late = (pos?.delaySec ?? 0) >= 60;
  return (
    <section className="card" aria-label="Train details">
      <header>
        <span className="badge" style={{ background: lineColour(pos?.category ?? "") }}>
          {pos?.line ?? "…"}
        </span>
        <div>
          <h2>{pos?.headsign ?? id}</h2>
          <small>
            {[info?.operator, info?.number ? `train ${info.number}` : null, info?.origin ? `from ${info.origin.name}` : null].filter(Boolean).join(" · ")}
          </small>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      {pos && (
        <div className="facts">
          <div>
            <b>{Math.round(pos.speedKmh)}</b>
            <small>km/h</small>
          </div>
          <div className={late ? "late" : ""}>
            <b>{pos.delaySec >= 0 ? "+" : "−"}{Math.floor(Math.abs(pos.delaySec) / 60)}:{String(Math.abs(pos.delaySec) % 60).padStart(2, "0")}</b>
            <small>delay</small>
          </div>
          <div>
            <b>{temp !== null ? `${temp.toFixed(1)}°` : "–"}</b>
            <small>outside</small>
          </div>
          <div>
            <b className="motion">{info?.status === "cancelled" ? "cancelled" : pos.motion === "moving" ? "moving" : pos.atStop ? "at station" : "stopped"}</b>
            <small>{pos.atStop ? pos.atStop.name : pos.nextStop ? `→ ${pos.nextStop.name}` : ""}</small>
          </div>
        </div>
      )}
      {simulated && <p className="sim">Simulated: a provoked disruption took this train over. Sync to read the real data again.</p>}
      <ol className="calls">
        {upcoming.map((c) => {
          const planned = c.plannedArr ?? c.plannedDep;
          const expected = c.expectedArr ?? c.expectedDep;
          const diff = planned && expected ? Math.round((expected - planned) / 60_000) : 0;
          return (
            <li key={c.stopId + planned} className={c.skipped ? "skipped" : ""}>
              <time>{hm(planned)}</time>
              <span>{c.name}</span>
              {diff > 0 ? <em className="late">+{diff}′</em> : <em />}
            </li>
          );
        })}
      </ol>
      <footer>
        <button aria-pressed={following} onClick={onFollow}>
          <Crosshair size={15} /> {following ? "Following" : "Follow"}
        </button>
        <button onClick={() => void sync()} disabled={!simulated && !mods.length} title="Drop every change: the train reads the real data again">
          <RefreshCcw size={15} /> Sync to real data
        </button>
      </footer>
      <div className="modify">
        <h3>Modify this train</h3>
        <div className="mod-row">
          {stopped ? (
            <button className="go" onClick={() => void api(`/disruptions/${stopped.id}/end`, { method: "POST", json: {} }).then(() => say("Train released: it continues, late"))}>
              Resume
            </button>
          ) : (
            <button className="stop" onClick={() => void provoke("rolling_stock_failure")}>
              <Pause size={14} /> Stop now
            </button>
          )}
          <button onClick={() => void provoke("skip_next_stop")}>Skip next stop</button>
          <button className="danger" onClick={() => void provoke("cancellation")}>
            Cancel train
          </button>
        </div>
        <div className="mod-row">
          <label>
            Max speed
            <input value={maxKmh} onChange={(e) => setMaxKmh(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /> km/h
          </label>
          <button disabled={!maxKmh} onClick={() => void provoke("train_speed_limit", { maxKmh: Number(maxKmh) })}>
            Apply
          </button>
        </div>
        <div className="mod-row">
          <label>
            Hold at next stop
            <input value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /> min
          </label>
          <button disabled={!hold} onClick={() => void provoke("technical_delay", { holdMinutes: Number(hold) })}>
            Apply
          </button>
        </div>
        {mods.length > 0 && (
          <ul className="mods">
            {mods.map((d) => (
              <li key={d.id}>
                <span>
                  {d.label}
                  {d.params?.maxKmh && d.effect === "train_speed" ? ` · ${d.params.maxKmh} km/h` : ""}
                  {d.params?.holdMinutes && d.effect === "train_delay" ? ` · ${d.params.holdMinutes} min` : ""}
                </span>
                <button onClick={() => void api(`/disruptions/${d.id}/end`, { method: "POST", json: {} })}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="track">{pos ? (pos.track === "bav" ? `On BAV track ${pos.edgeId ?? ""}` : "Approximate geometry (no BAV match)") : ""}</p>
    </section>
  );
}

function Provoke({ selected, disruptions, say }: { selected?: string; disruptions: Disruption[]; say: (t: string) => void }) {
  const [types, setTypes] = useState<DType[]>([]);
  const [typeId, setTypeId] = useState("overhead_line_fault");
  const [from, setFrom] = useState<Station>();
  const [to, setTo] = useState<Station>();
  const [station, setStation] = useState<Station>();
  const [minutes, setMinutes] = useState<string>("");
  const [maxKmh, setMaxKmh] = useState("40");
  const [hold, setHold] = useState("8");
  const [mark, setMark] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<DType[]>("/disruption-types").then(setTypes);
  }, []);
  const type = types.find((t) => t.id === typeId);
  useEffect(() => setMinutes(type?.defaultMinutes ? String(type.defaultMinutes) : ""), [type]);
  const ready = type && (type.scope === "section" ? from && to : type.scope === "station" ? station : selected);
  const submit = async () => {
    if (!type || !ready) return;
    setBusy(true);
    const scope = type.scope === "section" ? { kind: "section", from: from!.id, to: to!.id } : type.scope === "station" ? { kind: "station", station: station!.id } : { kind: "train", trainId: selected };
    const params = type.effect === "speed_restriction" ? { maxKmh: Number(maxKmh) } : type.effect === "train_delay" || type.effect === "signal_failure" ? { holdMinutes: Number(hold) } : undefined;
    const r = await api<{ disruption: { label: string; where: string } }>("/disruptions", { method: "POST", json: { type: type.id, scope, minutes: minutes ? Number(minutes) : null, params, mark } }).catch((e) => (say(e.message), null));
    setBusy(false);
    if (r) say(`${r.disruption.label} provoked: ${r.disruption.where}`);
  };
  const list = [...disruptions].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || b.startedAt - a.startedAt);
  return (
    <>
      <h3>Provoke a disruption</h3>
      <p className="hint">It really happens in the twin: trains brake, wait or slow down, and keep their own behaviour until synced.</p>
      <label className="field">
        <span>Type</span>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({t.reasonCode})
            </option>
          ))}
        </select>
      </label>
      {type && <p className="hint">{type.behaviour}</p>}
      {type?.scope === "section" && (
        <div className="row">
          <StationPicker label="From" value={from} onChange={setFrom} />
          <StationPicker label="To" value={to} onChange={setTo} />
        </div>
      )}
      {type?.scope === "station" && <StationPicker label="Station" value={station} onChange={setStation} />}
      {type?.scope === "train" && <p className="hint strong">{selected ? `Train: ${selected}` : "Click a train on the map to choose it."}</p>}
      <div className="row">
        <label className="field">
          <span>Duration (min)</span>
          <input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} placeholder="until ended" />
        </label>
        {type?.effect === "speed_restriction" && (
          <label className="field">
            <span>Max km/h</span>
            <input value={maxKmh} onChange={(e) => setMaxKmh(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
        {(type?.effect === "train_delay" || type?.effect === "signal_failure") && (
          <label className="field">
            <span>Hold (min)</span>
            <input value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} /> Also mark a public incident
      </label>
      <button className="primary wide" disabled={!ready || busy} onClick={() => void submit()}>
        <Zap size={15} /> Provoke
      </button>
      <h3>Disruptions</h3>
      {!list.length && <p className="hint">None yet.</p>}
      <ul className="items">
        {list.map((d) => (
          <li key={d.id} data-status={d.status}>
            <div>
              <b>{d.label}</b>
              <span>{d.where}</span>
              <small>
                {d.status === "active" ? `since ${hm(d.startedAt)}${d.endsAt ? ` · until ${hm(d.endsAt)}` : ""}` : `ended ${hm(d.endedAt)}`} · {d.affectedTrains.length} trains affected
              </small>
            </div>
            {d.status === "active" ? (
              <button onClick={() => void api(`/disruptions/${d.id}/end`, { method: "POST", json: {} }).then(() => say("Disruption ended: trains resume, still late until synced"))}>End</button>
            ) : (
              <button onClick={() => void api(`/disruptions/${d.id}`, { method: "DELETE" })}>Remove</button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Incidents({ incidents, say }: { incidents: Incident[]; say: (t: string) => void }) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("major");
  const [station, setStation] = useState<Station>();
  const [description, setDescription] = useState("");
  const submit = async () => {
    const r = await api("/incidents", { method: "POST", json: { title, severity, description, scope: station ? { kind: "station", station: station.id } : { kind: "network" } } }).catch((e) => (say(e.message), null));
    if (r) {
      setTitle("");
      setDescription("");
      say("Incident marked");
    }
  };
  return (
    <>
      <h3>Mark an incident</h3>
      <p className="hint">A public flag on the broker (rail/v1/incidents). It does not change any train.</p>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Signal fault at Olten" />
      </label>
      <div className="row">
        <label className="field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {["info", "minor", "major", "critical"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <StationPicker label="Where (optional)" value={station} onChange={setStation} />
      </div>
      <label className="field">
        <span>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <button className="primary wide" disabled={!title.trim()} onClick={() => void submit()}>
        <Siren size={15} /> Mark
      </button>
      <h3>Marked incidents</h3>
      {!incidents.length && <p className="hint">None.</p>}
      <ul className="items">
        {[...incidents]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((i) => (
            <li key={i.id} data-severity={i.severity}>
              <div>
                <b>{i.title}</b>
                <span>{i.where}</span>
                <small>
                  {i.severity} · {hm(i.createdAt)}
                  {i.disruptionId ? " · from a provoked disruption" : ""}
                </small>
              </div>
              <button onClick={() => void api(`/incidents/${i.id}`, { method: "DELETE" }).then(() => say("Incident unmarked"))}>Unmark</button>
            </li>
          ))}
      </ul>
    </>
  );
}

function Events({ events }: { events: Event[] }) {
  return (
    <>
      <h3>Events</h3>
      {!events.length && <p className="hint">Events appear here as they happen.</p>}
      <ol className="events">
        {events.map((e, i) => (
          <li key={`${e.ts}-${i}`}>
            <time>{hms(e.ts)}</time>
            <span>
              <b>{e.type}</b> {String(e.title ?? e.label ?? e.line ?? "")} {String(e.where ?? "")}
              {Array.isArray(e.trainIds) ? ` (${e.trainIds.length} trains)` : ""}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Connect() {
  const url = useMemo(brokerUrl, []);
  return (
    <>
      <h3>Read the feed</h3>
      <p className="hint">MQTT over WebSocket (anonymous, read-only). Full contract in the repository's docs.</p>
      <code className="block">{url}</code>
      <ul className="topics">
        {[
          ["rail/v1/fleet", "all trains, 1 message per second"],
          ["rail/v1/trains/+/position", "one train per message, every second"],
          ["rail/v1/trains/+/info", "line, operator, stops and times (retained)"],
          ["rail/v1/incidents/+", "marked incidents (retained)"],
          ["rail/v1/weather/temperature-grid", "temperature map (retained)"],
          ["rail/v1/weather/snapshot", "MeteoSwiss stations (retained)"],
          ["rail/v1/status", "heartbeat (retained)"],
          ["rail/v1/detections/{team}/{id}", "yours to publish"],
        ].map(([t, d]) => (
          <li key={t}>
            <code>{t}</code>
            <small>{d}</small>
          </li>
        ))}
      </ul>
      <code className="block">{`const c = mqtt.connect("${url}")\nc.on("connect", () => c.subscribe("rail/v1/fleet"))\nc.on("message", (_, b) => console.log(JSON.parse(b).trains.length))`}</code>
    </>
  );
}
