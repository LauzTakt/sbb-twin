// The map side of the 3D mode: terrain relief, sky and fog, a soft hillshade for the drawn map, swisstopo buildings
// extruded to their real heights, and wider tracks so the network stays readable draped over the relief.
import type { ExpressionSpecification, LayerSpecification, Map as LibreMap, MapSourceDataEvent, RasterDEMSourceSpecification, SkySpecification } from "maplibre-gl";

export type Look = "light" | "dark" | "satellite";

export const IDS = { dem: "rail3d-dem", shade: "rail3d-shade", hillshade: "rail3d-hillshade", buildings: "rail3d-buildings", ownBase: "rail3d-base" };
export const EXAGGERATION = 1.3;
const BASE_TILES = "https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/tiles.json";

// Mapterhorn: open terrarium tiles built from swisstopo's swissALTI3D in Switzerland (metre-scale detail, keyless).
// AWS Terrarium (Mapzen) is the fallback: global and keyless, but ~30 m data that rounds off the Alps.
const DEMS: Record<"mapterhorn" | "terrarium", RasterDEMSourceSpecification> = {
  mapterhorn: { type: "raster-dem", tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"], encoding: "terrarium", tileSize: 512, maxzoom: 14, attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>' },
  terrarium: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: "Terrain © Mapzen, AWS" },
};

const SKY: Record<Look, SkySpecification> = {
  light: { "sky-color": "#a9c9e8", "horizon-color": "#f1f4f7", "fog-color": "#eef1f4", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.75, "fog-ground-blend": 0.3, "atmosphere-blend": 0 },
  dark: { "sky-color": "#0a111c", "horizon-color": "#1f2a38", "fog-color": "#151c25", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.75, "fog-ground-blend": 0.3, "atmosphere-blend": 0 },
  satellite: { "sky-color": "#7fa9d3", "horizon-color": "#dde6ee", "fog-color": "#cfd9e2", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.75, "fog-ground-blend": 0.4, "atmosphere-blend": 0 },
};
// light neutral buildings for the drawn map and satellite imagery, a muted slate on the dark map
const BUILDING: Record<Look, string> = { light: "#ebe8e3", dark: "#323b48", satellite: "#e9e5df" };
const SHADE: Record<Look, Record<string, unknown>> = {
  light: { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": "#3d4d5e", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5c6c7c" },
  dark: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#3a4a5e", "hillshade-accent-color": "#0b1016" },
  satellite: { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": "#3d4d5e", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5c6c7c" },
};
// the tracks a little wider than in 2D: draped on steep relief and seen at a slant they read thinner
const NETWORK_WIDTH: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 6, 1, 10, 2, 14, 3.4, 17, 5.5];

type MapState = { dem: keyof typeof DEMS; demErrors: number; demLoaded: number; listening: boolean; sky?: SkySpecification; networkWidth?: unknown; look?: Look; onError: (e: unknown) => void; onData: (e: MapSourceDataEvent) => void };
const states = new WeakMap<LibreMap, MapState>();

/** Light, dark or satellite, read from the base map (the swissimage raster layer) and the trains' theme. */
export function lookOf(map: LibreMap, theme: "light" | "dark"): Look {
  if (map.getLayer("swissimage") && map.getLayoutProperty("swissimage", "visibility") === "visible" && Number(map.getPaintProperty("swissimage", "raster-opacity") ?? 1) > 0) return "satellite";
  return theme;
}

/** Whether the style can take new sources and layers now (it may still be loading tiles; that is fine). */
export function styleReady(map: LibreMap) {
  return Boolean((map as unknown as { style?: { _loaded?: boolean } }).style?._loaded);
}

function firstSymbol(map: LibreMap) {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

/** The vector source carrying swisstopo's base map (buildings with heights): the base style's, or our own. */
function baseSource(map: LibreMap) {
  const sources = map.getStyle().sources;
  for (const [id, s] of Object.entries(sources)) if (s.type === "vector" && "url" in s && String(s.url).includes("ch.swisstopo.base.vt")) return id;
  if (!map.getSource(IDS.ownBase)) map.addSource(IDS.ownBase, { type: "vector", url: BASE_TILES, attribution: "© swisstopo" });
  return IDS.ownBase;
}

function addDem(map: LibreMap, st: MapState) {
  if (!map.getSource(IDS.dem)) map.addSource(IDS.dem, { ...DEMS[st.dem] });
  if (!map.getSource(IDS.shade)) map.addSource(IDS.shade, { ...DEMS[st.dem] });
  if (map.getTerrain()?.source !== IDS.dem) map.setTerrain({ source: IDS.dem, exaggeration: EXAGGERATION });
}

/** Adds everything the 3D map needs. Idempotent: what is already there stays. */
export function add3DStyle(map: LibreMap, look: Look) {
  let st = states.get(map);
  if (!st) {
    const fresh: MapState = {
      dem: "mapterhorn",
      demErrors: 0,
      demLoaded: 0,
      listening: false,
      onError: (e) => {
        const source = (e as { sourceId?: string }).sourceId;
        if (source !== IDS.dem && source !== IDS.shade) return;
        // Mapterhorn unreachable (no tile ever loaded): switch to AWS Terrarium
        if (fresh.dem === "mapterhorn" && ++fresh.demErrors >= 4 && fresh.demLoaded === 0) {
          fresh.dem = "terrarium";
          console.warn("[3d] Mapterhorn terrain unavailable, using AWS Terrarium");
          removeDem(map);
          addDem(map, fresh);
          addHillshade(map, fresh.look ?? "light");
        }
      },
      onData: (e) => {
        if ((e.sourceId === IDS.dem || e.sourceId === IDS.shade) && e.tile) fresh.demLoaded++;
      },
    };
    st = fresh;
    states.set(map, st);
  }
  if (!st.listening) {
    map.on("error", st.onError);
    map.on("sourcedata", st.onData);
    st.listening = true;
    st.sky = map.getSky();
  }
  addDem(map, st);
  addHillshade(map, look);
  if (!map.getLayer(IDS.buildings)) {
    map.addLayer(
      {
        id: IDS.buildings,
        type: "fill-extrusion",
        source: baseSource(map),
        "source-layer": "building",
        minzoom: 13,
        // open station roofs would bury the platforms (and the trains at them): only real buildings rise
        filter: ["!=", ["get", "class"], "roof"],
        paint: {
          "fill-extrusion-color": BUILDING[look],
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, ["coalesce", ["get", "render_height"], 0]],
          "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, ["coalesce", ["get", "render_min_height"], 0]],
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 13.8, 0.92],
          "fill-extrusion-vertical-gradient": true,
        },
      } as LayerSpecification,
      firstSymbol(map),
    );
  }
  map.setSky(SKY[look]);
  widenNetwork(map);
  st.look = look;
}

