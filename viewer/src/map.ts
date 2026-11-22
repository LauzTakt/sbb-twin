// The base map: swisstopo's light vector map, calm: the red rail, funicular and cable-car lines it draws are hidden
// (the twin draws its own network, and red means a disruption).
//
// Dark mode recolours this same map in place, never with a second style (setStyle reloads the tiles and flashes): every
// colour is set with setPaintProperty and MapLibre fades it over the switch. MapLibre only fades colours that do not
// depend on the feature, and swisstopo picks many per feature (["match", ["get", "class"], ...]: relief, glaciers,
// roads, some labels). Those layers are split once, when the style loads, into one layer per case with a fixed colour;
// the case's filter picks the same features the match did, so the light map looks exactly as before.
import type { Map as LibreMap, StyleSpecification } from "maplibre-gl";
import type { Theme } from "./theme";

const LIGHT = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
const HIDDEN = /^(tunnel_|l1_|l2_)?public_transport(_aerialway)?$/;

type Layer = StyleSpecification["layers"][number] & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };
/** Every swisstopo colour in both themes, to switch with setPaintProperty. */
let colours: { layer: string; prop: string; light: unknown; dark: unknown }[] = [];

export async function baseStyle(theme: Theme): Promise<StyleSpecification> {
  const style = (await fetch(LIGHT).then((r) => r.json())) as StyleSpecification;
  const layers: Layer[] = [];
  colours = [];
  for (const l of style.layers as Layer[]) {
    if (HIDDEN.test(l.id)) {
      layers.push({ ...l, layout: { ...(l.layout ?? {}), visibility: "none" } } as Layer);
      continue;
    }
    for (const part of split(l)) {
      layers.push(part);
      for (const [prop, light] of Object.entries(part.paint ?? {})) {
        if (!prop.endsWith("-color")) continue;
        const dark = recolour(light, role(part, prop));
        colours.push({ layer: part.id, prop, light, dark });
        if (theme === "dark") part.paint![prop] = dark;
      }
    }
  }
  style.layers = layers as StyleSpecification["layers"];
  return style;
}

/** The twin's own layers (App.tsx), in both themes. Red and orange (the disruptions) and sky (the picked one) never change. */
export const OWN = {
  light: { abroad: "#b7bcc4", halo: "#ffffff", track: "#646b77", casing: "#ffffff", dot: "rgba(255,255,255,0.9)", station: "#ffffff", ring: "#3b4350", label: "#212121", labelHalo: "rgba(255,255,255,0.95)" },
  dark: { abroad: "#4e555f", halo: "#1b1e22", track: "#9aa6b8", casing: "#1b1e22", dot: "rgba(27,30,34,0.9)", station: "#1b1e22", ring: "#d2d6db", label: "#f1f2f4", labelHalo: "rgba(23,25,28,0.95)" },
};
type Own = keyof (typeof OWN)["light"];
const TIERS = ["major", "medium", "minor"];
const OWN_PAINT: [string, string, Own][] = [
  ["rail-abroad", "line-color", "abroad"],
  ["network-halo", "line-color", "halo"],
  ["network", "line-color", "track"],
  ["section-casing", "line-color", "casing"],
  ["section-point", "circle-color", "dot"],
  ...TIERS.flatMap((t): [string, string, Own][] => [
    [`stations-${t}`, "circle-color", "station"],
    [`stations-${t}`, "circle-stroke-color", "ring"],
    [`station-labels-${t}`, "text-color", "label"],
    [`station-labels-${t}`, "text-halo-color", "labelHalo"],
  ]),
];

/** Recolour the whole map, fading over `ms` (0: at once). No tile is loaded or laid out again. */
export function setMapTheme(map: LibreMap, theme: Theme, ms: number) {
  const opts = { validate: false };
  const set = (layer: string, prop: string, value: unknown) => {
    if (!map.getLayer(layer)) return;
    map.setPaintProperty(layer, `${prop}-transition` as never, { duration: ms, delay: 0 } as never, opts);
    map.setPaintProperty(layer, prop as never, value as never, opts);
  };
  for (const c of colours) set(c.layer, c.prop, c[theme]);
  for (const [layer, prop, key] of OWN_PAINT) set(layer, prop, OWN[theme][key]);
}

// ---- one layer per case of the colour's ["match", ["get", key], ...] ----

type Key = string | number;
type Cond = { key: string; values: Key[] | null; all: Key[] }; // values null: none of `all` (the match's fallback)
type Case = { conds: Cond[]; values: unknown[] };
const MAX_CASES = 24;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const FEATURE = new Set(["get", "has", "properties", "feature-state", "geometry-type", "id", "line-progress", "accumulated"]);

