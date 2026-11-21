// Temperature map: the published grid painted with a continuous colour ramp.
import type { TemperatureGrid } from "./feed";

export const RAMP: [number, string][] = [
  [-20, "#5a2ca0"],
  [-10, "#2c5ee8"],
  [-5, "#3f9be8"],
  [0, "#9ad8f5"],
  [5, "#d7f0c8"],
  [10, "#fde68a"],
  [15, "#fdba4d"],
  [20, "#f97a2b"],
  [25, "#e9442b"],
  [30, "#b5162b"],
  [35, "#6d0a1f"],
];
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const STOPS = RAMP.map(([t, c]) => [t, ...rgb(c)] as [number, number, number, number]);

export function rampRgb(t: number): [number, number, number] {
  if (t <= STOPS[0][0]) return [STOPS[0][1], STOPS[0][2], STOPS[0][3]];
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, r1, g1, b1] = STOPS[i];
    if (t <= t1) {
      const [t0, r0, g0, b0] = STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  const l = STOPS[STOPS.length - 1];
  return [l[1], l[2], l[3]];
}
export const rampColour = (t: number) => `rgb(${rampRgb(t).map(Math.round).join(",")})`;

/** The grid as an image (one pixel per cell) plus the corner coordinates MapLibre needs to place it. */
export function gridImage(g: TemperatureGrid) {
  const canvas = document.createElement("canvas");
  canvas.width = g.cols;
  canvas.height = g.rows;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(g.cols, g.rows);
  for (let i = 0; i < g.values.length; i++) {
    const v = g.values[i];
    if (v === null) continue;
    const [r, gg, b] = rampRgb(v);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 210;
  }
  ctx.putImageData(img, 0, 0);
  const [w, s, e, n] = g.bbox;
  const h = g.step / 2;
  return {
    url: canvas.toDataURL("image/png"),
    coordinates: [
      [w - h, n + h],
      [e + h, n + h],
      [e + h, s - h],
      [w - h, s - h],
    ] as [[number, number], [number, number], [number, number], [number, number]],
  };
}

/** Temperature at any point from the grid: bilinear interpolation (same method other teams can use). */
export function temperatureAt(g: TemperatureGrid, lon: number, lat: number) {
  const [w, , , n] = g.bbox;
  const x = (lon - w) / g.step;
  const y = (n - lat) / g.step;
  const c0 = Math.floor(x);
  const r0 = Math.floor(y);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= g.cols || r0 + 1 >= g.rows) return null;
  const v = (c: number, r: number) => g.values[r * g.cols + c];
  const q = [v(c0, r0), v(c0 + 1, r0), v(c0, r0 + 1), v(c0 + 1, r0 + 1)];
  if (q.some((x) => x === null)) return q.find((x) => x !== null) ?? null;
  const fx = x - c0;
  const fy = y - r0;
  return (q[0]! * (1 - fx) + q[1]! * fx) * (1 - fy) + (q[2]! * (1 - fx) + q[3]! * fx) * fy;
}
