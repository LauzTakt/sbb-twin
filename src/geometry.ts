// Track geometry: each leg between two consecutive stops follows the BAV rail network when a matched path
// exists (data/paths.json.gz, built by tools/prepare_network.py); otherwise a straight line (track "approx").
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Stop } from "./timetable.ts";

type Edge = [id: string, a: number, b: number, tracks: number, lengthM: number, coords: number[]];
type Network = { nodes: [string | null, string, number, number][]; edges: Edge[] };
export type Path = {
  coords: Float64Array; // lon,lat pairs
  cum: Float64Array; // metres from the start, per vertex
  len: number;
  segEdge: Int32Array; // per segment: signed edge ref (edge index + 1, negative when reversed), 0 = none
  bav: boolean;
  spans?: { ref: number; from: number; to: number }[];
};

let network: Network | undefined;
let paths: Record<string, [number, string, number[]]> = {};
const cache = new Map<string, Path>();
export const edgeIds = () => network?.edges.map((e) => e[0]) ?? [];
export const edgeTracks = (ref: number) => network?.edges[Math.abs(ref) - 1]?.[3] ?? 2;
export const edgeId = (ref: number) => (ref ? network?.edges[Math.abs(ref) - 1]?.[0] : undefined);

export function loadGeometry() {
  const n = join(config.dataDir, "network.json.gz");
  const p = join(config.dataDir, "paths.json.gz");
  if (existsSync(n) && existsSync(p)) {
    network = JSON.parse(gunzipSync(readFileSync(n)).toString());
    paths = JSON.parse(gunzipSync(readFileSync(p)).toString());
    cache.clear();
    return { edges: network!.edges.length, paths: Object.keys(paths).length };
  }
  return { edges: 0, paths: 0 };
}

