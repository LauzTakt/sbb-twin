import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, ImageSource, Map as LibreMap } from "maplibre-gl";
import { Activity, CircleDot, CloudSnow, CloudSun, Crosshair, Layers, Link2, Moon, Pause, RefreshCcw, ShieldCheck, ShieldOff, Siren, Sun, Thermometer, TrainFront, Wind, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, brokerUrl, connectLive, type ControlState, type Live, type RealAlert, type Disruption, type Event, type Incident, type Status, type TemperatureGrid, type WeatherOverride, type WeatherSnapshot } from "./feed";
import { applyBase, baseStyle, type Theme } from "./map";
import { COLOURS, TrainCanvas } from "./trains";
import { gridImage, precipImage, RAIN_LEGEND, RAMP, rampColour, SNOW_LEGEND, temperatureAt } from "./weatherLayer";
import { WeatherParticles } from "./particles";

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
/** Rough size of an event's geometry in km, so the smallest one under the cursor wins the click. */
function extent(g: { type: string; coordinates: unknown } | null): number {
  if (!g || g.type === "Point") return 0;
  const lines = (g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : []) as number[][][];
  let km = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) km += Math.hypot((l[i][0] - l[i - 1][0]) * 76, (l[i][1] - l[i - 1][1]) * 111);
  return km;
}

type StationOption = Station & { km?: number; trains?: number };
let allStations: Promise<StationOption[]> | undefined;
/** Every station served today, busiest first (loaded once). */
const loadStations = () =>
  (allStations ??= api<{ features: { properties: { id: string; name: string; trains: number }; geometry: { coordinates: [number, number] } }[] }>("/stations.geojson")
    .then((fc) => fc.features.map((f) => ({ id: f.properties.id, name: f.properties.name, trains: f.properties.trains, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })))
    .catch(() => {
      allStations = undefined;
      return [];
    }));
