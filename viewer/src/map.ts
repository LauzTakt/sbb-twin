// Base maps (swisstopo, free): a dark "operations" recolouring of the light base map, the light map itself, and satellite.
import type { StyleSpecification, LayerSpecification } from "maplibre-gl";

const LIGHT = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
export type Basemap = "dark" | "light" | "satellite";

function darken(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((l): LayerSpecification => {
    const id = l.id.toLowerCase();
    const water = /water|lake|river|see|fluss|gewaesser/.test(id);
    if (l.type === "background") return { ...l, paint: { "background-color": "#0a0f17" } };
    if (l.type === "fill") {
      const colour = water ? "#0d2234" : /forest|wood|wald/.test(id) ? "#0e1914" : /building/.test(id) ? "#161d29" : "#0f151f";
      return { ...l, paint: { ...(l.paint ?? {}), "fill-color": colour, "fill-outline-color": colour, "fill-opacity": water ? 1 : 0.85 } } as LayerSpecification;
    }
    if (l.type === "line") {
      const colour = water ? "#12314a" : /boundary|border|grenze/.test(id) ? "#3a4659" : /rail|bahn/.test(id) ? "#26303f" : "#1b2330";
      return { ...l, paint: { ...(l.paint ?? {}), "line-color": colour } } as LayerSpecification;
    }
    if (l.type === "symbol") {
      const paint = { ...(l.paint ?? {}), "text-color": water ? "#4d7ea8" : "#8592a6", "text-halo-color": "#0a0f17", "text-halo-width": 1.2 };
      return { ...l, paint, layout: { ...(l.layout ?? {}), "icon-image": "" } } as LayerSpecification;
    }
    if (l.type === "raster" || l.type === "hillshade") return { ...l, paint: { ...(l.paint ?? {}), ...(l.type === "raster" ? { "raster-opacity": 0.15 } : {}) } } as LayerSpecification;
    return l;
  });
  return { ...style, layers };
}

let light: StyleSpecification | undefined;
export async function basemap(kind: Basemap): Promise<StyleSpecification> {
  light ??= (await fetch(LIGHT).then((r) => r.json())) as StyleSpecification;
  if (kind === "light") return light;
  if (kind === "dark") return darken(structuredClone(light));
  return {
    version: 8,
    glyphs: light.glyphs,
    sources: {
      swissimage: {
        type: "raster",
        tiles: ["https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© swisstopo",
      },
    },
    layers: [{ id: "swissimage", type: "raster", source: "swissimage", paint: { "raster-brightness-max": 0.85 } }],
  };
}
