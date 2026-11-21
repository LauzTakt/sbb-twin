// The base map: swisstopo's light vector map, calm: the red rail, funicular and cable-car lines it draws are hidden
// (the twin draws its own network, and red means a disruption).
import type { StyleSpecification } from "maplibre-gl";

const LIGHT = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
const HIDDEN = /^(tunnel_|l1_|l2_)?public_transport(_aerialway)?$/;

export async function baseStyle(): Promise<StyleSpecification> {
  const style = (await fetch(LIGHT).then((r) => r.json())) as StyleSpecification;
  for (const l of style.layers) if (HIDDEN.test(l.id)) l.layout = { ...(l.layout ?? {}), visibility: "none" } as never;
  return style;
}
