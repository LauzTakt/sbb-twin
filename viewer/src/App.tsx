import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";
import { CircleDot, Crosshair, Monitor, Moon, Plus, RefreshCcw, Sun, TrainFront, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, connectLive, send, type Disruption, type Item, type Live, type SnapshotRow, type Status } from "./feed";
import { Control } from "./Control";
import { baseStyle, OWN, setMapTheme } from "./map";
import { applyPageTheme, onSystemThemeChange, readPref, resolveTheme, savePref, shownTheme, switchMs, systemTheme, type Pref, type Theme } from "./theme";
import { TrainCanvas } from "./trains";

(maplibregl as unknown as { setWorkerUrl?: (u: string) => void }).setWorkerUrl?.(workerUrl);

type FC = { type: "FeatureCollection"; features: { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };
type Pos = { speedKmh: number; motion: string; delaySec: number; line: string; category: string; headsign: string; atStop: { name: string } | null; nextStop: { name: string } | null };
type Call = { name: string; plannedArr: number | null; plannedDep: number | null; expectedArr: number | null; expectedDep: number | null; skipped: boolean };
type Info = { number: string | null; operator: string | null; status: string; origin: { name: string }; destination: { name: string }; calls: Call[] };
type BoardRow = { trainId: string | null; line: string; headsign: string; planned: number; expected: number; delayMin: number; cancelled: boolean };

const hm = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "");
const COLOUR = { critical: "#eb0000", major: "#eb0000", minor: "#f27e00", info: "#0079c7" } as const;
const BOUNDS: [[number, number], [number, number]] = [[5.4, 45.55], [11.0, 48.05]];

