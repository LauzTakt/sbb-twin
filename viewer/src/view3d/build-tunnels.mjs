// Builds tunnels.json: the rail tunnels along the rail-twin network, from swisstopo's base vector tiles
// (transportation layer, class rail, brunnel tunnel) at zoom 11, kept only where they lie on the BAV network.
// The 3D view uses it to draw trains inside tunnels as ghosts instead of crawling over the mountain above.
// Run from the repo root: node viewer/src/view3d/build-tunnels.mjs [cacheDir]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "package.json"));
const { VectorTile } = await import(require.resolve("@mapbox/vector-tile"));
const { PbfReader } = await import(require.resolve("pbf"));
const cache = process.argv[2] ?? join(root, "node_modules/.cache/rail3d-tiles");
mkdirSync(cache, { recursive: true });

const Z = 11;
const R = 6371008.8;
const rad = Math.PI / 180;
const tileOf = (lon, lat) => {
  const n = 2 ** Z;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2) * n)];
};
const xy = (lon, lat, lat0) => [lon * rad * Math.cos(lat0 * rad) * R, lat * rad * R];

// 1. the network and the tiles it crosses
const net = JSON.parse(readFileSync(join(root, "data/network-lines.geojson"), "utf8"));
const lines = net.features.map((f) => f.geometry.coordinates);
const tiles = new Set();
for (const c of lines)
  for (let i = 1; i < c.length; i++) {
    const steps = Math.max(1, Math.ceil(Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]) / 0.002));
    for (let s = 0; s <= steps; s++) {
      const k = s / steps;
      tiles.add(tileOf(c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k).join("/"));
    }
  }
console.error(`${tiles.size} tiles at z${Z}`);

// 2. download (cached)
const list = [...tiles];
let done = 0;
async function get(key, attempt = 0) {
  const file = join(cache, `${Z}_${key.replace("/", "_")}.pbf`);
  if (existsSync(file)) return readFileSync(file);
  const host = `vectortiles${(done + attempt) % 5}.geo.admin.ch`;
  const r = await fetch(`https://${host}/tiles/ch.swisstopo.base.vt/v1.0.0/${Z}/${key}.pbf`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 204) return null;
    if (attempt < 3) return get(key, attempt + 1);
    throw new Error(`${key}: HTTP ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}
const bufs = new Map();
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (list.length) {
      const key = list.pop();
      bufs.set(key, await get(key));
      if (++done % 50 === 0) console.error(`${done}/${tiles.size}`);
    }
  }),
);

// 3. network segment grid (metres, local equirectangular) to keep only tunnels on the network
const LAT0 = 46.8;
const CELL = 500;
const grid = new Map();
const segs = [];
for (const c of lines)
  for (let i = 1; i < c.length; i++) {
    const a = xy(c[i - 1][0], c[i - 1][1], LAT0), b = xy(c[i][0], c[i][1], LAT0);
    const id = segs.push([a[0], a[1], b[0], b[1]]) - 1;
    for (let gx = Math.floor((Math.min(a[0], b[0]) - 60) / CELL); gx <= Math.floor((Math.max(a[0], b[0]) + 60) / CELL); gx++)
      for (let gy = Math.floor((Math.min(a[1], b[1]) - 60) / CELL); gy <= Math.floor((Math.max(a[1], b[1]) + 60) / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(id);
      }
  }
const distToNet = (lon, lat) => {
  const [x, y] = xy(lon, lat, LAT0);
  let best = Infinity;
  for (const id of grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
    const [ax, ay, bx, by] = segs[id];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
};

// 4. extract rail tunnels, keep the parts on the network, simplify
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((pts[k][0] - ax) * dx + (pts[k][1] - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(ax + dx * t - pts[k][0], ay + dy * t - pts[k][1]);
      if (d > best) (best = d), (bi = k);
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([i, bi], [bi, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
const out = [];
let pieces = 0, km = 0;
for (const [key, buf] of bufs) {
  if (!buf) continue;
  const [x, y] = key.split("/").map(Number);
  const layer = new VectorTile(new PbfReader(buf)).layers.transportation;
  if (!layer) continue;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.properties.brunnel !== "tunnel" || f.properties.class !== "rail") continue;
    const g = f.toGeoJSON(x, y, Z).geometry;
    for (const c of g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []) {
      // split into runs that stay within 40 m of the network
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const m = simplify(run.map(([lon, lat]) => xy(lon, lat, LAT0)), 2).map(([mx, my]) => [mx / (rad * Math.cos(LAT0 * rad) * R), my / (rad * R)]);
          out.push(m.flatMap(([lon, lat]) => [Math.round(lon * 1e5), Math.round(lat * 1e5)]));
          pieces++;
          for (let k = 1; k < run.length; k++) {
            const a = xy(run[k - 1][0], run[k - 1][1], LAT0), b = xy(run[k][0], run[k][1], LAT0);
            km += Math.hypot(b[0] - a[0], b[1] - a[1]) / 1000;
          }
        }
        run = [];
      };
      for (const p of c) {
        if (distToNet(p[0], p[1]) <= 40) run.push(p);
        else flush();
      }
      flush();
    }
  }
}
// delta-encode each line (ints, 1e-5 degrees) to keep the file small
const enc = out.map((l) => l.map((v, k) => (k < 2 ? v : v - l[k - 2])));
writeFileSync(join(here, "tunnels.json"), JSON.stringify({ about: "Rail tunnels on the rail-twin network, from swisstopo base vector tiles z11 (class rail, brunnel tunnel). Each line: delta-encoded [lon,lat] in 1e-5 degrees.", lines: enc }));
console.error(`${pieces} tunnel pieces, ${km.toFixed(0)} km, written ${join(here, "tunnels.json")}`);
