// Rail tunnels on the network (tunnels.json, extracted from swisstopo's base vector tiles by build-tunnels.mjs):
// a train inside one is drawn as a ghost on the surface instead of a solid train crawling over the mountain above.
import tunnelsUrl from "./tunnels.json?url";

const LAT0 = 46.8;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180); // metres per degree of longitude around Switzerland
const KY = 110_574; // metres per degree of latitude
const CELL = 400; // metres
const NEAR = 25; // a train this close to a tunnel's centreline is in it
const key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export class Tunnels {
  private grid = new Map<number, number[]>();
  private seg: Float64Array;

  static async load(): Promise<Tunnels> {
    const data = (await fetch(tunnelsUrl).then((r) => r.json())) as { lines: number[][] };
    return new Tunnels(data.lines);
  }

  constructor(lines: number[][]) {
    const segs: number[] = [];
    for (const l of lines) {
      let lon = 0;
      let lat = 0;
      let px = 0;
      let py = 0;
      for (let k = 0; k < l.length; k += 2) {
        lon += l[k];
        lat += l[k + 1];
        const x = (lon / 1e5) * KX;
        const y = (lat / 1e5) * KY;
        if (k > 0) segs.push(px, py, x, y);
        px = x;
        py = y;
      }
    }
    this.seg = Float64Array.from(segs);
    for (let s = 0; s < this.seg.length; s += 4) {
      const [ax, ay, bx, by] = [this.seg[s], this.seg[s + 1], this.seg[s + 2], this.seg[s + 3]];
      for (let cx = Math.floor((Math.min(ax, bx) - NEAR) / CELL); cx <= Math.floor((Math.max(ax, bx) + NEAR) / CELL); cx++)
        for (let cy = Math.floor((Math.min(ay, by) - NEAR) / CELL); cy <= Math.floor((Math.max(ay, by) + NEAR) / CELL); cy++) {
          const k = key(cx, cy);
          const cell = this.grid.get(k);
          if (cell) cell.push(s);
          else this.grid.set(k, [s]);
        }
    }
  }

  /** Whether a point on the track lies in a tunnel. */
  contains(lon: number, lat: number) {
    const x = lon * KX;
    const y = lat * KY;
    const cell = this.grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!cell) return false;
    const s = this.seg;
    for (const i of cell) {
      const ax = s[i];
      const ay = s[i + 1];
      const dx = s[i + 2] - ax;
      const dy = s[i + 3] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const ex = ax + dx * t - x;
      const ey = ay + dy * t - y;
      if (ex * ex + ey * ey < NEAR * NEAR) return true;
    }
    return false;
  }
}