const R = 6_371_008.8;
const rad = Math.PI / 180;
export function metres(lon1: number, lat1: number, lon2: number, lat2: number) {
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

function build(coords: number[], segEdge: number[], bav: boolean): Path {
  const n = coords.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + metres(coords[2 * i - 2], coords[2 * i - 1], coords[2 * i], coords[2 * i + 1]);
  return { coords: Float64Array.from(coords), cum, len: cum[n - 1] || 0, segEdge: Int32Array.from(segEdge), bav };
}

/** The track path from one stop to the next. */
export function pathBetween(a: Stop, b: Stop): Path {
  const key = `${a.id}>${b.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let path: Path | undefined;
  const entry = paths[key];
  if (network && entry) {
    const coords: number[] = [];
    const segEdge: number[] = [];
    for (const ref of entry[2]) {
      const e = network.edges[Math.abs(ref) - 1];
      if (!e) continue;
      const c = e[5];
      const pts: number[] = [];
      if (ref > 0) for (let i = 0; i < c.length; i += 2) pts.push(c[i], c[i + 1]);
      else for (let i = c.length - 2; i >= 0; i -= 2) pts.push(c[i], c[i + 1]);
      const start = coords.length && coords[coords.length - 2] === pts[0] && coords[coords.length - 1] === pts[1] ? 2 : 0;
      for (let i = start; i < pts.length; i += 2) {
        if (coords.length) segEdge.push(ref);
        coords.push(pts[i], pts[i + 1]);
      }
    }
    if (coords.length >= 4) path = build(coords, segEdge, true);
  }
  path ??= build([a.lon, a.lat, b.lon, b.lat], [0], false);
  cache.set(key, path);
  return path;
}

/** Position, bearing and track segment at a distance along a path. */
export function pointAt(path: Path, s: number) {
  const { coords, cum } = path;
  const n = cum.length;
  if (n < 2) return { lon: coords[0], lat: coords[1], bearing: 0, edge: 0 };
  const d = Math.max(0, Math.min(path.len, s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const f = (d - cum[lo]) / span;
  const x1 = coords[2 * lo], y1 = coords[2 * lo + 1], x2 = coords[2 * hi], y2 = coords[2 * hi + 1];
  const bearing = (Math.atan2((x2 - x1) * Math.cos(y1 * rad), y2 - y1) / rad + 360) % 360;
  return { lon: x1 + (x2 - x1) * f, lat: y1 + (y2 - y1) * f, bearing, edge: path.segEdge[lo] ?? 0 };
}

/** Signed edge refs along a path with their [start, end] distances. */
export function edgeSpans(path: Path) {
  if (path.spans) return path.spans;
  const spans: { ref: number; from: number; to: number }[] = [];
  for (let i = 0; i < path.segEdge.length; i++) {
    const ref = path.segEdge[i];
    const last = spans.at(-1);
    if (last && last.ref === ref) last.to = path.cum[i + 1];
    else spans.push({ ref, from: path.cum[i], to: path.cum[i + 1] });
  }
  path.spans = spans;
  return spans;
}

/** Edge refs (unsigned, index + 1) of the track between two stations: a matched timetable path, else the
 * shortest path over the network graph (any two stations on the same network can bound a section). */
export function sectionEdges(a: Stop, b: Stop): Set<number> {
  const entry = paths[`${a.id}>${b.id}`] ?? paths[`${b.id}>${a.id}`];
  if (entry) return new Set(entry[2].map((r) => Math.abs(r)));
  return new Set(route(a.id, b.id));
}
let adjacency: Map<number, [number, number, number][]> | undefined; // node -> [next node, edge ref (unsigned), length]
let nodeOf: Map<string, number> | undefined;
function route(fromId: string, toId: string): number[] {
  if (!network) return [];
  if (!adjacency || !nodeOf) {
    adjacency = new Map();
    nodeOf = new Map();
    network.nodes.forEach((n, i) => n[0] && nodeOf!.set(n[0], i));
    network.edges.forEach((e, i) => {
      for (const [x, y] of [[e[1], e[2]], [e[2], e[1]]]) {
        if (!adjacency!.has(x)) adjacency!.set(x, []);
        adjacency!.get(x)!.push([y, i + 1, e[4]]);
      }
    });
  }
  const s = nodeOf.get(fromId);
  const t = nodeOf.get(toId);
  if (s === undefined || t === undefined) return [];
  const dist = new Map([[s, 0]]);
  const prev = new Map<number, [number, number]>();
  const queue: [number, number][] = [[0, s]];
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[best][0]) best = i;
    const [d, u] = queue[best];
    queue[best] = queue[queue.length - 1];
    queue.pop();
    if (u === t) break;
    if (d > (dist.get(u) ?? Infinity) || d > 60_000) continue;
    for (const [v, ref, w] of adjacency.get(u) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, [u, ref]);
        queue.push([nd, v]);
      }
    }
  }
  const out: number[] = [];
  for (let v = t; prev.has(v); v = prev.get(v)![0]) out.push(prev.get(v)![1]);
  return out.reverse();
}

/** Edge refs (unsigned) of every track segment that passes within `radiusKm` of a point. */
export function edgesWithin(lat: number, lon: number, radiusKm: number): Set<number> {
  const out = new Set<number>();
  if (!network) return out;
  const r = radiusKm * 1000;
  network.edges.forEach((e, i) => {
    const c = e[5];
    for (let k = 0; k < c.length; k += 6) if (metres(lon, lat, c[k], c[k + 1]) <= r) return void out.add(i + 1);
  });
  return out;
}

/** Middle vertex of an edge (unsigned ref), for altitude checks. */
export function edgeMidpoint(ref: number): [number, number] | undefined {
  const e = network?.edges[Math.abs(ref) - 1];
  if (!e) return undefined;
  const k = Math.floor(e[5].length / 4) * 2;
  return [e[5][k], e[5][k + 1]];
}

/** GeoJSON geometry of a set of edges (for drawing an affected section). */
export function edgesGeometry(refs: Set<number>) {
  const lines: number[][][] = [];
  for (const ref of refs) {
    const e = network?.edges[Math.abs(ref) - 1];
    if (!e) continue;
    const line: number[][] = [];
    for (let i = 0; i < e[5].length; i += 2) if (i % 6 === 0 || i === e[5].length - 2) line.push([e[5][i], e[5][i + 1]]);
    lines.push(line);
  }
  return lines.length ? { type: "MultiLineString" as const, coordinates: lines } : null;
}

export function abroadGeoJson() {
  const f = join(config.dataDir, "abroad-lines.geojson");
  return existsSync(f) ? readFileSync(f, "utf8") : JSON.stringify({ type: "FeatureCollection", features: [] });
}

export function networkGeoJson() {
  const f = join(config.dataDir, "network-lines.geojson");
  return existsSync(f) ? readFileSync(f, "utf8") : JSON.stringify({ type: "FeatureCollection", features: [] });
}