/** Whether a paint value reads the feature: MapLibre cannot fade such a value. */
function readsFeature(e: unknown): boolean {
  if (Array.isArray(e)) return e[0] !== "literal" && (FEATURE.has(e[0] as string) || e.some(readsFeature));
  if (isObj(e)) return "property" in e || (Array.isArray(e.stops) && (e.stops as unknown[][]).some((s) => readsFeature(s[1])));
  return false;
}
function matchNodes(e: unknown, out: { key: string; node: unknown[] }[] = []) {
  if (Array.isArray(e)) {
    if (e[0] === "match" && Array.isArray(e[1]) && e[1][0] === "get" && e[1].length === 2 && typeof e[1][1] === "string") out.push({ key: e[1][1], node: e });
    if (e[0] !== "literal") for (const x of e) matchNodes(x, out);
  } else if (isObj(e) && Array.isArray(e.stops)) for (const s of e.stops as unknown[][]) matchNodes(s[1], out);
  return out;
}
/** The value with the given match nodes replaced by the branch the case takes (-1: the fallback). */
function pick(e: unknown, branch: Map<unknown[], number>): unknown {
  if (Array.isArray(e)) {
    const b = branch.get(e);
    if (b !== undefined) return pick(b < 0 ? e[e.length - 1] : e[3 + 2 * b], branch);
    return e[0] === "literal" ? e : e.map((x) => pick(x, branch));
  }
  if (isObj(e) && Array.isArray(e.stops)) return { ...e, stops: (e.stops as unknown[][]).map(([z, v]) => [z, pick(v, branch)]) };
  return e;
}
/** The cases of the values' matches, outermost key first; null when a colour reads the feature some other way. */
function cases(values: unknown[], conds: Cond[] = []): Case[] | null {
  const nodes = values.flatMap((v) => matchNodes(v));
  if (!nodes.length) return values.some(readsFeature) ? null : [{ conds, values }];
  const key = nodes[0].key;
  const same = nodes.filter((n) => n.key === key).map((n) => n.node);
  // for each value the matches name, the branch every match on this key takes: equal answers make one case
  const branches = new Map<Key, number[]>();
  same.forEach((node, i) => {
    for (let b = 0; 3 + 2 * b < node.length - 1; b++)
      for (const v of ([] as Key[]).concat(node[2 + 2 * b] as Key)) {
        if (!branches.has(v)) branches.set(v, same.map(() => -1));
        const s = branches.get(v)!;
        if (s[i] < 0) s[i] = b;
      }
  });
  const groups = new Map<string, Key[]>();
  for (const [v, s] of branches) groups.set(s.join(), [...(groups.get(s.join()) ?? []), v]);
  const all = [...branches.keys()];
  const out: Case[] = [];
  for (const [s, group] of [...groups, [same.map(() => -1).join(), null] as const]) {
    const b = s.split(",").map(Number);
    const sub = cases(values.map((v) => pick(v, new Map(same.map((node, i) => [node, b[i]])))), [...conds, { key, values: group, all }]);
    if (!sub || out.push(...sub) > MAX_CASES) return null;
  }
  return out;
}
/** Legacy or expression filter (MapLibre's own rule): the two syntaxes cannot be mixed in one filter. */
function syntax(f: unknown): "legacy" | "expression" | "neutral" {
  if (typeof f === "boolean") return "neutral";
  if (!Array.isArray(f) || !f.length) return "legacy";
  switch (f[0]) {
    case "has":
      return f.length < 2 || f[1] === "$id" || f[1] === "$type" ? "legacy" : f.length === 2 ? "neutral" : "expression";
    case "in":
      return f.length >= 3 && (typeof f[1] !== "string" || Array.isArray(f[2])) ? "expression" : "legacy";
    case "!in":
    case "!has":
    case "none":
      return "legacy";
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return f.length !== 3 || Array.isArray(f[1]) || Array.isArray(f[2]) ? "expression" : "legacy";
    case "any":
    case "all": {
      let legacy = false;
      for (const c of f.slice(1)) {
        const k = syntax(c);
        if (k === "expression") return "expression";
        if (k === "legacy") legacy = true;
      }
      return legacy ? "legacy" : "neutral";
    }
    default:
      return "expression";
  }
}
/** One layer per case: the original filter and the case's conditions, in the original's syntax. */
function split(l: Layer): Layer[] {
  const paint = l.paint ?? {};
  const props = Object.keys(paint).filter((p) => p.endsWith("-color") && readsFeature(paint[p]));
  if (!props.length || l.layout?.visibility === "none") return [l];
  const found = cases(props.map((p) => paint[p]));
  const legacy = l.filter !== undefined && syntax(l.filter) === "legacy";
  // an expression match needs labels of one type; when that or the split fails, the layer stays (its colours switch without a fade)
  if (!found || found.length < 2 || (!legacy && found.some((c) => c.conds.some((k) => new Set(k.all.map((v) => typeof v)).size > 1)))) return [l];
  const cond = (c: Cond) =>
    legacy ? (c.values ? ["in", c.key, ...c.values] : ["!in", c.key, ...c.all]) : c.values ? ["match", ["get", c.key], c.values, true, false] : ["match", ["get", c.key], c.all, false, true];
  // Areas can overlap (the relief bands are nested, drawn lightest first in the tiles): lighter cases go below.
  if (l.type === "fill") found.sort((a, b) => lightness(b.values[0]) - lightness(a.values[0]));
  return found.map((c, i) => ({
    ...l,
    id: `${l.id}~${i}`,
    filter: ["all", ...(l.filter === undefined ? [] : [l.filter]), ...c.conds.map(cond)],
    paint: { ...paint, ...Object.fromEntries(props.map((p, j) => [p, c.values[j]])) },
  })) as Layer[];
}

