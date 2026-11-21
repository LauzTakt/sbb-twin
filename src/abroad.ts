// A route along the railway between two points, over the Swiss network (BAV) joined to the railways abroad
// (OpenStreetMap), so a disruption on a section outside the network, or across the border, follows the track between its
// two stations instead of a straight line.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

type Graph = { lon: number[]; lat: number[]; adj: [number, number][][]; grid: Map<string, number[]> };
let graph: Graph | undefined | null;
const CELL = 0.01; // ~1 km grid for nearest-node search
const key = (lon: number, lat: number) => `${Math.round(lon * 2e4)}:${Math.round(lat * 2e4)}`; // ~5 m
const cellKey = (lon: number, lat: number) => `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
const km = (a: number, b: number, c: number, d: number) => Math.hypot((a - c) * 76, (b - d) * 111);

function build(): Graph | null {
  const files = ["network-lines.geojson", "abroad-lines.geojson"].map((f) => join(config.dataDir, f));
  if (!files.every(existsSync)) return null;
  const fcs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as { features: { geometry: { type: string; coordinates: number[][] | number[][][] } }[] });
  const ids = new Map<string, number>();
  const lon: number[] = [];
  const lat: number[] = [];
  const adj: [number, number][][] = [];
  const node = (p: number[]) => {
    const k = key(p[0], p[1]);
    let i = ids.get(k);
    if (i === undefined) {
      i = lon.length;
      ids.set(k, i);
      lon.push(p[0]);
      lat.push(p[1]);
      adj.push([]);
    }
    return i;
  };
  const ends: number[] = [];
  const swiss = new Set<number>();
  const abroadEnds: number[] = [];
  fcs.forEach((fc, which) => {
    for (const f of fc.features) {
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates as number[][]] : f.geometry.type === "MultiLineString" ? (f.geometry.coordinates as number[][][]) : [];
      for (const c of lines) {
        if (c.length < 2) continue;
        let prev = node(c[0]);
        ends.push(prev);
        if (which === 0) swiss.add(prev);
        else abroadEnds.push(prev);
        for (let i = 1; i < c.length; i++) {
          const cur = node(c[i]);
          if (which === 0) swiss.add(cur);
          if (cur !== prev) {
            const w = km(lon[prev], lat[prev], lon[cur], lat[cur]);
            adj[prev].push([cur, w]);
            adj[cur].push([prev, w]);
          }
          prev = cur;
        }
        ends.push(prev);
        if (which === 1) abroadEnds.push(prev);
      }
    }
  });
  const grid = new Map<string, number[]>();
  for (let i = 0; i < lon.length; i++) {
    const k = cellKey(lon[i], lat[i]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  // lines cut at tile borders do not share their end vertices exactly: join ends that are within ~60 m
  for (const e of ends) {
    const cx = Math.floor(lon[e] / CELL);
    const cy = Math.floor(lat[e] / CELL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const o of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (o === e) continue;
          const w = km(lon[e], lat[e], lon[o], lat[o]);
          if (w < 0.06 && !adj[e].some(([n]) => n === o)) {
            adj[e].push([o, w]);
            adj[o].push([e, w]);
          }
        }
  }
  // a foreign line that starts at the border: join it to the closest Swiss track (the cut keeps only a vertex of overlap)
  for (const e of abroadEnds) {
    const cx = Math.floor(lon[e] / CELL);
    const cy = Math.floor(lat[e] / CELL);
    let best = -1;
    let bd = 0.45;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const o of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (!swiss.has(o)) continue;
          const d = km(lon[e], lat[e], lon[o], lat[o]);
          if (d < bd) {
            bd = d;
            best = o;
          }
        }
    if (best >= 0) {
      adj[e].push([best, bd]);
      adj[best].push([e, bd]);
    }
  }
  return { lon, lat, adj, grid };
}

function nearest(g: Graph, lo: number, la: number, maxKm: number) {
  let best = -1;
  let bd = maxKm;
  const r = Math.ceil(maxKm / 1.0) + 1;
  const cx = Math.floor(lo / CELL);
  const cy = Math.floor(la / CELL);
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++)
      for (const i of g.grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const d = km(lo, la, g.lon[i], g.lat[i]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
  return best;
}

/** The foreign railway between two points as lon/lat pairs (null when none is close enough or connected). */
export function abroadRoute(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number[][] | null {
  if (graph === undefined) graph = build();
  const g = graph;
  if (!g) return null;
  const s = nearest(g, a.lon, a.lat, 4);
  const t = nearest(g, b.lon, b.lat, 4);
  if (s < 0 || t < 0) return null;
  const dist = new Map<number, number>([[s, 0]]);
  const prev = new Map<number, number>();
  const heap: [number, number][] = [[0, s]];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === t) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, w] of g.adj[u]) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        push([nd, v]);
      }
    }
  }
  if (!dist.has(t)) return null;
  const direct = km(a.lon, a.lat, b.lon, b.lat);
  if ((dist.get(t) ?? Infinity) > Math.max(direct * 3, direct + 15)) return null; // a detour that long is not this section
  const path: number[][] = [];
  for (let u: number | undefined = t; u !== undefined; u = prev.get(u)) path.push([Math.round(g.lon[u] * 1e5) / 1e5, Math.round(g.lat[u] * 1e5) / 1e5]);
  return path.reverse();
}