/** Rough length of a geometry in km, so the smallest disruption under the cursor wins the click. */
function extent(g: Item["geometry"]): number {
  if (!g || g.type === "Point" || g.type === "MultiPoint") return 0;
  const lines = (g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : []) as number[][][];
  let km = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) km += Math.hypot((l[i][0] - l[i - 1][0]) * 76, (l[i][1] - l[i - 1][1]) * 111);
  return km;
}
function points(g: Item["geometry"]): number[][] {
  if (!g) return [];
  const c = g.coordinates as number[] & number[][] & number[][][];
  return g.type === "Point" ? [c] : g.type === "MultiPoint" || g.type === "LineString" ? c : g.type === "MultiLineString" ? c.flat() : [];
}

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | undefined>(undefined);
  const layer = useRef<TrainCanvas | undefined>(undefined);
  const live = useRef<Live | undefined>(undefined);
  const rowsRef = useRef<SnapshotRow[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const pickedId = useRef<string | undefined>(undefined);
  const pickedRef = useRef<Item | undefined>(undefined);
  const near = useRef<{ id: string; ids: Set<string> } | undefined>(undefined);
  const features = useRef<FC>({ type: "FeatureCollection", features: [] });
  const [conn, setConn] = useState<"connecting" | "online" | "offline">("connecting");
  const [status, setStatus] = useState<Status>();
  const [alertItems, setItems] = useState<Item[]>([]);
  const [disruptions, setDisruptions] = useState<Disruption[]>([]);
  const [tab, setTab] = useState<"disruptions" | "bulletins">("disruptions");
  const [registering, setRegistering] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [picked, setPicked] = useState<string>();
  pickedId.current = picked;
  const [selected, setSelected] = useState<string | undefined>(() => new URLSearchParams(location.search).get("train") ?? undefined);
  const [following, setFollowing] = useState(false);
  const [station, setStation] = useState<{ id: string; name: string; trains: number }>();
  const [ready, setReady] = useState(false);
  const [pref, setPref] = useState<Pref>(readPref);
  const [theme, setTheme] = useState<Theme>(shownTheme);
  const themeRef = useRef(theme);
  const mapLoaded = useRef(false);
  const own: Item[] = disruptions.filter((d) => d.status === "active" && d.geometry).map((d) => ({ id: d.id, title: d.summary ?? d.label ?? "Disruption", where: d.where, severity: d.effect === "limited" ? "minor" : "major", note: d.cause?.label ?? "registered in the twin", trains: 0, geometry: d.geometry, description: d.description, source: "auto" as const }));
  const items = [...own, ...alertItems];
  itemsRef.current = items;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const m = new maplibregl.Map({ container: mapEl.current!, style: await baseStyle(themeRef.current), center: [8.2, 46.8], zoom: 7.3, maxBounds: BOUNDS, renderWorldCopies: false, maxPitch: 0, dragRotate: false, attributionControl: { compact: true } });
      if (!alive) return m.remove();
      m.touchZoomRotate.disableRotation();
      mapRef.current = m;
      (window as unknown as { railMap?: LibreMap }).railMap = m; // handy for debugging
      layer.current = new TrainCanvas(m);
      layer.current.setTheme(themeRef.current, 0);
      setReady(true);
      m.on("load", () => {
        addLayers(m);
        mapLoaded.current = true;
        setMapTheme(m, themeRef.current, 0); // in case the theme changed while the map was loading
      });
      m.on("click", (e) => {
        const id = layer.current?.hit(e.point.x, e.point.y);
        if (id) return setSelected(id), setStation(undefined), setPicked(undefined);
        const box: [[number, number], [number, number]] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
        const hit = m
          .queryRenderedFeatures(box, { layers: ["section-line", "section-point"].filter((l) => m.getLayer(l)) })
          .filter((f) => f.properties?.id)
          .sort((a, b) => Number(a.properties.size) - Number(b.properties.size))[0];
        if (hit) return setPicked(String(hit.properties.id)), setSelected(undefined), setStation(undefined);
        const st = m.queryRenderedFeatures(box, { layers: ["stations-major", "stations-medium", "stations-minor"].filter((l) => m.getLayer(l)) })[0];
        if (st) return setStation({ id: String(st.properties.id), name: String(st.properties.name), trains: Number(st.properties.trains) }), setSelected(undefined), setPicked(undefined);
        setPicked(undefined), setSelected(undefined), setStation(undefined), setFollowing(false);
      });
      m.on("dragstart", () => setFollowing(false));
      live.current = connectLive({
        connection: setConn,
        tick: (rows, st) => {
          layer.current?.update(rows);
          rowsRef.current = rows;
          refocus();
          setStatus(st);
        },
        items: setItems,
        disruptions: setDisruptions,
      });
    })();
    return () => {
      alive = false;
      live.current?.close();
      layer.current?.destroy();
      mapRef.current?.remove();
    };
  }, []);

  /** The trains involved in the picked disruption: the ones the server names, plus those running on or next to its track. */
  function refocus() {
    const item = pickedRef.current;
    if (!item) return void (layer.current && (layer.current.focus = undefined));
    const pts = points(item.geometry);
    const ids = new Set(item.trainIds ?? []);
    for (const r of rowsRef.current) {
      if (ids.has(r[0])) continue;
      for (const p of pts) {
        const dx = (r[2] - p[0]) * 76;
        const dy = (r[1] - p[1]) * 111;
        if (dx * dx + dy * dy < 2.25) {
          ids.add(r[0]);
          break;
        }
      }
    }
    near.current = { id: item.id, ids };
    if (layer.current) layer.current.focus = ids;
  }
  function addLayers(m: LibreMap) {
    const before = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
    const c = OWN[themeRef.current]; // setMapTheme switches these colours later
    const width = (a: number, b: number, c: number) => ["interpolate", ["linear"], ["zoom"], 6, a, 10, b, 14, c] as never;
    m.addSource("abroad", { type: "geojson", data: "/api/abroad.geojson", attribution: "© OpenStreetMap contributors" });
    m.addLayer({ id: "rail-abroad", type: "line", source: "abroad", layout: { "line-join": "round" }, paint: { "line-color": c.abroad, "line-width": width(0.5, 0.8, 1.4) } }, before);
    m.addSource("network", { type: "geojson", data: "/api/network.geojson" });
    m.addLayer({ id: "network-halo", type: "line", source: "network", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": c.halo, "line-width": width(1.6, 2.4, 4), "line-opacity": 0.85 } }, before);
    m.addLayer({ id: "network", type: "line", source: "network", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": c.track, "line-width": width(0.6, 1, 1.8) } }, before);
    // the disruptions: the affected track in red (interrupted) or orange (limited), with a casing in the ground's colour
    m.addSource("sections", { type: "geojson", data: features.current as never });
    const lines = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]] as never;
    const dots = ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]] as never;
    m.addLayer({ id: "section-picked", type: "line", source: "sections", filter: ["==", ["get", "id"], ""], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0079c7", "line-width": width(7, 9, 12), "line-opacity": 0.3 } }, before);
    m.addLayer({ id: "section-casing", type: "line", source: "sections", filter: lines, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.casing, "line-width": width(4, 5.5, 8) } }, before);
    m.addLayer({ id: "section-line", type: "line", source: "sections", filter: lines, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": width(2.2, 3, 4.6) } }, before);
    m.addLayer({ id: "section-point", type: "circle", source: "sections", filter: dots, paint: { "circle-radius": width(5, 7, 9), "circle-color": c.dot, "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 2.5 } }, before);
    m.addSource("stations", { type: "geojson", data: "/api/stations.geojson" });
    for (const [tier, filter, zoom, label] of [
      ["major", [">=", ["get", "trains"], 300], 6, 8],
      ["medium", ["all", ["<", ["get", "trains"], 300], [">=", ["get", "trains"], 60]], 9, 10.5],
      ["minor", ["<", ["get", "trains"], 60], 11, 12.5],
    ] as const) {
      m.addLayer({ id: `stations-${tier}`, type: "circle", source: "stations", minzoom: zoom, filter: filter as never, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.4, 12, 4], "circle-color": c.station, "circle-stroke-color": c.ring, "circle-stroke-width": 1.2 } });
      m.addLayer({ id: `station-labels-${tier}`, type: "symbol", source: "stations", minzoom: label, filter: filter as never, layout: { "text-field": ["get", "name"], "text-font": ["Frutiger Neue Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 13, 13], "text-anchor": "top", "text-offset": [0, 0.7], "text-padding": 4 }, paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.6 } });
    }
  }

  // the disruptions on the map
  useEffect(() => {
    features.current = {
      type: "FeatureCollection",
      features: items.filter((i) => i.geometry).map((i) => ({ type: "Feature" as const, properties: { id: i.id, colour: COLOUR[i.severity], size: extent(i.geometry) }, geometry: i.geometry as FC["features"][number]["geometry"] })),
    };
    (mapRef.current?.getSource("sections") as GeoJSONSource | undefined)?.setData(features.current as never);
  }, [items, ready]);
  // the picked disruption: highlighted, the map moves to it, the list scrolls to it
  useEffect(() => {
    const m = mapRef.current;
    if (m?.getLayer("section-picked")) m.setFilter("section-picked", ["all", ["==", ["get", "id"], picked ?? ""], ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]]] as never);
    const item = itemsRef.current.find((i) => i.id === picked);
    pickedRef.current = item;
    refocus();
    for (const l of ["section-line", "section-casing", "section-point"]) {
      const prop = l === "section-point" ? "circle-opacity" : "line-opacity";
      if (m?.getLayer(l)) m.setPaintProperty(l, prop, picked ? (["case", ["==", ["get", "id"], picked], 1, 0.22] as never) : 1);
    }
    if (m?.getLayer("section-point")) m.setPaintProperty("section-point", "circle-stroke-opacity", picked ? (["case", ["==", ["get", "id"], picked], 1, 0.22] as never) : 1);
    const pts = points(item?.geometry ?? null);
    if (!m || !item || !pts.length) return;
    const b = new maplibregl.LngLatBounds(pts[0] as [number, number], pts[0] as [number, number]);
    for (const p of pts) b.extend(p as [number, number]);
    m.fitBounds(b, { padding: { top: 90, bottom: 90, left: 90, right: 90 }, maxZoom: 12, duration: 700 });
    document.querySelector(`[data-id="${picked}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  // the list changed (a disruption was updated or ended): keep the focus on the picked one
  useEffect(() => {
    pickedRef.current = itemsRef.current.find((i) => i.id === pickedId.current);
    refocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertItems, disruptions]);
  // the theme: the remembered choice, or the system's (followed live)
  useEffect(() => {
    setTheme(resolveTheme(pref));
    if (pref === "system") return onSystemThemeChange(() => setTheme(systemTheme()));
  }, [pref]);
  // page, map and trains switch in the same frame and fade over the same time
  useEffect(() => {
    themeRef.current = theme;
    const ms = switchMs();
    applyPageTheme(theme, ms);
    if (mapRef.current && mapLoaded.current) setMapTheme(mapRef.current, theme, ms);
    layer.current?.setTheme(theme, ms);
  }, [theme]);
  useEffect(() => {
    if (!layer.current) return;
    layer.current.selected = selected;
    layer.current.following = following && Boolean(selected);
  }, [selected, following, ready]);

  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
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
        <div className="top">
        <div className="stats">
          <span>
            <b>{status?.trainsActive ?? "–"}</b> trains
          </span>
          <span>
            <b>{items.length}</b> {items.length === 1 ? "disruption" : "disruptions"}
          </span>
        </div>
        <button className="register" onClick={() => setRegistering(true)}>
          <Plus size={15} /> Register disruption
        </button>
        <button className="sync" disabled={syncing} onClick={() => { setSyncing(true); setPicked(undefined); void send("POST", "/control/reset", {}).catch(() => undefined).finally(() => setSyncing(false)); }} title="Remove everything registered in the twin and go back to the live data">
          <RefreshCcw size={15} /> {syncing ? "Syncing…" : "Sync with live"}
        </button>
        <div className="theme" role="group" aria-label="Colours">
          {([["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "Like the system"]] as const).map(([p, Icon, label]) => (
            <button key={p} aria-pressed={pref === p} title={label} aria-label={label} onClick={() => (savePref(p), setPref(p))}>
              <Icon size={15} />
            </button>
          ))}
        </div>
        </div>
      </header>
      {registering && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setRegistering(false)} onKeyDown={(e) => e.key === "Escape" && setRegistering(false)}>
          <div className="modal" role="dialog" aria-label="Register a disruption">
            <header>
              <h2>Register a disruption</h2>
              <button className="icon" onClick={() => setRegistering(false)} aria-label="Close">
                <X size={20} />
              </button>
            </header>
            <Control disruptions={disruptions} onClose={() => setRegistering(false)} />
          </div>
        </div>
      )}
      <main>
        <div ref={mapEl} className="map" />
        {selected && live.current && <TrainCard key={selected} id={selected} live={live.current} following={following} onFollow={() => setFollowing((f) => !f)} onClose={() => (setSelected(undefined), setFollowing(false))} />}
        {station && <StationCard key={station.id} station={station} onTrain={(id) => (setSelected(id), setStation(undefined))} onClose={() => setStation(undefined)} />}
        <aside className="side">
          <div className="tabs" role="tablist">
            <button aria-pressed={tab === "disruptions"} onClick={() => setTab("disruptions")}>Disruptions</button>
            <button aria-pressed={tab === "bulletins"} onClick={() => setTab("bulletins")}>Bulletins</button>
          </div>
          {tab === "bulletins" && (
            <ul className="items bulletins">
              {!sorted.some((i) => i.description) && <p className="hint">No bulletin for the current disruptions.</p>}
              {sorted.filter((i) => i.description).map((i) => (
                <li key={i.id} data-id={i.id} className={picked === i.id ? "picked" : undefined}>
                  <button onClick={() => (setPicked(i.id), setSelected(undefined), setStation(undefined))}>
                    <b style={{ ["--dot" as string]: COLOUR[i.severity] }}>{i.title}</b>
                    <p>{i.description}</p>
                    <small>{[i.note, i.source === "sbb" ? "published by SBB" : "twin"].filter(Boolean).join(" · ")}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tab === "disruptions" && <>
          {!sorted.length && <p className="hint">No disruption on the railway right now.</p>}
          <ul className="items">
            {sorted.map((i) => (
              <li key={i.id} data-id={i.id} className={picked === i.id ? "picked" : undefined}>
                <button onClick={() => (setPicked(i.id), setSelected(undefined), setStation(undefined))}>
                  <b style={{ ["--dot" as string]: COLOUR[i.severity] }}>{i.title}</b>
                  {i.where && <span>{i.where}</span>}
                  <small>{[i.note, i.trains ? `${i.trains} train${i.trains > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}</small>
                </button>
              </li>
            ))}
          </ul>
          </>}
          <div className="legend">
            <span><i style={{ background: "#00973b" }} />Moving</span>
            <span><i style={{ background: "#f27e00" }} />Late 3 min or more</span>
            <span><i style={{ background: "var(--train-station)" }} />At a station</span>
            <span><i style={{ background: "#eb0000" }} />Stopped on the line</span>
            <span><i className="line" style={{ background: "#eb0000" }} />Interrupted</span>
            <span><i className="line" style={{ background: "#f27e00" }} />Limited</span>
          </div>
        </aside>
      </main>
    </div>
  );
}
const rank = (i: Item) => (i.severity === "critical" || i.severity === "major" ? 0 : i.severity === "minor" ? 1 : 2);

function TrainCard({ id, live, following, onFollow, onClose }: { id: string; live: Live; following: boolean; onFollow: () => void; onClose: () => void }) {
  const [pos, setPos] = useState<Pos>();
  const [info, setInfo] = useState<Info>();
  useEffect(
    () =>
      live.watch(id, (p, i) => {
        if (p) setPos(p as unknown as Pos);
        if (i) setInfo(i as unknown as Info);
      }),
    [live, id],
  );
  const late = (pos?.delaySec ?? 0) >= 180;
  const ahead = info?.calls.filter((c) => c.expectedArr !== null || c.expectedDep !== null).slice(0, 6) ?? [];
  return (
    <section className="card" aria-label="Train">
      <header>
        <h3>
          <b>{pos?.line ?? "…"}</b> {pos?.headsign}
        </h3>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      <p className="sub">{[info?.operator, info?.number ? `train ${info.number}` : null, info ? `${info.origin.name} → ${info.destination.name}` : null].filter(Boolean).join(" · ")}</p>
      {pos && (
        <div className="facts">
          <div><b>{Math.round(pos.speedKmh)}</b><small>km/h</small></div>
          <div className={late ? "late" : ""}><b>{pos.delaySec >= 60 ? `+${Math.round(pos.delaySec / 60)}′` : "on time"}</b><small>delay</small></div>
          <div><b>{info?.status === "cancelled" ? "cancelled" : pos.motion === "moving" ? "moving" : pos.atStop ? "at station" : "stopped"}</b><small>{pos.atStop ? pos.atStop.name : pos.nextStop ? `to ${pos.nextStop.name}` : ""}</small></div>
        </div>
      )}
      <ol className="calls">
        {ahead.map((c) => (
          <li key={`${c.name}-${c.plannedArr}`} className={c.skipped ? "skipped" : ""}>
            <time>{hm(c.expectedArr ?? c.expectedDep)}</time>
            <span>{c.name}</span>
            {c.skipped ? <em>no stop</em> : (c.expectedArr ?? 0) - (c.plannedArr ?? 0) >= 60_000 ? <em className="late">+{Math.round(((c.expectedArr ?? 0) - (c.plannedArr ?? 0)) / 60_000)}′</em> : <em />}
          </li>
        ))}
      </ol>
      <button className={`follow ${following ? "on" : ""}`} onClick={onFollow} aria-pressed={following}>
        <Crosshair size={15} /> {following ? "Following" : "Follow"}
      </button>
    </section>
  );
}

function StationCard({ station, onTrain, onClose }: { station: { id: string; name: string; trains: number }; onTrain: (id: string) => void; onClose: () => void }) {
  const [board, setBoard] = useState<BoardRow[]>();
  useEffect(() => {
    const load = () => void api<BoardRow[]>(`/stations/${station.id}/board`).then(setBoard).catch(() => setBoard([]));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [station.id]);
  return (
    <section className="card" aria-label="Station">
      <header>
        <h3>
          <CircleDot size={15} /> {station.name}
        </h3>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      <p className="sub">{station.trains} trains today</p>
      <ol className="calls board">
        {board === undefined && <li className="hint">Loading…</li>}
        {board?.length === 0 && <li className="hint">No departures in the next hour.</li>}
        {board?.map((r) => (
          <li key={`${r.line}-${r.planned}-${r.headsign}`} className={r.cancelled ? "skipped" : ""}>
            <time>{hm(r.planned)}</time>
            <span>{r.trainId ? <button className="linklike" onClick={() => onTrain(r.trainId!)}><b>{r.line}</b> {r.headsign}</button> : <><b>{r.line}</b> {r.headsign}</>}</span>
            {r.cancelled ? <em className="late">cancelled</em> : r.delayMin > 0 ? <em className="late">+{r.delayMin}′</em> : <em />}
          </li>
        ))}
      </ol>
    </section>
  );
}
