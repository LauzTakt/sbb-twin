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
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // upsample with smoothing and a soft blur so the cells read as one continuous field
  const big = document.createElement("canvas");
  big.width = g.cols * 4;
  big.height = g.rows * 4;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.filter = "blur(3px)";
  bctx.drawImage(canvas, 0, 0, big.width, big.height);
  const [w, s, e, n] = g.bbox;
  const h = g.step / 2;
  return {
    url: big.toDataURL("image/png"),
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

// Precipitation like a weather radar: blues to violet for rain, white to ice-blue for snow (where it is <= 1 °C).
const RAIN: [number, number, number, number][] = [
  [0.05, 150, 205, 255],
  [0.3, 70, 160, 255],
  [1, 30, 110, 230],
  [2.5, 45, 60, 210],
  [5, 120, 45, 210],
  [10, 200, 30, 200],
];
const SNOW: [number, number, number, number][] = [
  [0.05, 255, 255, 255],
  [1, 225, 246, 255],
  [3, 185, 232, 255],
  [6, 140, 215, 255],
];
function ramp(stops: [number, number, number, number][], v: number): [number, number, number] {
  if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  for (let i = 1; i < stops.length; i++)
    if (v <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (v - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  const l = stops[stops.length - 1];
  return [l[1], l[2], l[3]];
}
export const RAIN_LEGEND = RAIN.map(([v, r, g, b]) => [v, `rgb(${r},${g},${b})`] as const);
export const SNOW_LEGEND = SNOW.map(([v, r, g, b]) => [v, `rgb(${r},${g},${b})`] as const);

export function precipImage(p: TemperatureGrid, t?: TemperatureGrid) {
  const canvas = document.createElement("canvas");
  canvas.width = p.cols;
  canvas.height = p.rows;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(p.cols, p.rows);
  for (let i = 0; i < p.values.length; i++) {
    const v = p.values[i] ?? 0;
    if (v < 0.05) continue;
    const temp = t && t.cols === p.cols ? t.values[i] : null;
    const snow = temp !== null && temp !== undefined && temp <= 1;
    const [r, g, b] = ramp(snow ? SNOW : RAIN, v);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.min(235, 90 + v * 70);
  }
  ctx.putImageData(img, 0, 0);
  const big = document.createElement("canvas");
  big.width = p.cols * 4;
  big.height = p.rows * 4;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.filter = "blur(3px)";
  bctx.drawImage(canvas, 0, 0, big.width, big.height);
  const [w, s, e, n] = p.bbox;
  const h = p.step / 2;
  return { url: big.toDataURL("image/png"), coordinates: [[w - h, n + h], [e + h, n + h], [e + h, s - h], [w - h, s - h]] as [[number, number], [number, number], [number, number], [number, number]] };
}
