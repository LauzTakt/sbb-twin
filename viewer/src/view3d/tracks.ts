// The rail network as polylines in local metres, to lay the selected train's cars along the real track behind its head.
const LAT0 = 46.8;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110_574;
const CELL = 250; // metres
const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
const endKey = (x: number, y: number) => (Math.round(x) + 1_048_576) * 2_097_152 + (Math.round(y) + 1_048_576);

export class Tracks {
  private x: Float64Array;
  private y: Float64Array;
  private start: Int32Array; // first vertex of each line, plus the total at the end
  private lineOf: Int32Array; // line of each vertex
  private grid = new Map<number, number[]>(); // cell -> segments (index of the segment's first vertex)
  private ends = new Map<number, number[]>(); // endpoint (1 m grid) -> line * 2 + (0 start | 1 end)

  static async load(url = "/api/network.geojson"): Promise<Tracks> {
    const fc = (await fetch(url).then((r) => r.json())) as { features: { geometry: { type: string; coordinates: number[][] } }[] };
    return new Tracks(fc.features.filter((f) => f.geometry?.type === "LineString").map((f) => f.geometry.coordinates));
  }

  constructor(lines: number[][][]) {
    const n = lines.reduce((s, l) => s + l.length, 0);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.lineOf = new Int32Array(n);
    this.start = new Int32Array(lines.length + 1);
    let v = 0;
    lines.forEach((l, li) => {
      this.start[li] = v;
      for (const [lon, lat] of l) {
        this.x[v] = lon * KX;
        this.y[v] = lat * KY;
        this.lineOf[v++] = li;
      }
      const a = this.start[li];
      const b = v - 1;
      for (const [vi, end] of [
        [a, 0],
        [b, 1],
      ]) {
        const k = endKey(this.x[vi], this.y[vi]);
        const list = this.ends.get(k);
        if (list) list.push(li * 2 + end);
        else this.ends.set(k, [li * 2 + end]);
      }
      for (let i = a; i < b; i++) {
        const x0 = Math.min(this.x[i], this.x[i + 1]);
        const x1 = Math.max(this.x[i], this.x[i + 1]);
        const y0 = Math.min(this.y[i], this.y[i + 1]);
        const y1 = Math.max(this.y[i], this.y[i + 1]);
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
          for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
            const k = cellKey(cx, cy);
            const cell = this.grid.get(k);
            if (cell) cell.push(i);
            else this.grid.set(k, [i]);
          }
      }
    });
    this.start[lines.length] = v;
  }

  /**
   * Points on the track behind a train's head, `dists` metres back along the line (ascending), written as lon/lat
   * pairs into `out`. Follows the line through junctions (the straightest continuation). Returns false when no
   * track runs along the head within 40 m.
   */
  behind(lon: number, lat: number, bearingDeg: number, dists: Float64Array, count: number, out: Float64Array) {
    const hx = lon * KX;
    const hy = lat * KY;
    const fx = Math.sin((bearingDeg * Math.PI) / 180);
    const fy = Math.cos((bearingDeg * Math.PI) / 180);
    let best = -1;
    let bestScore = 40;
    let bestT = 0;
    const cx = Math.floor(hx / CELL);
    const cy = Math.floor(hy / CELL);
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const cell = this.grid.get(cellKey(cx + ox, cy + oy));
        if (!cell) continue;
        for (const i of cell) {
          const ax = this.x[i];
          const ay = this.y[i];
          const dx = this.x[i + 1] - ax;
          const dy = this.y[i + 1] - ay;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((hx - ax) * dx + (hy - ay) * dy) / len2));
          const d = Math.hypot(ax + dx * t - hx, ay + dy * t - hy);
          const align = Math.abs((dx * fx + dy * fy) / Math.sqrt(len2));
          const score = d + (1 - align) * 60;
          if (score < bestScore) {
            bestScore = score;
            best = i;
            bestT = t;
          }
        }
      }
    if (best < 0) return false;
    // walk against the direction of travel
    const forward = (this.x[best + 1] - this.x[best]) * fx + (this.y[best + 1] - this.y[best]) * fy >= 0;
    let step = forward ? -1 : 1;
    let px = this.x[best] + (this.x[best + 1] - this.x[best]) * bestT;
    let py = this.y[best] + (this.y[best + 1] - this.y[best]) * bestT;
    let j = forward ? best : best + 1; // next vertex to reach
    let line = this.lineOf[best];
    let s = 0;
    let dirx = -fx;
    let diry = -fy;
    let k = 0;
    let guard = 0;
    while (k < count && guard++ < 5000) {
      const vx = this.x[j] - px;
      const vy = this.y[j] - py;
      const seg = Math.hypot(vx, vy);
      if (seg > 1e-6) {
        dirx = vx / seg;
        diry = vy / seg;
      }
      // emit every requested point on this piece
      while (k < count && dists[k] <= s + seg) {
        const t = seg > 1e-6 ? (dists[k] - s) / seg : 0;
        out[2 * k] = (px + vx * t) / KX;
        out[2 * k + 1] = (py + vy * t) / KY;
        k++;
      }
      if (k >= count) break;
      s += seg;
      px = this.x[j];
      py = this.y[j];
      const a = this.start[line];
      const b = this.start[line + 1] - 1;
      if (j + step >= a && j + step <= b) {
        j += step;
        continue;
      }
      // end of this line: the connected line that continues straightest
      let next = -1;
      let nextDot = -0.2;
      for (let ex = -1; ex <= 1; ex++)
        for (let ey = -1; ey <= 1; ey++) {
          const list = this.ends.get(endKey(px + ex, py + ey));
          if (!list) continue;
          for (const e of list) {
            const li = e >> 1;
            if (li === line) continue;
            const from = e & 1 ? this.start[li + 1] - 1 : this.start[li];
            const to = e & 1 ? from - 1 : from + 1;
            const dx = this.x[to] - this.x[from];
            const dy = this.y[to] - this.y[from];
            const dot = (dx * dirx + dy * diry) / (Math.hypot(dx, dy) || 1);
            if (dot > nextDot) {
              nextDot = dot;
              next = e;
            }
          }
        }
      if (next < 0) {
        // the network ends here: carry on straight
        while (k < count) {
          out[2 * k] = (px + dirx * (dists[k] - s)) / KX;
          out[2 * k + 1] = (py + diry * (dists[k] - s)) / KY;
          k++;
        }
        break;
      }
      line = next >> 1;
      step = next & 1 ? -1 : 1;
      j = next & 1 ? this.start[line + 1] - 2 : this.start[line] + 1;
    }
    return true;
  }
}
