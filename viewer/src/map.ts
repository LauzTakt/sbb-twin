// One base style for the whole session (swisstopo light vector map + SWISSIMAGE satellite layer).
// Switching satellite fades a raster layer; switching light/dark recolours the vector layers in place.
// Nothing reloads, so overlays and trains stay put and the change is smooth.
import type { LayerSpecification, Map as LibreMap, StyleSpecification } from "maplibre-gl";

const LIGHT = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
// swisstopo's colour base map: the same layers in colour (forests, meadows, water, roads). Used for the 3D world.
const COLOUR = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json";
let colourPaint = new Map<string, Record<string, unknown>>();
let colourLoad: Promise<void> | undefined;
/** Loads the colour palette once (only its colours and opacities: shapes and widths stay the grey map's). */
export function loadColour() {
  colourLoad ??= fetch(COLOUR)
    .then((r) => r.json() as Promise<StyleSpecification>)
    .then((style) => {
      for (const l of style.layers) {
        if (l.type === "symbol" || l.type === "raster") continue;
        const paint = Object.fromEntries(Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {}).filter(([k]) => /-(color|opacity)$/.test(k) && k !== "fill-outline-color"));
        if (Object.keys(paint).length) colourPaint.set(l.id, paint);
      }
    })
    .catch(() => {
      colourLoad = undefined; // try again next time
    });
  return colourLoad;
}
export type Theme = "light" | "dark";

let original = new Map<string, Record<string, unknown>>(); // light paint of every base layer
let baseIds: string[] = [];

export async function baseStyle(): Promise<StyleSpecification> {
  const style = (await fetch(LIGHT).then((r) => r.json())) as StyleSpecification;
  original = new Map(style.layers.map((l) => [l.id, { ...((l as { paint?: Record<string, unknown> }).paint ?? {}) }]));
  baseIds = style.layers.map((l) => l.id);
  style.sources.swissimage = {
    type: "raster",
    tiles: ["https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"],
    tileSize: 256,
    maxzoom: 19,
    attribution: "© swisstopo",
  };
  // imagery above the map's areas and roads, below its labels
  const firstSymbol = style.layers.findIndex((l) => l.type === "symbol");
  style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, {
    id: "swissimage",
    type: "raster",
    source: "swissimage",
    layout: { visibility: "none" },
    paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 700, delay: 0 }, "raster-fade-duration": 300 },
  } as LayerSpecification);
  style.transition = { duration: 600, delay: 0 };
  return style;
}

function darkPaint(l: LayerSpecification): Record<string, unknown> {
  const id = l.id.toLowerCase();
  const water = /water|lake|river|see|fluss|gewaesser/.test(id);
  if (l.type === "background") return { "background-color": "#101418" };
  if (l.type === "fill") {
    // no outline colour: outlines also trace tile edges and draw a grid of lines over the map
    return { "fill-color": water ? "#0e2233" : /forest|wood|wald/.test(id) ? "#122019" : /building/.test(id) ? "#1d232b" : "#151a20" };
  }
  if (l.type === "line") return { "line-color": water ? "#16324a" : /boundary|border|grenze/.test(id) ? "#46505e" : /rail|bahn/.test(id) ? "#2c3440" : "#232a33" };
  if (l.type === "symbol") return { "text-color": water ? "#5d8bb0" : "#9aa3ae", "text-halo-color": "#101418", "text-halo-width": 1.2 };
  if (l.type === "raster" || l.type === "hillshade") return l.type === "raster" ? { "raster-opacity": 0.18 } : {};
  return {};
}

/** Recolour the base map for a theme and show or hide the satellite imagery. */
// The base map draws railways, funiculars and cable cars in red at high zoom. The twin draws its own rail network,
// and red means a disruption here: those base-map lines are hidden.
const HIDDEN = /^(tunnel_|l1_|l2_)?public_transport(_aerialway)?$/;

export function applyBase(map: LibreMap, theme: Theme, satellite: boolean, colour = false) {
  if (!map.getLayer("swissimage")) return; // style not ready (or replaced): nothing to recolour yet
  const style = map.getStyle();
  for (const l of style.layers) if (HIDDEN.test(l.id) && map.getLayoutProperty(l.id, "visibility") !== "none") map.setLayoutProperty(l.id, "visibility", "none");
  for (const l of style.layers) {
    if (!baseIds.includes(l.id)) continue;
    const base = original.get(l.id) ?? {};
    const dark = darkPaint(l);
    const tint = colour && theme === "light" ? (colourPaint.get(l.id) ?? {}) : {};
    const target: Record<string, unknown> = theme === "dark" ? { ...base, ...dark } : { ...base, ...tint };
    // back to the plain light map: properties only the dark theme or the colour map set go back to their defaults
    if (theme === "light") for (const k of [...Object.keys(dark), ...Object.keys(colourPaint.get(l.id) ?? {})]) if (!(k in base) && !(k in tint)) target[k] = undefined;
    for (const [k, v] of Object.entries(target)) {
      if (k.endsWith("-transition")) continue;
      try {
        map.setPaintProperty(l.id, k as never, v as never);
      } catch {
        /* property not valid for this layer type */
      }
    }
  }
  if (satellite) {
    map.setLayoutProperty("swissimage", "visibility", "visible");
    map.setPaintProperty("swissimage", "raster-opacity", theme === "dark" ? 0.8 : 1);
  } else {
    map.setPaintProperty("swissimage", "raster-opacity", 0);
    setTimeout(() => {
      if (map.getLayer("swissimage") && map.getPaintProperty("swissimage", "raster-opacity") === 0) map.setLayoutProperty("swissimage", "visibility", "none");
    }, 500);
  }
}