const fold = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function StationPicker({ label, value, onChange, options }: { label: string; value?: Station; onChange: (s?: Station) => void; options?: StationOption[] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<StationOption[]>([]);
  useEffect(() => {
    if (!options) void loadStations().then(setAll);
  }, [options]);
  const source = options ?? all;
  const n = fold(q.trim());
  // open on focus with everything; typing narrows it (names starting with the text first)
  const list = open
    ? source
        .filter((s) => !n || fold(s.name).includes(n))
        .sort((a, b) => (n ? Number(!fold(b.name).startsWith(n)) - Number(!fold(a.name).startsWith(n)) : 0))
        .slice(0, 400)
    : [];
  return (
    <label className="field picker">
      <span>{label}</span>
      <input
        value={value ? value.name : q}
        placeholder={options ? "Choose a connected station" : "Search a station"}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onChange={(e) => {
          if (value) onChange(undefined);
          setQ(e.target.value);
          setOpen(true);
        }}
      />
      {list.length > 0 && (
        <ul>
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(s);
                  setQ(s.name);
                  setOpen(false);
                }}
              >
                {s.name} <small>{s.km !== undefined ? `${s.km} km` : s.trains !== undefined ? `${s.trains} trains` : s.id}</small>
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
  const client = useRef<Live | undefined>(undefined);
  const [conn, setConn] = useState<"connecting" | "online" | "offline">("connecting");
  const [status, setStatus] = useState<Status>();
  const [disruptions, setDisruptions] = useState<Record<string, Disruption>>({});
  const [incidents, setIncidents] = useState<Record<string, Incident>>({});
  const [alerts, setAlerts] = useState<RealAlert[]>([]);
  const [simulated, setSimulated] = useState<Set<string>>(new Set());
  const [causes, setCauses] = useState<Record<string, string[]>>({}); // why a simulated train behaves as it does
  const [events, setEvents] = useState<Event[]>([]);
  const [weather, setWeather] = useState<WeatherSnapshot>();
  const [grid, setGrid] = useState<TemperatureGrid>();
  const [precip, setPrecip] = useState<TemperatureGrid>();
  const particles = useRef<WeatherParticles | undefined>(undefined);
  // the whole page is light or dark; the map is either the drawn map or satellite imagery
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem("sbb-twin-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [satellite, setSatellite] = useState(false);
  const look = useRef({ theme, satellite });
  const prevTheme = useRef(theme);
  const [overrides, setOverrides] = useState<Record<string, WeatherOverride>>({});
  const [protection, setProtection] = useState(true);
  const placing = useRef<Record<string, unknown> | undefined>(undefined);
  const [picked, setPicked] = useState<{ kind: "disruption" | "incident" | "weather" | "alert"; id: string }>();
  const [placingLabel, setPlacingLabel] = useState<string>();
  // weather layer: off, temperature map, precipitation (rain/snow radar) or wind gusts
  const [wx, setWx] = useState<"off" | "temp" | "wind">("off");
  const [showPrecip, setShowPrecip] = useState(true); // rain & snow always shown where it falls
  const showTemp = wx === "temp";
  const precipRef = useRef(showPrecip);
  const [showTrains, setShowTrains] = useState(true);
  const [showStations, setShowStations] = useState(true);
  const [station, setStation] = useState<{ id: string; name: string; trains: number }>();
  const [tab, setTab] = useState<"control" | "incidents" | "events" | "connect">("control");
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
      particles.current = new WeatherParticles(m);
      (window as unknown as { railParticles?: WeatherParticles }).railParticles = particles.current; // debugging handle
      layer.current = new TrainCanvas(m);
      setReady(true);
      m.on("load", () => {
        addOverlays(m);
        restyle(m);
      });
      m.on("click", (e) => {
        if (placing.current) {
          // control: put the prepared weather change where the map was clicked
          const body = { ...placing.current, lat: e.lngLat.lat, lon: e.lngLat.lng };
          placing.current = undefined;
          setPlacingLabel(undefined);
          m.getCanvas().style.cursor = "";
          void api<{ override: WeatherOverride; consequences: Disruption[] }>("/weather/overrides", { method: "POST", json: body })
            .then((r) => {
              createdRef.current(r);
              say(`${r.override.label} placed${r.consequences.length ? ` · ${r.consequences.map((c) => c.label).join(", ")}` : ""}`);
            })
            .catch((err) => say(err.message));
          return;
        }
        const id = layer.current?.hit(e.point.x, e.point.y);
        if (id) {
          setSelected(id);
          setStation(undefined);
          return;
        }
        // no train there: the smallest event under the cursor (a station before a section before a weather area)
        const box: [[number, number], [number, number]] = [
          [e.point.x - 7, e.point.y - 7],
          [e.point.x + 7, e.point.y + 7],
        ];
        const layers = ["disruption-point", "disruption-line", "disruption-glow", "alert-point", "alert-line", "area-fill"].filter((l) => m.getLayer(l));
        const hit = m
          .queryRenderedFeatures(box, { layers })
          .filter((f) => f.properties?.id)
          .sort((a, b) => Number(a.properties.size) - Number(b.properties.size))[0];
        if (hit) {
          const kind = hit.properties.kind as "disruption" | "incident" | "weather" | "alert";
          setPicked({ kind, id: String(hit.properties.id) });
          setTab(kind === "incident" || kind === "alert" ? "incidents" : "control");
          return;
        }
        const st = m.queryRenderedFeatures(box, { layers: ["stations-major", "stations-medium", "stations-minor"].filter((l) => m.getLayer(l)) })[0];
        if (st) {
          setStation({ id: String(st.properties.id), name: String(st.properties.name), trains: Number(st.properties.trains) });
          setSelected(undefined);
          return;
        }
        setPicked(undefined);
        setSelected(undefined);
        setStation(undefined);
        setFollowing(false);
      });
      m.on("dragstart", () => setFollowing(false));
      client.current = connectLive({
        connection: setConn,
        tick: (_ts, rows, st) => {
          layer.current?.update(rows);
          setStatus(st);
        },
        state: (st) => applyState.current(st),
        event: (e) => setEvents((x) => [e, ...x].slice(0, 80)),
        events: (list) => setEvents(list.slice(0, 80)),
        alerts: setAlerts,
        weather: setWeather,
        grid: setGrid,
        precip: setPrecip,
      });
    })();
    return () => {
      alive = false;
      client.current?.close();
      layer.current?.destroy();
      mapRef.current?.remove();
    };
  }, []);
  useEffect(() => {
    if (layer.current) layer.current.simulated = simulated;
  }, [simulated]);
  // the twin sends its whole control state whenever it changes: the page shows exactly that, nothing older
  const applyState = useRef((s: ControlState) => {
    setDisruptions(Object.fromEntries(s.disruptions.map((d) => [d.id, d])));
    setIncidents(Object.fromEntries(s.incidents.map((i) => [i.id, i])));
    setOverrides(Object.fromEntries(s.overrides.map((o) => [o.id, o])));
    setProtection(s.protection);
    setSimulated(new Set(s.simulated.map((x) => x.trainId)));
    setCauses(Object.fromEntries(s.simulated.map((x) => [x.trainId, x.causes])));
  });
  useEffect(() => {
    const m = mapRef.current;
    for (const tier of ["major", "medium", "minor"])
      for (const id of [`stations-${tier}`, `station-labels-${tier}`]) if (m?.getLayer(id)) m.setLayoutProperty(id, "visibility", showStations ? "visible" : "none");
  }, [showStations]);
  useEffect(() => {
    if (!layer.current) return;
    layer.current.selected = selected;
    layer.current.following = following && Boolean(selected);
    layer.current.visible = showTrains;
    layer.current.theme = look.current.theme === "light" && !look.current.satellite ? "light" : "dark";
  }, [selected, following, showTrains, ready]);

  // ---- overlays (added once; the base map never reloads)
  const data = useRef({ alerts: empty as FC, disruptions: empty as FC, weather: empty as FC, areas: empty as FC, grid: undefined as ReturnType<typeof gridImage> | undefined, precipImg: undefined as ReturnType<typeof precipImage> | undefined, temp: false });
  const wxRef = useRef(wx);
  function addTemperature(m: LibreMap) {
    const d = data.current;
    if (!d.grid || m.getSource("temperature")) return;
    m.addSource("temperature", { type: "image", url: d.grid.url, coordinates: d.grid.coordinates });
    m.addLayer(
      { id: "temperature", type: "raster", source: "temperature", paint: { "raster-opacity": 0.6, "raster-resampling": "linear", "raster-fade-duration": 0 }, layout: { visibility: d.temp ? "visible" : "none" } },
      m.getLayer("network") ? "network" : undefined,
    );
  }
  function addPrecip(m: LibreMap) {
    const img = data.current.precipImg;
    if (!img || m.getSource("precipitation")) return;
    m.addSource("precipitation", { type: "image", url: img.url, coordinates: img.coordinates });
    m.addLayer({ id: "precipitation", type: "raster", source: "precipitation", paint: { "raster-opacity": 0.85, "raster-resampling": "linear", "raster-fade-duration": 0 }, layout: { visibility: precipRef.current ? "visible" : "none" } }, m.getLayer("network") ? "network" : undefined);
  }
  function addOverlays(m: LibreMap) {
    const d = data.current;
    // railways abroad (OpenStreetMap, prepared by tools/prepare_abroad.py), under the Swiss BAV network
    if (!m.getSource("abroad")) {
      m.addSource("abroad", { type: "geojson", data: "/api/abroad.geojson", attribution: "© OpenStreetMap contributors" });
      m.addLayer({ id: "rail-abroad-halo", type: "line", source: "abroad", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.2, 10, 3.4, 14, 5.6], "line-opacity": 0.8 } });
      m.addLayer({ id: "rail-abroad", type: "line", source: "abroad", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#767676", "line-width": ["interpolate", ["linear"], ["zoom"], 6, ["match", ["get", "usage"], "main", 0.9, 0.6], 10, ["match", ["get", "usage"], "main", 1.6, 1.1], 14, 2.6], "line-opacity": 0.85 } });
    }
    addTemperature(m);
    if (!m.getSource("network")) {
      // Swiss network (BAV): a halo under a strong line so the tracks read on any base map
      m.addSource("network", { type: "geojson", data: "/api/network.geojson" });
      m.addLayer({ id: "network-halo", type: "line", source: "network", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.6, 10, 4, 14, 6.5], "line-opacity": 0.9 } });
      m.addLayer({ id: "network", type: "line", source: "network", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#444444", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 10, 1.8, 14, 3.2], "line-opacity": 0.95 } });
    }
    if (!m.getSource("stations")) {
      // stops: busy stations from far out, small ones as you zoom in (SBB style: white dot, dark ring)
      m.addSource("stations", { type: "geojson", data: "/api/stations.geojson" });
      const tiers: [string, unknown[], number, number][] = [
        ["major", [">=", ["get", "trains"], 300], 6, 8],
        ["medium", ["all", ["<", ["get", "trains"], 300], [">=", ["get", "trains"], 60]], 9, 10.5],
        ["minor", ["<", ["get", "trains"], 60], 11, 12.5],
      ];
      for (const [tier, filter, dotZoom, labelZoom] of tiers) {
        m.addLayer({ id: `stations-${tier}`, type: "circle", source: "stations", minzoom: dotZoom, filter: filter as never, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, tier === "major" ? 3 : 2, 12, tier === "major" ? 6 : tier === "medium" ? 4.5 : 3.5], "circle-color": "#ffffff", "circle-stroke-color": "#212121", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 12, 1.8] } });
        m.addLayer({ id: `station-labels-${tier}`, type: "symbol", source: "stations", minzoom: labelZoom, filter: filter as never, layout: { "text-field": ["get", "name"], "text-font": [tier === "major" ? "Frutiger Neue Bold" : "Frutiger Neue Regular"], "text-size": tier === "major" ? 13 : 12, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true, "symbol-sort-key": ["-", 0, ["get", "trains"]], "text-padding": 4 }, paint: { "text-color": "#212121", "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.8 } });
      }
    }
    if (!m.getSource("areas")) {
      m.addSource("areas", { type: "geojson", data: d.areas as never });
      m.addLayer({ id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": ["get", "colour"], "fill-opacity": 0.14 } });
      m.addLayer({ id: "area-line", type: "line", source: "areas", paint: { "line-color": ["get", "colour"], "line-width": 2, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "area-picked", type: "line", source: "areas", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0079c7", "line-width": 4 } });
      m.addLayer({ id: "area-label", type: "symbol", source: "areas", layout: { "text-field": ["get", "label"], "text-size": 13, "text-font": ["Frutiger Neue Bold"], "symbol-placement": "point", "text-anchor": "bottom", "text-offset": [0, -0.4] }, paint: { "text-color": ["get", "colour"], "text-halo-color": "#ffffff", "text-halo-width": 2 } });
    }
    if (!m.getSource("disruptions")) {
      m.addSource("alerts", { type: "geojson", data: d.alerts as never });
      m.addLayer({ id: "alert-line", type: "line", source: "alerts", filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 12, 5.5], "line-dasharray": [1.6, 1.1] } });
      m.addLayer({ id: "alert-point", type: "circle", source: "alerts", filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]], minzoom: 7, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 5, 12, 9], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 2.5 } });
      m.addLayer({ id: "alert-picked-line", type: "line", source: "alerts", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0079c7", "line-width": 7, "line-opacity": 0.85 } });
      m.addLayer({ id: "alert-picked-point", type: "circle", source: "alerts", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 14, "circle-color": "rgba(0,121,199,0.15)", "circle-stroke-color": "#0079c7", "circle-stroke-width": 3 } });
      m.addSource("disruptions", { type: "geojson", data: d.disruptions as never });
      m.addLayer({ id: "disruption-glow", type: "line", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 18], "line-opacity": 0.3, "line-blur": 3 } });
      m.addLayer({ id: "disruption-line", type: "line", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3.5, 12, 6] } });
      m.addLayer({ id: "disruption-point", type: "circle", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 3 } });
      m.addLayer({ id: "picked-line", type: "line", source: "disruptions", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0079c7", "line-width": 7, "line-opacity": 0.85 } });
      m.addLayer({ id: "picked-point", type: "circle", source: "disruptions", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 16, "circle-color": "rgba(0,121,199,0.15)", "circle-stroke-color": "#0079c7", "circle-stroke-width": 3 } });
    }
    if (!m.getSource("weather")) {
      m.addSource("weather", { type: "geojson", data: d.weather as never });
      if (!m.hasImage("wind-arrow")) m.addImage("wind-arrow", windArrow(), { sdf: true });
      m.addLayer({ id: "wind-arrow", type: "symbol", source: "weather", filter: [">=", ["get", "dir"], 0], layout: { visibility: "none", "icon-image": "wind-arrow", "icon-rotate": ["get", "dir"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["interpolate", ["linear"], ["get", "wind"], 0, 0.3, 20, 0.45, 50, 0.65, 90, 0.85], "symbol-sort-key": ["get", "wind"] }, paint: { "icon-color": ["step", ["get", "gust"], "#2d327d", 50, "#0079c7", 75, "#f27e00", 100, "#eb0000"], "icon-halo-color": "rgba(255,255,255,0.95)", "icon-halo-width": 1.5 } });
      m.addLayer({ id: "wind-label", type: "symbol", source: "weather", filter: [">=", ["get", "wind"], 0], layout: { visibility: "none", "text-field": ["step", ["zoom"], ["case", [">=", ["get", "gust"], 30], ["get", "windLabel"], ""], 9, ["get", "windLabel"]], "text-anchor": "top", "text-offset": [0, 1.1], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10.5, 10, 13], "text-font": ["Frutiger Neue Bold"], "text-allow-overlap": false, "text-padding": 6, "symbol-sort-key": ["-", 0, ["get", "gust"]] }, paint: { "text-color": ["step", ["get", "gust"], "#2d327d", 50, "#0079c7", 75, "#f27e00", 100, "#eb0000"], "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 2 } });
      m.addLayer({ id: "weather-label", type: "symbol", source: "weather", layout: { visibility: d.temp ? "visible" : "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 10, 13.5], "text-font": ["Frutiger Neue Bold"], "text-allow-overlap": false, "text-padding": 6 }, paint: { "text-color": "#212121", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 2 } });
    }
  }
  /** Light/dark page and map, or satellite: recolour in place (no reload). */
  function restyle(m: LibreMap) {
    const { theme: th, satellite: sat } = look.current;
    applyBase(m, th, sat);
    const rail = sat ? "#ffffff" : th === "dark" ? "#9aa6b8" : "#444444";
    const halo = sat ? "rgba(0,0,0,0.55)" : th === "dark" ? "#0b0e11" : "#ffffff";
    if (m.getLayer("network")) {
      m.setPaintProperty("network", "line-color", rail);
      m.setPaintProperty("network-halo", "line-color", halo);
    }
    if (m.getLayer("rail-abroad")) {
      m.setPaintProperty("rail-abroad", "line-color", sat ? "#e6e6e6" : th === "dark" ? "#6f7a8a" : "#767676");
      m.setPaintProperty("rail-abroad-halo", "line-color", halo);
    }
    const dark = th === "dark" || sat;
    if (m.getLayer("weather-label")) {
      m.setPaintProperty("weather-label", "text-color", dark ? "#ffffff" : "#212121");
      m.setPaintProperty("weather-label", "text-halo-color", dark ? "rgba(16,20,24,0.9)" : "rgba(255,255,255,0.92)");
    }
    if (m.getLayer("area-label")) m.setPaintProperty("area-label", "text-halo-color", dark ? "#101418" : "#ffffff");
    for (const tier of ["major", "medium", "minor"]) {
      if (!m.getLayer(`station-labels-${tier}`)) continue;
      m.setPaintProperty(`station-labels-${tier}`, "text-color", dark ? "#f1f2f4" : "#212121");
      m.setPaintProperty(`station-labels-${tier}`, "text-halo-color", dark ? "rgba(16,20,24,0.92)" : "rgba(255,255,255,0.95)");
      m.setPaintProperty(`stations-${tier}`, "circle-stroke-color", dark ? "#0b0e11" : "#212121");
    }
    if (layer.current) layer.current.theme = dark ? "dark" : "light";
    if (particles.current) particles.current.dark = dark;
    if (m.getLayer("wind-label")) m.setPaintProperty("wind-label", "text-halo-color", dark ? "rgba(16,20,24,0.92)" : "rgba(255,255,255,0.95)");
    if (m.getLayer("wind-arrow")) m.setPaintProperty("wind-arrow", "icon-halo-color", dark ? "rgba(16,20,24,0.92)" : "rgba(255,255,255,0.95)");
  }
  useEffect(() => {
    look.current = { theme, satellite };
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("sbb-twin-theme", theme);
    } catch {
      /* private mode */
    }
    const m = mapRef.current;
    if (!m?.getLayer("swissimage")) return;
    const el = mapEl.current;
    if (el && prevTheme.current !== theme) {
      // the map dips, recolours while dim, and fades back: no visible jump
      el.classList.add("restyling");
      const t1 = setTimeout(() => restyle(m), 180);
      const t2 = setTimeout(() => el.classList.remove("restyling"), 260);
      prevTheme.current = theme;
      return () => (clearTimeout(t1), clearTimeout(t2));
    }
    restyle(m);
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
        { type: "Feature" as const, properties: { colour: colour(o), label: "", id: o.id, kind: "weather", size: o.radiusKm * 2 }, geometry: { type: "Polygon", coordinates: [circle(o)] } },
        { type: "Feature" as const, properties: { colour: colour(o), label: `${o.label}\n${describe(o)}` }, geometry: { type: "Point", coordinates: [o.lon, o.lat + o.radiusKm / 111.32] } },
      ]),
    };
    (mapRef.current?.getSource("areas") as GeoJSONSource | undefined)?.setData(data.current.areas as never);
  }, [overrides]);
  useEffect(() => {
    const features = [
      ...Object.values(disruptions)
        .filter((d) => d.status === "active" && d.geometry && d.geometry.type !== "Polygon")
        .map((d) => ({ type: "Feature" as const, properties: { colour: d.effect === "speed_restriction" || d.effect === "signal_failure" ? "#f27e00" : "#eb0000", id: d.id, kind: "disruption", size: extent(d.geometry) }, geometry: d.geometry as FC["features"][number]["geometry"] })),
      ...Object.values(incidents)
        .filter((i) => i.geometry)
        .map((i) => ({ type: "Feature" as const, properties: { colour: "#f27e00", id: i.id, kind: "incident", size: extent(i.geometry) }, geometry: i.geometry as FC["features"][number]["geometry"] })),
    ];
    data.current.disruptions = { type: "FeatureCollection", features };
    (mapRef.current?.getSource("disruptions") as GeoJSONSource | undefined)?.setData(data.current.disruptions as never);
  }, [disruptions, incidents]);
  useEffect(() => {
    // real SBB alerts: dashed track sections and station rings, red when service is interrupted, orange when limited
    const colour = (a: RealAlert) => (a.severity === "major" ? "#eb0000" : a.severity === "minor" ? "#f27e00" : "#0079c7");
    data.current.alerts = {
      type: "FeatureCollection",
      features: alerts
        .filter((a) => a.geometry)
        .map((a) => ({ type: "Feature" as const, properties: { id: a.id, kind: "alert", colour: colour(a), size: extent(a.geometry) + 1 }, geometry: a.geometry as FC["features"][number]["geometry"] })),
    };
    (mapRef.current?.getSource("alerts") as GeoJSONSource | undefined)?.setData(data.current.alerts as never);
  }, [alerts]);
  useEffect(() => {
    if (!weather) return;
    data.current.weather = {
      type: "FeatureCollection",
      features: weather.stations
        .map((row) => Object.fromEntries(weather.fields.map((f, i) => [f, row[i]])) as Record<string, string | number | null>)
        .filter((s) => s.tempC !== null || s.gustKmh !== null)
        .map((s) => ({
          type: "Feature" as const,
          properties: {
            id: s.id,
            name: s.name,
            colour: typeof s.tempC === "number" ? rampColour(s.tempC) : "#999",
            label: typeof s.tempC === "number" ? `${s.tempC.toFixed(1)}°` : "",
            gust: typeof s.gustKmh === "number" ? Math.round(s.gustKmh) : -1,
            wind: typeof s.windKmh === "number" ? Math.round(s.windKmh) : -1,
            dir: typeof s.windDirDeg === "number" ? (s.windDirDeg + 180) % 360 : -1,
            windLabel: typeof s.windKmh === "number" ? `${Math.round(s.windKmh)}${typeof s.gustKmh === "number" && s.gustKmh >= s.windKmh + 5 ? `–${Math.round(s.gustKmh)}` : ""} km/h` : "",
          },
          geometry: { type: "Point" as const, coordinates: [s.lon as number, s.lat as number] },
        })),
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
    wxRef.current = wx;
    const m = mapRef.current;
    if (m && showTemp && !m.getSource("temperature")) addTemperature(m);
    precipRef.current = showPrecip;
    if (m && showPrecip && !m.getSource("precipitation")) addPrecip(m);
    const show: Record<string, boolean> = { temperature: wx === "temp", "weather-label": wx === "temp", precipitation: showPrecip, "wind-label": wx === "wind", "wind-arrow": wx === "wind" };
    for (const [id, on] of Object.entries(show)) if (m?.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wx, showPrecip]);
  useEffect(() => {
    if (!precip) return;
    data.current.precipImg = precipImage(precip, grid);
    const m = mapRef.current;
    const src = m?.getSource("precipitation") as ImageSource | undefined;
    if (src) src.updateImage({ url: data.current.precipImg.url, coordinates: data.current.precipImg.coordinates });
    else if (m && showPrecip) {
      try {
        addPrecip(m);
      } catch {
        m.once("idle", () => addPrecip(m));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precip, grid]);
  useEffect(() => {
    // falling rain / drifting snow / wind streaks inside the active god-mode weather areas
    const made = Object.values(overrides)
      .filter((o) => o.status === "active")
      .map((o) => {
        const t = o.tempC ?? (grid ? (temperatureAt(grid, o.lon, o.lat) ?? 5) : 5);
        return { id: o.id, lon: o.lon, lat: o.lat, radiusKm: o.radiusKm, precipMm: o.precipMm ?? 0, gustKmh: o.gustKmh ?? 0, snow: o.phase ? o.phase === "snow" : t <= 1 };
      });
    // real rain and snow where MeteoSwiss stations measure it (at least 0.3 mm in 10 minutes)
    const f = weather?.fields ?? [];
    const [pi, ti, gi, li, oi, ii] = ["precipMm", "tempC", "gustKmh", "lat", "lon", "id"].map((k) => f.indexOf(k));
    const inside = (lat: number, lon: number) => made.some((a) => Math.hypot((lat - a.lat) * 111.32, (lon - a.lon) * 111.32 * Math.cos((lat * Math.PI) / 180)) < a.radiusKm + 8);
    const real = (weather?.stations ?? [])
      .filter((r) => typeof r[pi] === "number" && (r[pi] as number) >= 0.3 && !inside(r[li] as number, r[oi] as number))
      .map((r) => ({ id: `station-${r[ii]}`, lon: r[oi] as number, lat: r[li] as number, radiusKm: 8, precipMm: r[pi] as number, gustKmh: typeof r[gi] === "number" ? (r[gi] as number) : 0, snow: typeof r[ti] === "number" && (r[ti] as number) <= 1 }));
    particles.current?.set([...made, ...real]);
  }, [overrides, grid, weather]);

  // the picked event: highlighted on the map, scrolled to in the list
  useEffect(() => {
    const m = mapRef.current;
    const id = picked?.id ?? "";
    for (const l of ["picked-line", "picked-point", "area-picked", "alert-picked-line", "alert-picked-point"]) if (m?.getLayer(l)) m.setFilter(l, ["==", ["get", "id"], id]);
    if (!picked) return;
    const t = setTimeout(() => document.querySelector(`[data-id="${picked.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => clearTimeout(t);
  }, [picked, tab]);

  // ---- creations show at once from the server's reply (MQTT confirms a moment later)
  const upsert = {
    disruption: (d?: Disruption | null) => d && setDisruptions((x) => ({ ...x, [d.id]: d })),
    incident: (i?: Incident | null) => i && setIncidents((x) => ({ ...x, [i.id]: i })),
    override: (o?: WeatherOverride | null) => o && setOverrides((x) => ({ ...x, [o.id]: o })),
  };
  const created: Created = (r) => {
    if (!r) return;
    upsert.disruption(r.disruption);
    upsert.incident(r.incident);
    upsert.override(r.override);
    for (const d of r.consequences ?? []) upsert.disruption(d);
  };
  const createdRef = useRef(created);
  createdRef.current = created;

  // ---- actions: the UI changes at once; the server confirms over MQTT, or the change is undone with a message
  const drop = <T,>(x: Record<string, T>, id: string) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== id));
  const act = {
    endDisruption: (id: string) => {
      const before = disruptions[id];
      if (before) setDisruptions((x) => ({ ...x, [id]: { ...before, status: "ended", endedAt: Date.now() } }));
      void api(`/disruptions/${id}/end`, { method: "POST", json: {} }).catch((e) => {
        say(e.message);
        if (before) setDisruptions((x) => ({ ...x, [id]: before }));
      });
    },
    removeDisruption: (id: string) => {
      const before = disruptions[id];
      setDisruptions((x) => drop(x, id));
      void api(`/disruptions/${id}`, { method: "DELETE" }).catch((e) => {
        say(e.message);
        if (before) setDisruptions((x) => ({ ...x, [id]: before }));
      });
    },
    endWeather: (id: string) => {
      const before = overrides[id];
      if (before) setOverrides((x) => ({ ...x, [id]: { ...before, status: "ended", endedAt: Date.now() } }));
      void api(`/weather/overrides/${id}/end`, { method: "POST", json: {} }).catch((e) => {
        say(e.message);
        if (before) setOverrides((x) => ({ ...x, [id]: before }));
      });
    },
    unmark: (id: string) => {
      const before = incidents[id];
      setIncidents((x) => drop(x, id));
      void api(`/incidents/${id}`, { method: "DELETE" })
        .then(() => say("Incident unmarked"))
        .catch((e) => {
          say(e.message);
          if (before) setIncidents((x) => ({ ...x, [id]: before }));
        });
    },
  };

  // ---- actions
  const syncAll = async () => {
    const r = await api<{ removed: number; synced: number }>("/control/reset", { method: "POST", json: {} }).catch((e) => (say(e.message), null));
    if (!r) return;
    setPicked(undefined);
    setProtection(true);
    setDisruptions({});
    setIncidents({});
    setOverrides({});
    setSimulated(new Set());
    setCauses({});
    say(r.removed || r.synced ? `Back to reality: ${r.removed} changes removed, ${r.synced} trains synced` : "Already on the real data");
  };
  const active = Object.values(disruptions).filter((d) => d.status === "active");
  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="mark">
            <TrainFront size={19} />
          </span>
          sbb-twin
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
          {(status?.realtime.feedAgeSec ?? 0) > 180 && (
            <span className="warn" title="The official real-time predictions are late: trains follow their last known delays">
              live data {Math.round((status?.realtime.feedAgeSec ?? 0) / 60)} min old
            </span>
          )}
          {weather?.measuredAt && (
            <span className="wx" title="MeteoSwiss measurement time">
              weather {hm(weather.measuredAt)}
            </span>
          )}
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
          <div className="seg wx" role="group" aria-label="Layers">
            <button aria-pressed={showTrains} onClick={() => setShowTrains((x) => !x)} title="Trains">
              <Layers size={15} />
              <span className="label">Trains</span>
            </button>
            <button aria-pressed={showStations} onClick={() => setShowStations((x) => !x)} title="Stations">
              <CircleDot size={15} />
              <span className="label">Stations</span>
            </button>
          </div>
          <div className="seg wx" role="group" aria-label="Weather layer">
            <button aria-pressed={showPrecip} onClick={() => setShowPrecip((x) => !x)} title="Rain & snow">
              <CloudSnow size={15} />
              <span className="label">Rain & snow</span>
            </button>
            {(
              [
                ["temp", "Temperature", Thermometer],
                ["wind", "Wind", Wind],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} aria-pressed={wx === id} onClick={() => setWx((w) => (w === id ? "off" : id))} title={label}>
                <Icon size={15} />
                <span className="label">{label}</span>
              </button>
            ))}
          </div>
          <button className="primary go" onClick={() => void syncAll()} title="Back to reality: delete every change and sync every train">
            <RefreshCcw size={15} /> Sync all
          </button>
        </div>
      </header>
      <div ref={mapEl} className="map" />
      <aside className="side">
        <nav className="tabs">
          {(
            [
              ["control", "Control", Zap],
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
          {tab === "control" && (
            <ControlPanel
              disruptions={Object.values(disruptions)}
              overrides={Object.values(overrides)}
              picked={picked?.id}
              act={act}
              onCreated={created}
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
          {tab === "incidents" && <Incidents incidents={Object.values(incidents)} alerts={alerts} picked={picked?.id} onUnmark={act.unmark} onCreated={(i) => upsert.incident(i)} say={say} />}
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
            <i className="selected" />
            Selected
          </span>
          <span>
            <i className="ring" />
            Simulated (provoked)
          </span>
          {showPrecip && (precip?.values.some((v) => (v ?? 0) >= 0.05) || Object.values(overrides).some((o) => o.status === "active" && (o.precipMm ?? 0) > 0)) && (
            <div className="ramp">
              <div style={{ background: `linear-gradient(90deg, ${RAIN_LEGEND.map(([, c]) => c).join(",")})` }} />
              <small>
                <span>rain 0.3</span>
                <span>2</span>
                <span>6</span>
                <span>15</span>
                <span>30</span>
                <span>60 mm/h</span>
              </small>
              <div style={{ background: `linear-gradient(90deg, ${SNOW_LEGEND.map(([, c]) => c).join(",")})`, marginTop: 4, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)" }} />
              <small>
                <span>snow · light</span>
                <span>heavy</span>
              </small>
            </div>
          )}
          {wx === "wind" && (
            <div className="ramp">
              <small>
                <span style={{ color: "#2d327d" }}>gusts &lt; 50 km/h</span>
                <span style={{ color: "#0079c7" }}>50</span>
                <span style={{ color: "#f27e00" }}>75</span>
                <span style={{ color: "#eb0000" }}>≥ 100</span>
              </small>
            </div>
          )}
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
          onEnd={act.endDisruption}
          onCreated={created}
          holds={(causes[selected] ?? [])
            .map((c) =>
              c === "protection"
                ? { id: c, label: "Train stopped ahead (signalling holds it)" }
                : c === "protection-off"
                  ? { id: c, label: "Train ahead in sight: driver braking" }
                  : disruptions[c] && disruptions[c].status === "active" && !(disruptions[c].scope.kind === "train" && disruptions[c].scope.trainId === selected)
                    ? { id: c, label: `${disruptions[c].label}: ${disruptions[c].where}` }
                    : undefined,
            )
            .filter((x): x is { id: string; label: string } => Boolean(x))}
          onPick={(id) => {
            setPicked({ kind: "disruption", id });
            setTab("control");
          }}
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
      {station && !selected && (
        <StationCard
          key={station.id}
          station={station}
          onCreated={created}
          onClose={() => setStation(undefined)}
          onTrain={(id) => {
            setSelected(id);
            setStation(undefined);
          }}
          onSection={() => {
            setTab("control");
            window.dispatchEvent(new CustomEvent("sbb-section-from", { detail: station }));
          }}
          say={say}
        />
      )}
      {toast && <p className="toast">{toast}</p>}
    </div>
  );
}

function TrainCard({ id, client, simulated, mods, onEnd, onCreated, holds, onPick, following, grid, onFollow, onClose, say }: { id: string; client: Live; simulated: boolean; mods: Disruption[]; onEnd: (id: string) => void; onCreated: Created; holds: { id: string; label: string }[]; onPick: (id: string) => void; following: boolean; grid?: TemperatureGrid; onFollow: () => void; onClose: () => void; say: (t: string) => void }) {
  const [pos, setPos] = useState<Pos>();
  const [info, setInfo] = useState<Info>();
  const [cruise, setCruise] = useState("120");
  const [hold, setHold] = useState("8");
  const [obstacle, setObstacle] = useState("400");
  const stopped = mods.find((d) => d.effect === "train_breakdown" || (d.effect === "obstacle" && d.params?.collidedAt));
  const crashed = mods.find((d) => d.effect === "obstacle" && d.params?.collidedAt);
  useEffect(
    () =>
      client.watch(id, (p, i) => {
        if (p) setPos(p as unknown as Pos);
        if (i) setInfo(i as unknown as Info);
      }),
    [client, id],
  );
  const provoke = async (type: string, params?: Record<string, number>) => {
    const r = await api<{ disruption: Disruption }>("/disruptions", { method: "POST", json: { type, scope: { kind: "train", trainId: id }, params } }).catch((e) => (say(e.message), null));
    onCreated(r);
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
        <button onClick={() => void sync()} disabled={!simulated && !mods.length} title="Drop every change: the train reads the real data again">
          <RefreshCcw size={15} /> Sync to real data
        </button>
      </footer>
      <div className="modify">
        <h3>Modify this train</h3>
        {crashed && <p className="crash">Collision at {crashed.params.impactKmh} km/h</p>}
        {holds.length > 0 && (
          <div className="holds">
            <b>Held by</b>
            {holds.map((h) =>
              h.id.startsWith("protection") ? (
                <span key={h.id}>{h.label}</span>
              ) : (
                <button key={h.id} onClick={() => onPick(h.id)}>
                  {h.label}
                </button>
              ),
            )}
          </div>
        )}
        <div className="mod-row">
          {stopped ? (
            <button
              className="go"
              onClick={() => {
                onEnd(stopped.id);
                say("Resumed: it accelerates and catches up with its real timetable");
              }}
            >
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
                <button onClick={() => onEnd(d.id)}>Remove</button>
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

type Act = { endDisruption: (id: string) => void; removeDisruption: (id: string) => void; endWeather: (id: string) => void; unmark: (id: string) => void };
type Created = (r: { disruption?: Disruption; incident?: Incident | null; override?: WeatherOverride; consequences?: Disruption[] } | null) => void;
type BoardRow = { trainId: string | null; line: string; category: string; headsign: string; planned: number; expected: number; delayMin: number; cancelled: boolean };
function StationCard({ station, onCreated, onClose, onTrain, onSection, say }: { station: { id: string; name: string; trains: number }; onCreated: Created; onClose: () => void; onTrain: (id: string) => void; onSection: () => void; say: (t: string) => void }) {
  const [board, setBoard] = useState<BoardRow[]>();
  useEffect(() => {
    const load = () => void api<BoardRow[]>(`/stations/${station.id}/board`).then(setBoard).catch(() => setBoard([]));
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [station.id]);
  const provoke = async (type: string) => {
    const r = await api<{ disruption: Disruption; incident: Incident | null }>("/disruptions", { method: "POST", json: { type, scope: { kind: "station", station: station.id }, mark: true } }).catch((e) => (say(e.message), null));
    onCreated(r);
    if (r) say(`${r.disruption.label}: ${station.name}`);
  };
  return (
    <section className="card station-card" aria-label="Station">
      <header>
        <span className="badge station-badge">
          <CircleDot size={14} />
        </span>
        <div>
          <h2>{station.name}</h2>
          <small>{station.trains} trains today</small>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      <ol className="calls board">
        {board === undefined && <li className="hint">Loading…</li>}
        {board?.length === 0 && <li className="hint">No departures in the next hour.</li>}
        {board?.map((r) => (
          <li key={`${r.line}-${r.planned}-${r.headsign}`} className={r.cancelled ? "skipped" : ""}>
            <time>{hm(r.planned)}</time>
            <span>
              {r.trainId ? (
                <button className="linklike" onClick={() => onTrain(r.trainId!)}>
                  <b>{r.line}</b> {r.headsign}
                </button>
              ) : (
                <>
                  <b>{r.line}</b> {r.headsign}
                </>
              )}
            </span>
            {r.cancelled ? <em className="late">cancelled</em> : r.delayMin > 0 ? <em className="late">+{r.delayMin}′</em> : <em />}
          </li>
        ))}
      </ol>
      <div className="modify">
        <h3>Control</h3>
        <div className="mod-row">
          <button className="danger" onClick={() => void provoke("station_fire")}>
            Close station
          </button>
          <button onClick={() => void provoke("signal_box_failure")}>Signal box failure</button>
          <button onClick={onSection}>Section from here…</button>
        </div>
      </div>
    </section>
  );
}

function ControlPanel({ disruptions, overrides, picked, act, onCreated, protection, setProtection, placingLabel, onPlace, onCancelPlace, say }: { disruptions: Disruption[]; overrides: WeatherOverride[]; picked?: string; act: Act; onCreated: Created; protection: boolean; setProtection: (on: boolean) => void; placingLabel?: string; onPlace: (body: Record<string, unknown>, label: string) => void; onCancelPlace: () => void; say: (t: string) => void }) {
  const [types, setTypes] = useState<DType[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [typeId, setTypeId] = useState("overhead_line_fault");
  const EFFECTS: [string, string][] = [
    ["section_closure", "Section closed"],
    ["speed_restriction", "Speed restriction"],
    ["signal_failure", "Signal box failure"],
    ["station_closure", "Station closed"],
  ];
  const effectOf = (id: string) => types.find((t) => t.id === id)?.effect ?? "section_closure";
  const [from, setFrom] = useState<Station>();
  const [to, setTo] = useState<Station>();
  const [station, setStation] = useState<Station>();
  const [minutes, setMinutes] = useState<string>("");
  const [maxKmh, setMaxKmh] = useState("40");
  const [hold, setHold] = useState("8");
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState<(Station & { km: number })[]>();
  useEffect(() => {
    const onFrom = (e: globalThis.Event) => {
      const st = (e as CustomEvent<Station>).detail;
      setTypeId("overhead_line_fault");
      setFrom({ id: st.id, name: st.name, lon: 0, lat: 0 });
    };
    window.addEventListener("sbb-section-from", onFrom);
    return () => window.removeEventListener("sbb-section-from", onFrom);
  }, []);
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
    void api<{ presets: Preset[] }>("/control").then((g) => setPresets(g.presets));
  }, []);
  const type = types.find((t) => t.id === typeId);
  useEffect(() => setMinutes(type?.defaultMinutes ? String(type.defaultMinutes) : ""), [type]);
  const ready = type && (type.scope === "section" ? from && to : station);
  const submit = async () => {
    if (!type || !ready) return;
    setBusy(true);
    const scope = type.scope === "section" ? { kind: "section", from: from!.id, to: to!.id } : { kind: "station", station: station!.id };
    const params = type.effect === "speed_restriction" ? { maxKmh: Number(maxKmh) } : type.effect === "signal_failure" ? { holdMinutes: Number(hold) } : undefined;
    const r = await api<{ disruption: Disruption; incident: Incident | null }>("/disruptions", { method: "POST", json: { type: type.id, scope, minutes: minutes ? Number(minutes) : null, params, mark: true } }).catch((e) => (say(e.message), null));
    setBusy(false);
    onCreated(r);
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
    const r = await api<{ protection: boolean }>("/control/protection", { method: "POST", json: { on: want } }).catch((e) => (say(e.message), null));
    if (r) {
      setProtection(r.protection);
      say(r.protection ? "Train protection on: trains never run into each other" : "Train protection off: drivers only see what is ahead");
    } else setProtection(!want);
  };
  const live = disruptions.filter((d) => d.status === "active").sort((a, b) => b.startedAt - a.startedAt);
  const weatherLive = overrides.filter((o) => o.status === "active");
  const ended = disruptions.filter((d) => d.status !== "active").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 6);
  return (
    <>
      <h3>Network</h3>
      <div className="row">
        <label className="field">
          <span>What happens</span>
          <select value={effectOf(typeId)} onChange={(e) => setTypeId(types.find((t) => t.effect === e.target.value)?.id ?? typeId)}>
            {EFFECTS.filter(([e]) => types.some((t) => t.effect === e)).map(([e, label]) => (
              <option key={e} value={e}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {types.filter((t) => t.effect === effectOf(typeId)).length > 1 && (
          <label className="field">
            <span>Cause</span>
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types
                .filter((t) => t.effect === effectOf(typeId))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} ({t.reasonCode})
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
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
          <li key={o.id} data-kind="weather" data-id={o.id} className={picked === o.id ? "picked" : undefined}>
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
            <button onClick={() => act.endWeather(o.id)}>End</button>
          </li>
        ))}
        {live.map((d) => (
          <li key={d.id} data-status={d.status} data-id={d.id} className={picked === d.id ? "picked" : undefined}>
            <div>
              <b>{d.label}</b>
              <span>{d.where}</span>
              <small>
                since {hm(d.startedAt)}
                {d.endsAt ? ` · until ${hm(d.endsAt)}` : ""} · {d.affectedTrains.length} trains
              </small>
            </div>
            <button onClick={() => act.endDisruption(d.id)}>End</button>
          </li>
        ))}
        {ended.map((d) => (
          <li key={d.id} data-status={d.status}>
            <div>
              <b>{d.label}</b>
              <span>{d.where}</span>
              <small>ended {hm(d.endedAt)} · {d.affectedTrains.length} trains</small>
            </div>
            <button onClick={() => act.removeDisruption(d.id)}>Remove</button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Incidents({ incidents, alerts, picked, onUnmark, onCreated, say }: { incidents: Incident[]; alerts: RealAlert[]; picked?: string; onUnmark: (id: string) => void; onCreated: (i: Incident) => void; say: (t: string) => void }) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("major");
  const [station, setStation] = useState<Station>();
  const [description, setDescription] = useState("");
  const submit = async () => {
    const r = await api<Incident>("/incidents", { method: "POST", json: { title, severity, description, scope: station ? { kind: "station", station: station.id } : { kind: "network" } } }).catch((e) => (say(e.message), null));
    if (r) {
      onCreated(r);
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
      <h3>Incidents</h3>
      {!incidents.length && <p className="hint">None.</p>}
      <ul className="items">
        {[...incidents]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((i) => (
            <li key={i.id} data-severity={i.severity} data-id={i.id} className={picked === i.id ? "picked" : undefined}>
              <div>
                <b>{i.title}</b>
                <span>{i.where}</span>
                <small>
                  {i.severity} · {hm(i.createdAt)}
                  {i.source === "auto" ? " · automatic" : i.disruptionId ? " · from a provoked disruption" : ""}
                </small>
              </div>
              {i.source !== "auto" && <button onClick={() => onUnmark(i.id)}>Unmark</button>}
            </li>
          ))}
      </ul>
      <h3>Live from SBB</h3>
      {!alerts.length && <p className="hint">No current alerts on the railway.</p>}
      <ul className="items">
        {[...alerts]
          .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
          .map((a) => (
            <li key={a.id} data-severity={a.severity} data-id={a.id} className={picked === a.id ? "picked" : undefined}>
              <div>
                <b>{a.title}</b>
                {a.stations.length > 0 && <span>{a.stations.slice(0, 4).map((s) => s.name).join(", ")}{a.stations.length > 4 ? ` +${a.stations.length - 4}` : ""}</span>}
                <small>{[a.cause !== "unknown" && a.cause !== "other" ? a.cause : "", until(a), a.trains ? `${a.trains} train${a.trains > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}</small>
              </div>
            </li>
          ))}
      </ul>
    </>
  );
}
const rank = (a: RealAlert) => (a.severity === "major" ? 0 : a.severity === "minor" ? 1 : 2);
function until(a: RealAlert) {
  const now = Date.now();
  const p = a.activePeriods.find((x) => (x.start ?? 0) <= now && (x.end ?? Infinity) >= now) ?? a.activePeriods[0];
  if (!p?.end) return p?.start ? `since ${new Date(p.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
  const end = new Date(p.end);
  return end.toDateString() === new Date().toDateString() ? `until ${hm(p.end)}` : `until ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
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
          ["sbb-twin/v1/fleet", "all trains, 1 message per second"],
          ["sbb-twin/v1/trains/+/position", "one train per message, every second"],
          ["sbb-twin/v1/trains/+/info", "line, operator, stops and times (retained)"],
          ["sbb-twin/v1/incidents/+", "marked incidents (retained)"],
          ["sbb-twin/v1/weather/temperature-grid", "temperature map (retained)"],
          ["sbb-twin/v1/weather/snapshot", "MeteoSwiss stations (retained)"],
          ["sbb-twin/v1/status", "heartbeat (retained)"],
          ["sbb-twin/v1/detections/{team}/{id}", "yours to publish"],
        ].map(([t, d]) => (
          <li key={t}>
            <code>{t}</code>
            <small>{d}</small>
          </li>
        ))}
      </ul>
      <code className="block">{`const c = mqtt.connect("${url}")\nc.on("connect", () => c.subscribe("sbb-twin/v1/fleet"))\nc.on("message", (_, b) => console.log(JSON.parse(b).trains.length))`}</code>
    </>
  );
}

/** An arrow pointing north (rotated by the map to where the wind blows), as a signed-distance icon. */
function windArrow() {
  const n = 48;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.beginPath();
  g.moveTo(24, 3);
  g.lineTo(37, 21);
  g.lineTo(28, 19);
  g.lineTo(28, 45);
  g.lineTo(20, 45);
  g.lineTo(20, 19);
  g.lineTo(11, 21);
  g.closePath();
  g.fill();
  return { width: n, height: n, data: new Uint8Array(g.getImageData(0, 0, n, n).data.buffer) };
}