function addHillshade(map: LibreMap, look: Look) {
  if (map.getLayer(IDS.hillshade) || !map.getSource(IDS.shade)) return;
  // under the satellite imagery, so it only shades the drawn (light or dark) map
  const before = map.getLayer("swissimage") ? "swissimage" : firstSymbol(map);
  map.addLayer({ id: IDS.hillshade, type: "hillshade", source: IDS.shade, paint: { ...SHADE[look], "hillshade-illumination-direction": 315, "hillshade-illumination-anchor": "map" } } as LayerSpecification, before);
}

/** Recolours what depends on the look (after a light/dark/satellite switch made in place). */
export function restyle3D(map: LibreMap, look: Look) {
  const st = states.get(map);
  if (!st || st.look === look) return;
  st.look = look;
  if (map.getLayer(IDS.buildings)) map.setPaintProperty(IDS.buildings, "fill-extrusion-color", BUILDING[look]);
  if (map.getLayer(IDS.hillshade)) for (const [k, v] of Object.entries(SHADE[look])) map.setPaintProperty(IDS.hillshade, k as never, v as never);
  map.setSky(SKY[look]);
}

/** Keeps the tracks wide while 3D is on (the App may add the network layer after us). */
export function widenNetwork(map: LibreMap) {
  const st = states.get(map);
  if (!st || !map.getLayer("network")) return;
  const now = map.getPaintProperty("network", "line-width");
  if (JSON.stringify(now) === JSON.stringify(NETWORK_WIDTH)) return;
  st.networkWidth = now;
  map.setPaintProperty("network", "line-width", NETWORK_WIDTH);
}

function removeDem(map: LibreMap) {
  if (map.getTerrain()) map.setTerrain(null);
  if (map.getLayer(IDS.hillshade)) map.removeLayer(IDS.hillshade);
  for (const id of [IDS.dem, IDS.shade]) if (map.getSource(id)) map.removeSource(id);
}

/** Removes everything add3DStyle added and gives the tracks and the sky back their 2D look. */
export function remove3DStyle(map: LibreMap) {
  const st = states.get(map);
  removeDem(map);
  if (map.getLayer(IDS.buildings)) map.removeLayer(IDS.buildings);
  if (map.getSource(IDS.ownBase)) map.removeSource(IDS.ownBase);
  if (!st) return;
  map.off("error", st.onError);
  map.off("sourcedata", st.onData);
  st.listening = false;
  map.setSky(st.sky ?? {});
  st.sky = undefined;
  if (st.networkWidth !== undefined && map.getLayer("network")) map.setPaintProperty("network", "line-width", st.networkWidth as never);
  st.networkWidth = undefined;
  st.look = undefined;
}
