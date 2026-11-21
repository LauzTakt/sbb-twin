// Railways outside Switzerland for the map (data/abroad-lines.geojson), from OpenFreeMap vector tiles at zoom 10
// (OpenStreetMap data, © OpenStreetMap contributors, ODbL). Parts that run along the Swiss BAV network are cut away
// (the Swiss network is drawn from BAV), keeping one vertex of overlap so lines meet at the border without gaps.
//
//   cd tools && npm i --no-save @mapbox/vector-tile pbf
//   node extract_abroad_rails.mjs ../data/network.json.gz ../data/abroad-lines.geojson
import { VectorTile } from "@mapbox/vector-tile";
import * as PbfMod from "pbf";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
const Pbf = PbfMod.PbfReader ?? PbfMod.default;
const [W, S, E, N, Z] = [5.4, 45.55, 11.0, 48.05, 10];
const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const ty = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z);
// Swiss track cells (BAV network vertices), ~250 m grid
const net = JSON.parse(gunzipSync(readFileSync(process.argv[2])).toString());
const cell = (lon, lat) => `${Math.round(lon / 0.0033)}:${Math.round(lat / 0.00225)}`;
const swiss = new Set();
for (const e of net.edges) for (let i = 0; i < e[5].length; i += 2) swiss.add(cell(e[5][i], e[5][i + 1]));
const tj = await (await fetch("https://tiles.openfreemap.org/planet")).json();
const jobs = [];
for (let x = tx(W); x <= tx(E); x++) for (let y = ty(N); y <= ty(S); y++) jobs.push([x, y]);
const features = [];
let done = 0, kept = 0, dropped = 0;
const skip = new Set(["subway", "tram", "light_rail", "funicular", "monorail"]);
for (let i = 0; i < jobs.length; i += 12) {
  await Promise.all(jobs.slice(i, i + 12).map(async ([x, y]) => {
    const r = await fetch(tj.tiles[0].replace("{z}", Z).replace("{x}", x).replace("{y}", y));
    if (!r.ok) return;
    const t = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer()))).layers.transportation;
    for (let k = 0; k < (t?.length ?? 0); k++) {
      const f = t.feature(k);
      const p = f.properties;
      if (p.class !== "rail" || p.service || skip.has(p.subclass)) continue;
      const g = f.toGeoJSON(x, y, Z).geometry;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const line of lines) {
        // keep the parts away from the Swiss network (it is drawn from BAV), one vertex of overlap at each cut
        const near = (q) => { const [lo, la] = q; for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (swiss.has(`${Math.round(lo / 0.0033) + dx}:${Math.round(la / 0.00225) + dy}`)) return true; return false; };
        let run = [];
        const flush = () => {
          if (run.length >= 2) {
            kept++;
            features.push({ type: "Feature", properties: { usage: p.subclass === "narrow_gauge" ? "narrow" : "main" }, geometry: { type: "LineString", coordinates: run.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) } });
          } else if (run.length) dropped++;
          run = [];
        };
        for (let i = 0; i < line.length; i++) {
          if (near(line[i])) {
            if (run.length) { run.push(line[i]); flush(); }
            else dropped++;
          } else {
            if (!run.length && i > 0) run.push(line[i - 1]);
            run.push(line[i]);
          }
        }
        flush();
      }
    }
    done++;
  }));
}
writeFileSync(process.argv[3], JSON.stringify({ type: "FeatureCollection", attribution: "© OpenStreetMap contributors (ODbL), via OpenFreeMap", features }));
console.log(`tiles ${done}/${jobs.length} | foreign lines kept ${kept} | Swiss duplicates dropped ${dropped}`);
