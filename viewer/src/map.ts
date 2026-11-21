// One base style for the whole session (swisstopo light vector map + SWISSIMAGE satellite layer).
// Switching satellite fades a raster layer; switching light/dark recolours the vector layers in place.
// Nothing reloads, so overlays and trains stay put and the change is smooth.
import type { LayerSpecification, Map as LibreMap, StyleSpecification } from "maplibre-gl";

const LIGHT = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
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
export function applyBase(map: LibreMap, theme: Theme, satellite: boolean) {
  if (!map.getLayer("swissimage")) return; // style not ready (or replaced): nothing to recolour yet
  const style = map.getStyle();
  for (const l of style.layers) {
    if (!baseIds.includes(l.id)) continue;
    const base = original.get(l.id) ?? {};
    const dark = darkPaint(l);
    const target: Record<string, unknown> = theme === "dark" ? { ...base, ...dark } : { ...base };
    // back to light: properties only the dark theme sets go back to their defaults
    if (theme === "light") for (const k of Object.keys(dark)) if (!(k in base)) target[k] = undefined;
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