// ---- the dark colours, derived from the light ones ----

type Role = "keep" | "background" | "area" | "relief" | "casing" | "road" | "line" | "text" | "halo";
function role(l: Layer, prop: string): Role {
  const id = l.id.replace(/~\d+$/, "");
  if (l.type === "background") return "background";
  if (prop.endsWith("halo-color")) return "halo";
  if (prop === "text-color" || prop === "icon-color") return "text";
  if (id === "hillshade_yellow") return "keep"; // a 2 % sunny tint
  if (/^(hillshade|hachure)/.test(id)) return "relief";
  if (l.type === "fill") return "area";
  if (/road_casing$/.test(id)) return "casing";
  if (/^(road|l1|l2)_fill$/.test(id)) return "road";
  return "line";
}

type RGBA = [number, number, number, number];
function parse(s: string): RGBA | undefined {
  const t = s.trim().toLowerCase();
  if (t[0] === "#") {
    const h = t.length <= 5 ? [...t.slice(1)].map((c) => c + c).join("") : t.slice(1);
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return undefined;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const m = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(t);
  if (!m) return undefined;
  const p = m[2].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v)));
  if (p.length < 3 || p.some(Number.isNaN)) return undefined;
  if (m[1] === "rgb") return [p[0], p[1], p[2], p[3] ?? 1];
  const [h, sat, light] = p;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4), p[3] ?? 1];
}
// OKLab: lightness changes keep the hue, so water stays blue and woods green
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
function toLab([r, g, b]: RGBA) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const PAPER = toLab([252, 252, 252, 1])[0]; // the light map's background
const NIGHT = toLab([27, 30, 34, 1])[0]; // the dark one (#1b1e22), a shade off the page's #17191c
/**
 * Areas and halos stay just below the background (water and relief a little darker, as on the light map), casings
 * darker still; roads, lines and labels turn light on the dark ground. Hue is kept, chroma calmed.
 */
function darkColour(c: RGBA, r: Role): RGBA {
  const [L, a, b] = toLab(c);
  const [l, k] =
    r === "background" ? [NIGHT, 1]
    : r === "area" || r === "halo" ? [NIGHT - 0.6 * (PAPER - L), 0.8]
    : r === "relief" ? [NIGHT - 0.45 * (PAPER - L), 0.5]
    : r === "casing" ? [NIGHT - 0.08, 0.5]
    : r === "road" ? [NIGHT + 0.18 * Math.max(0, (L - 0.5) / 0.5), 0.6]
    : r === "line" ? [Math.min(0.72, NIGHT + 0.04 + 0.6 * (1 - L)), 0.8]
    : r === "text" ? [Math.max(0.72, 0.98 - 0.32 * L), 1]
    : [L, 1];
  return [...fromLab(Math.min(1, Math.max(0, l)), a * k, b * k), c[3]];
}
/** OKLab lightness of the first colour in a paint value. */
function lightness(v: unknown): number {
  const first = (x: unknown): RGBA | undefined =>
    typeof x === "string" ? parse(x)
    : Array.isArray(x) ? x.reduce<RGBA | undefined>((c, y) => c ?? first(y), undefined)
    : isObj(x) && Array.isArray(x.stops) ? (x.stops as unknown[][]).reduce<RGBA | undefined>((c, s) => c ?? first(s[1]), undefined)
    : undefined;
  const c = first(v);
  return c ? toLab(c)[0] : 0;
}
const fmt = ([r, g, b, a]: RGBA) =>`rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
/** The dark version of a paint value: every colour literal in it, match labels left alone. */
function recolour(value: unknown, r: Role): unknown {
  if (r === "keep") return value;
  if (typeof value === "string") {
    const c = parse(value);
    return c ? fmt(darkColour(c, r)) : value;
  }
  if (Array.isArray(value)) {
    if (value[0] === "literal") return value;
    if (value[0] === "match") return value.map((x, i) => (i >= 2 && i < value.length - 1 && i % 2 === 0 ? x : recolour(x, r)));
    return value.map((x) => recolour(x, r));
  }
  if (isObj(value) && Array.isArray(value.stops)) return { ...value, stops: (value.stops as unknown[][]).map(([z, v]) => [z, recolour(v, r)]) };
  return value;
}
