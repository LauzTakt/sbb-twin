import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, ImageSource, Map as LibreMap } from "maplibre-gl";
import { Activity, CircleDot, Crosshair, Layers, Link2, Moon, Pause, RefreshCcw, Siren, Sun, TrainFront, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, brokerUrl, connectLive, type ControlState, type Live, type Disruption, type Event, type Incident, type Status } from "./feed";
import { applyBase, baseStyle, type Theme } from "./map";
import { COLOURS, TrainCanvas } from "./trains";

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
  const [simulated, setSimulated] = useState<Set<string>>(new Set());
  const [causes, setCauses] = useState<Record<string, string[]>>({}); // why a simulated train behaves as it does
  const [events, setEvents] = useState<Event[]>([]);
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
  const [picked, setPicked] = useState<{ kind: "disruption" | "incident"; id: string }>();
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
      // locked to Switzerland: zoom freely, never leave these bounds
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
        const id = layer.current?.hit(e.point.x, e.point.y);
        if (id) {
          setSelected(id);
          setStation(undefined);
          return;
        }
        // no train there: the smallest event under the cursor (a station before a section)
        const box: [[number, number], [number, number]] = [
          [e.point.x - 7, e.point.y - 7],
          [e.point.x + 7, e.point.y + 7],
        ];
        const layers = ["disruption-point", "disruption-line", "disruption-glow"].filter((l) => m.getLayer(l));
        const hit = m
          .queryRenderedFeatures(box, { layers })
          .filter((f) => f.properties?.id)
          .sort((a, b) => Number(a.properties.size) - Number(b.properties.size))[0];
        if (hit) {
          const kind = hit.properties.kind as "disruption" | "incident";
          setPicked({ kind, id: String(hit.properties.id) });
          setTab(kind === "incident" ? "incidents" : "control");
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
  const data = useRef({ disruptions: empty as FC });
  function addOverlays(m: LibreMap) {
    const d = data.current;
    // railways abroad (OpenStreetMap, prepared by tools/prepare_abroad.py), under the Swiss BAV network
    if (!m.getSource("abroad")) {
      m.addSource("abroad", { type: "geojson", data: "/api/abroad.geojson", attribution: "© OpenStreetMap contributors" });
      m.addLayer({ id: "rail-abroad-halo", type: "line", source: "abroad", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.2, 10, 3.4, 14, 5.6], "line-opacity": 0.8 } });
      m.addLayer({ id: "rail-abroad", type: "line", source: "abroad", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#767676", "line-width": ["interpolate", ["linear"], ["zoom"], 6, ["match", ["get", "usage"], "main", 0.9, 0.6], 10, ["match", ["get", "usage"], "main", 1.6, 1.1], 14, 2.6], "line-opacity": 0.85 } });
    }
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
    if (!m.getSource("disruptions")) {
      m.addSource("disruptions", { type: "geojson", data: d.disruptions as never });
      m.addLayer({ id: "disruption-glow", type: "line", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 18], "line-opacity": 0.3, "line-blur": 3 } });
      m.addLayer({ id: "disruption-line", type: "line", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3.5, 12, 6] } });
      m.addLayer({ id: "disruption-point", type: "circle", source: "disruptions", filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 3 } });
      m.addLayer({ id: "picked-line", type: "line", source: "disruptions", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0079c7", "line-width": 7, "line-opacity": 0.85 } });
      m.addLayer({ id: "picked-point", type: "circle", source: "disruptions", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 16, "circle-color": "rgba(0,121,199,0.15)", "circle-stroke-color": "#0079c7", "circle-stroke-width": 3 } });
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
    for (const tier of ["major", "medium", "minor"]) {
      if (!m.getLayer(`station-labels-${tier}`)) continue;
      m.setPaintProperty(`station-labels-${tier}`, "text-color", dark ? "#f1f2f4" : "#212121");
      m.setPaintProperty(`station-labels-${tier}`, "text-halo-color", dark ? "rgba(16,20,24,0.92)" : "rgba(255,255,255,0.95)");
      m.setPaintProperty(`stations-${tier}`, "circle-stroke-color", dark ? "#0b0e11" : "#212121");
    }
    if (layer.current) layer.current.theme = dark ? "dark" : "light";
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

  // the picked event: highlighted on the map, scrolled to in the list
  useEffect(() => {
    const m = mapRef.current;
    const id = picked?.id ?? "";
    for (const l of ["picked-line", "picked-point"]) if (m?.getLayer(l)) m.setFilter(l, ["==", ["get", "id"], id]);
    if (!picked) return;
    const t = setTimeout(() => document.querySelector(`[data-id="${picked.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => clearTimeout(t);
  }, [picked, tab]);

  // ---- creations show at once from the server's reply (MQTT confirms a moment later)
  const upsert = {
    disruption: (d?: Disruption | null) => d && setDisruptions((x) => ({ ...x, [d.id]: d })),
    incident: (i?: Incident | null) => i && setIncidents((x) => ({ ...x, [i.id]: i })),
  };
  const created: Created = (r) => {
    if (!r) return;
    upsert.disruption(r.disruption);
    upsert.incident(r.incident);
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
    setDisruptions({});
    setIncidents({});
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
              picked={picked?.id}
              act={act}
              onCreated={created}
              say={say}
            />
          )}
          {tab === "incidents" && <Incidents incidents={Object.values(incidents)} picked={picked?.id} onUnmark={act.unmark} onCreated={(i) => upsert.incident(i)} say={say} />}
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

function TrainCard({ id, client, simulated, mods, onEnd, onCreated, holds, onPick, following, onFollow, onClose, say }: { id: string; client: Live; simulated: boolean; mods: Disruption[]; onEnd: (id: string) => void; onCreated: Created; holds: { id: string; label: string }[]; onPick: (id: string) => void; following: boolean; onFollow: () => void; onClose: () => void; say: (t: string) => void }) {
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

const NETWORK_TYPES = (t: DType) => t.scope === "section" || t.scope === "station";

type Act = { endDisruption: (id: string) => void; removeDisruption: (id: string) => void; unmark: (id: string) => void };
type Created = (r: { disruption?: Disruption; incident?: Incident | null; consequences?: Disruption[] } | null) => void;
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

function ControlPanel({ disruptions, picked, act, onCreated, say }: { disruptions: Disruption[]; picked?: string; act: Act; onCreated: Created; say: (t: string) => void }) {
  const [types, setTypes] = useState<DType[]>([]);
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
  useEffect(() => {
    void api<DType[]>("/disruption-types").then((t) => setTypes(t.filter(NETWORK_TYPES)));
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
  const live = disruptions.filter((d) => d.status === "active").sort((a, b) => b.startedAt - a.startedAt);
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

      <h3>Active</h3>
      {!live.length && <p className="hint">Nothing changed: every train follows the real data.</p>}
      <ul className="items">
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

function Incidents({ incidents, picked, onUnmark, onCreated, say }: { incidents: Incident[]; picked?: string; onUnmark: (id: string) => void; onCreated: (i: Incident) => void; say: (t: string) => void }) {
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
          ["sbb-twin/v1/fleet", "all trains, 1 message per second"],
          ["sbb-twin/v1/trains/+/position", "one train per message, every second"],
          ["sbb-twin/v1/trains/+/info", "line, operator, stops and times (retained)"],
          ["sbb-twin/v1/incidents/+", "marked incidents (retained)"],
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
