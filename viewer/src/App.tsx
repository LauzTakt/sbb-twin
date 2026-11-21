import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, ImageSource, Map as LibreMap } from "maplibre-gl";
import type { MqttClient } from "mqtt";
import { Activity, CloudSun, Crosshair, Layers, Link2, Moon, Pause, RefreshCcw, ShieldCheck, ShieldOff, Siren, Sun, TrainFront, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, brokerUrl, connectFeed, watchTrain, type Disruption, type Event, type Incident, type Status, type TemperatureGrid, type WeatherOverride, type WeatherSnapshot } from "./feed";
import { applyBase, baseStyle, type Theme } from "./map";
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

function StationPicker({ label, value, onChange, options }: { label: string; value?: Station; onChange: (s?: Station) => void; options?: (Station & { km?: number })[] }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<(Station & { km?: number })[]>([]);
  const [open, setOpen] = useState(false);
  const norm = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  useEffect(() => {
    if (options) {
      // only stations a train reaches from the other end: filter the list as the user types
      if (!open || value) return setHits([]);
      setHits(options.filter((s) => norm(s.name).includes(norm(q.trim()))).slice(0, 12));
      return;
    }
    if (!q.trim() || value?.name === q) return setHits([]);
    const id = setTimeout(() => api<Station[]>(`/stations?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])), 150);
    return () => clearTimeout(id);
  }, [q, value, options, open]);
  return (
    <label className="field picker">
      <span>{label}</span>
      <input
        value={value?.name ?? q}
        placeholder={options ? "Choose a connected station" : "Search a station"}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
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
                {s.name} <small>{s.km !== undefined ? `${s.km} km` : s.id}</small>
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
  // the whole page is light or dark; the map is either the drawn map or satellite imagery
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem("rail-twin-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [satellite, setSatellite] = useState(false);
  const look = useRef({ theme, satellite });
  const [overrides, setOverrides] = useState<Record<string, WeatherOverride>>({});
  const [protection, setProtection] = useState(true);
  const placing = useRef<Record<string, unknown> | undefined>(undefined);
  const [placingLabel, setPlacingLabel] = useState<string>();
  const [showTemp, setShowTemp] = useState(false);
  const [showTrains, setShowTrains] = useState(true);
  const [tab, setTab] = useState<"god" | "incidents" | "events" | "connect">("god");
  // ?train=<trainId> opens the app on that train, following it
  const [selected, setSelected] = useState<string | undefined>(() => new URLSearchParams(location.search).get("train") ?? undefined);
  const [following, setFollowing] = useState(() => new URLSearchParams(location.search).has("train"));
  const [toast, setToast] = useState<string>();
  const [ready, setReady] = useState(false);
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
      // locked to Switzerland: zoom freely, never leave these bounds (they match the temperature map)
      const m = new maplibregl.Map({ container: mapEl.current!, style: await baseStyle(), center: [8.2, 46.8], zoom: 7.3, attributionControl: { compact: true }, maxPitch: 60, maxBounds: [[5.4, 45.55], [11.0, 48.05]], renderWorldCopies: false });
      if (!alive) return m.remove();
      mapRef.current = m;
      (window as unknown as { railMap?: LibreMap }).railMap = m; // handy for debugging in the console
      layer.current = new TrainCanvas(m);
      setReady(true);
      m.on("load", () => {
        addOverlays(m);
        restyle(m);
      });
      m.on("click", (e) => {
        if (placing.current) {
          // god mode: put the prepared weather change where the map was clicked
          const body = { ...placing.current, lat: e.lngLat.lat, lon: e.lngLat.lng };
          placing.current = undefined;
          setPlacingLabel(undefined);
          m.getCanvas().style.cursor = "";
          void api<{ override: WeatherOverride; consequences: { label: string }[] }>("/weather/overrides", { method: "POST", json: body })
            .then((r) => say(`${r.override.label} placed${r.consequences.length ? ` · ${r.consequences.map((c) => c.label).join(", ")}` : ""}`))
            .catch((err) => say(err.message));
          return;
        }
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
        override: (id, o) => setOverrides((x) => (o ? { ...x, [id]: o } : Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)))),
        settings: (s) => setProtection(s.protection),
      });
      void api<{ protection: boolean }>("/god").then((g) => setProtection(g.protection)).catch(() => {});
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
    layer.current.theme = look.current.theme === "light" && !look.current.satellite ? "light" : "dark";
  }, [selected, following, showTrains, ready]);

  // ---- overlays (added once; the base map never reloads)
  const data = useRef({ disruptions: empty as FC, weather: empty as FC, areas: empty as FC, grid: undefined as ReturnType<typeof gridImage> | undefined, temp: false });
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
    // railways abroad (OpenStreetMap via OpenFreeMap), under the Swiss BAV network
    if (!m.getSource("osm")) {
      m.addSource("osm", { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "© OpenStreetMap contributors" });
      m.addLayer({ id: "rail-abroad", type: "line", source: "osm", "source-layer": "transportation", filter: ["all", ["==", ["get", "class"], "rail"], ["!", ["has", "service"]], ["!", ["in", ["get", "subclass"], ["literal", ["subway", "tram", "light_rail", "funicular"]]]]], paint: { "line-color": "#686868", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 10, 1.3, 14, 2.4], "line-opacity": 0.6 } });
    }
    addTemperature(m);
    if (!m.getSource("network")) {
      m.addSource("network", { type: "geojson", data: "/api/network.geojson" });
      m.addLayer({ id: "network", type: "line", source: "network", paint: { "line-color": "#686868", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.7, 10, 1.5, 14, 2.6], "line-opacity": 0.75 } });
    }
    if (!m.getSource("areas")) {
      m.addSource("areas", { type: "geojson", data: d.areas as never });
      m.addLayer({ id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": ["get", "colour"], "fill-opacity": 0.14 } });
      m.addLayer({ id: "area-line", type: "line", source: "areas", paint: { "line-color": ["get", "colour"], "line-width": 2, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "area-label", type: "symbol", source: "areas", layout: { "text-field": ["get", "label"], "text-size": 13, "text-font": ["Frutiger Neue Bold"], "symbol-placement": "point" }, paint: { "text-color": ["get", "colour"], "text-halo-color": "#ffffff", "text-halo-width": 2 } });
    }
    if (!m.getSource("disruptions")) {
      m.addSource("disruptions", { type: "geojson", data: d.disruptions as never });
      m.addLayer({ id: "disruption-glow", type: "line", source: "disruptions", filter: ["==", ["geometry-type"], "MultiLineString"], paint: { "line-color": ["get", "colour"], "line-width": 12, "line-opacity": 0.25, "line-blur": 4 } });
      m.addLayer({ id: "disruption-line", type: "line", source: "disruptions", filter: ["==", ["geometry-type"], "MultiLineString"], paint: { "line-color": ["get", "colour"], "line-width": 3.5, "line-dasharray": [2, 1.2] } });
      m.addLayer({ id: "disruption-point", type: "circle", source: "disruptions", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 3 } });
    }
    if (!m.getSource("weather")) {
      m.addSource("weather", { type: "geojson", data: d.weather as never });
      m.addLayer({ id: "weather-label", type: "symbol", source: "weather", layout: { visibility: d.temp ? "visible" : "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 10, 13.5], "text-font": ["Frutiger Neue Bold"], "text-allow-overlap": false, "text-padding": 6 }, paint: { "text-color": "#212121", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 2 } });
    }
  }
  /** Light/dark page and map, or satellite: recolour in place (no reload). */
  function restyle(m: LibreMap) {
    const { theme: th, satellite: sat } = look.current;
    applyBase(m, th, sat);
    const rail = sat ? "#ffffff" : th === "dark" ? "#53647f" : "#686868";
    if (m.getLayer("network")) {
      m.setPaintProperty("network", "line-color", rail);
      m.setPaintProperty("network", "line-opacity", sat ? 0.6 : 0.75);
    }
    if (m.getLayer("rail-abroad")) m.setPaintProperty("rail-abroad", "line-color", rail);
    const dark = th === "dark" || sat;
    if (m.getLayer("weather-label")) {
      m.setPaintProperty("weather-label", "text-color", dark ? "#ffffff" : "#212121");
      m.setPaintProperty("weather-label", "text-halo-color", dark ? "rgba(16,20,24,0.9)" : "rgba(255,255,255,0.92)");
    }
    if (m.getLayer("area-label")) m.setPaintProperty("area-label", "text-halo-color", dark ? "#101418" : "#ffffff");
    if (layer.current) layer.current.theme = dark ? "dark" : "light";
  }
  useEffect(() => {
    look.current = { theme, satellite };
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("rail-twin-theme", theme);
    } catch {
      /* private mode */
    }
    const m = mapRef.current;
    if (m?.isStyleLoaded()) restyle(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, satellite]);
  useEffect(() => {
    // weather changes drawn as soft circles
    const circle = (o: WeatherOverride) => {
      const pts: number[][] = [];
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * 2 * Math.PI;
        pts.push([o.lon + ((o.radiusKm / (111.32 * Math.cos((o.lat * Math.PI) / 180))) * Math.cos(a)), o.lat + (o.radiusKm / 111.32) * Math.sin(a)]);
      }
      return pts;
    };
    const describe = (o: WeatherOverride) =>
      [o.tempC !== undefined ? `${o.tempC}°` : o.tempDeltaC !== undefined ? `${o.tempDeltaC > 0 ? "+" : ""}${o.tempDeltaC}°` : "", o.gustKmh ? `${o.gustKmh} km/h` : "", o.precipMm ? `${o.precipMm} mm` : ""].filter(Boolean).join(" · ");
    const colour = (o: WeatherOverride) => ((o.tempC ?? 0) >= 25 || (o.tempDeltaC ?? 0) > 0 ? "#eb0000" : (o.tempC ?? 99) <= 0 || (o.tempDeltaC ?? 0) < 0 ? "#0079c7" : "#2d327d");
    const list = Object.values(overrides).filter((o) => o.status === "active");
    data.current.areas = {
      type: "FeatureCollection",
      features: list.flatMap((o) => [
        { type: "Feature" as const, properties: { colour: colour(o), label: "" }, geometry: { type: "Polygon", coordinates: [circle(o)] } },
        { type: "Feature" as const, properties: { colour: colour(o), label: `${o.label}\n${describe(o)}` }, geometry: { type: "Point", coordinates: [o.lon, o.lat] } },
      ]),
    };
    (mapRef.current?.getSource("areas") as GeoJSONSource | undefined)?.setData(data.current.areas as never);
  }, [overrides]);
  useEffect(() => {
    const features = [
      ...Object.values(disruptions)
        .filter((d) => d.status === "active" && d.geometry)
        .map((d) => ({ type: "Feature" as const, properties: { colour: "#eb0000" }, geometry: d.geometry as FC["features"][number]["geometry"] })),
      ...Object.values(incidents)
        .filter((i) => i.geometry)
        .map((i) => ({ type: "Feature" as const, properties: { colour: "#f27e00" }, geometry: i.geometry as FC["features"][number]["geometry"] })),
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
          <span className="mark">
            <TrainFront size={19} />
          </span>
          rail-twin
          <span className={`conn ${conn}`}>{conn === "online" ? "Live" : conn === "offline" ? "Offline" : "Connecting"}</span>
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
            <button aria-pressed={!satellite} onClick={() => setSatellite(false)}>
              Map
            </button>
            <button aria-pressed={satellite} onClick={() => setSatellite(true)}>
              Satellite
            </button>
          </div>
          <button className="toggle icon-only" onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))} aria-label={theme === "light" ? "Dark theme" : "Light theme"} title={theme === "light" ? "Dark theme" : "Light theme"}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
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
              ["god", "God mode", Zap],
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
          {tab === "god" && (
            <GodMode
              disruptions={Object.values(disruptions)}
              overrides={Object.values(overrides)}
              protection={protection}
              setProtection={setProtection}
              placingLabel={placingLabel}
              onPlace={(body, label) => {
                placing.current = body;
                setPlacingLabel(label);
                if (mapRef.current) mapRef.current.getCanvas().style.cursor = "crosshair";
              }}
              onCancelPlace={() => {
                placing.current = undefined;
                setPlacingLabel(undefined);
                if (mapRef.current) mapRef.current.getCanvas().style.cursor = "";
              }}
              say={say}
            />
          )}
          {tab === "incidents" && <Incidents incidents={Object.values(incidents)} say={say} />}
          {tab === "events" && <Events events={events} />}
          {tab === "connect" && <Connect />}
        </div>
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
            <i style={{ background: theme === "dark" || satellite ? "#ffffff" : COLOURS.selected }} />
            Selected
          </span>
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
      {toast && <p className="toast">{toast}</p>}
    </div>
  );
}

function TrainCard({ id, client, simulated, mods, following, grid, onFollow, onClose, say }: { id: string; client: MqttClient; simulated: boolean; mods: Disruption[]; following: boolean; grid?: TemperatureGrid; onFollow: () => void; onClose: () => void; say: (t: string) => void }) {
  const [pos, setPos] = useState<Pos>();
  const [info, setInfo] = useState<Info>();
  const [maxKmh, setMaxKmh] = useState("60");
  const [cruise, setCruise] = useState("120");
  const [hold, setHold] = useState("8");
  const [obstacle, setObstacle] = useState("400");
  const stopped = mods.find((d) => d.effect === "train_breakdown" || (d.effect === "obstacle" && d.params?.collidedAt));
  const crashed = mods.find((d) => d.effect === "obstacle" && d.params?.collidedAt);
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
  // stops still ahead carry an expected time; passed ones do not
  const upcoming = info?.calls.filter((c) => c.expectedArr !== null || c.expectedDep !== null).slice(0, 6) ?? [];
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
        <button
          onClick={() => void api<{ ended: string[] }>(`/trains/${id}/release`, { method: "POST", json: {} }).then((r) => say(r.ended.length ? "Released: the train moves on (late until synced)" : "Nothing to release"))}
          disabled={!mods.length}
          title="End every change on this train: it moves on, keeping its delay"
        >
          Release
        </button>
        <button onClick={() => void sync()} disabled={!simulated && !mods.length} title="Drop every change: the train reads the real data again">
          <RefreshCcw size={15} /> Sync to real data
        </button>
      </footer>
      <div className="modify">
        <h3>Modify this train</h3>
        {crashed && <p className="crash">Collision at {crashed.params.impactKmh} km/h</p>}
        <div className="mod-row">
          {stopped ? (
            <button className="go" onClick={() => void api(`/disruptions/${stopped.id}/end`, { method: "POST", json: {} }).then(() => say("Train released: it continues, late"))}>
              Resume
            </button>
          ) : (
            <>
              <button className="stop" onClick={() => void provoke("rolling_stock_failure")} title="Service braking, 0.7 m/s²">
                <Pause size={14} /> Stop
              </button>
              <button className="stop" onClick={() => void provoke("emergency_brake")} title="Emergency braking, 1.2 m/s²">
                Emergency stop
              </button>
            </>
          )}
          <button onClick={() => void provoke("skip_next_stop")}>Skip next stop</button>
          <button className="danger" onClick={() => void provoke("cancellation")}>
            Cancel
          </button>
        </div>
        <div className="mod-row">
          <label>
            Target speed
            <input value={cruise} onChange={(e) => setCruise(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /> km/h
          </label>
          <button disabled={!cruise} onClick={() => void provoke("target_speed", { kmh: Number(cruise) })}>
            Apply
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
            Obstacle ahead
            <input value={obstacle} onChange={(e) => setObstacle(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /> m
          </label>
          <button className="danger" disabled={!obstacle} onClick={() => void provoke("obstacle_collision", { distanceM: Number(obstacle) })}>
            Place
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
                  {d.params?.kmh && d.effect === "target_speed" ? ` · ${d.params.kmh} km/h` : ""}
                  {d.effect === "obstacle" ? (d.params?.collidedAt ? ` · hit at ${d.params.impactKmh} km/h` : ` · ${d.params?.distanceM} m ahead`) : ""}
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

type Preset = { id: string; label: string; tempC?: number; tempDeltaC?: number; precipMm?: number; windKmh?: number; gustKmh?: number };
const NETWORK_TYPES = (t: DType) => t.scope === "section" || t.scope === "station";

function GodMode({ disruptions, overrides, protection, setProtection, placingLabel, onPlace, onCancelPlace, say }: { disruptions: Disruption[]; overrides: WeatherOverride[]; protection: boolean; setProtection: (on: boolean) => void; placingLabel?: string; onPlace: (body: Record<string, unknown>, label: string) => void; onCancelPlace: () => void; say: (t: string) => void }) {
  const [types, setTypes] = useState<DType[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [typeId, setTypeId] = useState("overhead_line_fault");
  const [from, setFrom] = useState<Station>();
  const [to, setTo] = useState<Station>();
  const [station, setStation] = useState<Station>();
  const [minutes, setMinutes] = useState<string>("");
  const [maxKmh, setMaxKmh] = useState("40");
  const [hold, setHold] = useState("8");
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState<(Station & { km: number })[]>();
  useEffect(() => {
    setTo(undefined);
    setReachable(undefined);
    if (from) void api<(Station & { km: number })[]>(`/stations/${from.id}/neighbours`).then(setReachable).catch(() => {});
  }, [from]);
  const [preset, setPreset] = useState("heatwave");
  const [customTemp, setCustomTemp] = useState("");
  const [radius, setRadius] = useState("20");
  const [wMinutes, setWMinutes] = useState("60");
  useEffect(() => {
    void api<DType[]>("/disruption-types").then((t) => setTypes(t.filter(NETWORK_TYPES)));
    void api<{ presets: Preset[] }>("/god").then((g) => setPresets(g.presets));
  }, []);
  const type = types.find((t) => t.id === typeId);
  useEffect(() => setMinutes(type?.defaultMinutes ? String(type.defaultMinutes) : ""), [type]);
  const ready = type && (type.scope === "section" ? from && to : station);
  const submit = async () => {
    if (!type || !ready) return;
    setBusy(true);
    const scope = type.scope === "section" ? { kind: "section", from: from!.id, to: to!.id } : { kind: "station", station: station!.id };
    const params = type.effect === "speed_restriction" ? { maxKmh: Number(maxKmh) } : type.effect === "signal_failure" ? { holdMinutes: Number(hold) } : undefined;
    const r = await api<{ disruption: { label: string; where: string } }>("/disruptions", { method: "POST", json: { type: type.id, scope, minutes: minutes ? Number(minutes) : null, params, mark: true } }).catch((e) => (say(e.message), null));
    setBusy(false);
    if (r) say(`${r.disruption.label}: ${r.disruption.where}`);
  };
  const place = () => {
    const p = presets.find((x) => x.id === preset);
    const body: Record<string, unknown> = customTemp ? { label: `${customTemp} °C`, tempC: Number(customTemp) } : { preset };
    body.radiusKm = Number(radius) || 20;
    body.minutes = wMinutes ? Number(wMinutes) : null;
    onPlace(body, customTemp ? `${customTemp} °C` : (p?.label ?? "Weather"));
  };
  const toggleProtection = async () => {
    const want = !protection;
    setProtection(want); // show it at once; the server confirms over MQTT
    const r = await api<{ protection: boolean }>("/god/protection", { method: "POST", json: { on: want } }).catch((e) => (say(e.message), null));
    if (r) {
      setProtection(r.protection);
      say(r.protection ? "Train protection on: trains never run into each other" : "Train protection off: drivers only see what is ahead");
    } else setProtection(!want);
  };
  const releaseAll = async () => {
    const r = await api<{ ended: number }>("/god/release-all", { method: "POST", json: {} }).catch((e) => (say(e.message), null));
    if (r) say(`${r.ended} changes ended`);
  };
  const live = disruptions.filter((d) => d.status === "active").sort((a, b) => b.startedAt - a.startedAt);
  const weatherLive = overrides.filter((o) => o.status === "active");
  const ended = disruptions.filter((d) => d.status !== "active").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 6);
  return (
    <>
      <h3>Network</h3>
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
      {type?.scope === "section" && (
        <div className="row">
          <StationPicker label="From" value={from} onChange={setFrom} />
          <StationPicker label="To" value={to} onChange={setTo} options={from ? (reachable ?? []) : undefined} />
        </div>
      )}
      {type?.scope === "station" && <StationPicker label="Station" value={station} onChange={setStation} />}
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
        {type?.effect === "signal_failure" && (
          <label className="field">
            <span>Hold (min)</span>
            <input value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
      </div>
      <button className="primary wide" disabled={!ready || busy} onClick={() => void submit()}>
        <Zap size={15} /> Provoke
      </button>

      <h3>Weather</h3>
      <div className="chips">
        {presets.map((p) => (
          <button
            key={p.id}
            aria-pressed={!customTemp && preset === p.id}
            onClick={() => {
              setPreset(p.id);
              setCustomTemp("");
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="row">
        <label className="field">
          <span>Or set °C</span>
          <input value={customTemp} onChange={(e) => setCustomTemp(e.target.value.replace(/[^\d-]/g, ""))} placeholder="e.g. 42" />
        </label>
        <label className="field">
          <span>Radius (km)</span>
          <input value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="field">
          <span>Duration (min)</span>
          <input value={wMinutes} onChange={(e) => setWMinutes(e.target.value.replace(/\D/g, ""))} placeholder="until ended" />
        </label>
      </div>
      {placingLabel ? (
        <div className="placing">
          <span>Click on the map to place: {placingLabel}</span>
          <button onClick={onCancelPlace}>Cancel</button>
        </div>
      ) : (
        <button className="primary wide" onClick={place}>
          <CloudSun size={15} /> Place on the map
        </button>
      )}

      <h3>Safety</h3>
      <button className={`switch ${protection ? "on" : "off"}`} onClick={() => void toggleProtection()} aria-pressed={protection}>
        {protection ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}
        <span>
          <b>Train protection {protection ? "on" : "off"}</b>
          <small>{protection ? "Trains always stop behind a stopped train" : "Drivers only see a stopped train 500 m ahead"}</small>
        </span>
      </button>

      <h3>Active</h3>
      {!live.length && !weatherLive.length && <p className="hint">Nothing changed: every train follows the real data.</p>}
      <ul className="items">
        {weatherLive.map((o) => (
          <li key={o.id} data-kind="weather">
            <div>
              <b>{o.label}</b>
              <span>
                {o.radiusKm} km{o.tempC !== undefined ? ` · ${o.tempC} °C` : ""}
                {o.tempDeltaC !== undefined ? ` · ${o.tempDeltaC > 0 ? "+" : ""}${o.tempDeltaC} °C` : ""}
                {o.gustKmh ? ` · gusts ${o.gustKmh} km/h` : ""}
                {o.precipMm ? ` · ${o.precipMm} mm` : ""}
              </span>
              <small>since {hm(o.startedAt)}{o.endsAt ? ` · until ${hm(o.endsAt)}` : ""}</small>
            </div>
            <button onClick={() => void api(`/weather/overrides/${o.id}/end`, { method: "POST", json: {} })}>End</button>
          </li>
        ))}
        {live.map((d) => (
          <li key={d.id} data-status={d.status}>
            <div>
              <b>{d.label}</b>
              <span>{d.where}</span>
              <small>
                since {hm(d.startedAt)}
                {d.endsAt ? ` · until ${hm(d.endsAt)}` : ""} · {d.affectedTrains.length} trains
              </small>
            </div>
            <button onClick={() => void api(`/disruptions/${d.id}/end`, { method: "POST", json: {} })}>End</button>
          </li>
        ))}
        {ended.map((d) => (
          <li key={d.id} data-status={d.status}>
            <div>
              <b>{d.label}</b>
              <span>{d.where}</span>
              <small>ended {hm(d.endedAt)} · {d.affectedTrains.length} trains</small>
            </div>
            <button onClick={() => void api(`/disruptions/${d.id}`, { method: "DELETE" })}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row actions">
        <button className="secondary" onClick={() => void releaseAll()}>
          End everything
        </button>
      </div>
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
