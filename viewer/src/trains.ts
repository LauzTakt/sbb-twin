// Every train drawn on one canvas above the map, interpolated between the 1 Hz MQTT snapshots (60 fps).
import type { Map as LibreMap } from "maplibre-gl";
import type { SnapshotRow } from "./feed";
import { ease, type Theme } from "./theme";

type T = { id: string; from: [number, number]; to: [number, number]; bearing: number; speed: number; state: string; delay: number; line: string; cat: string; atStop: string | null; continuity: number };
// SBB palette: green on time, orange late, blue at a station, red stopped on the line, grey cancelled, charcoal selected
export const COLOURS = { moving: "#00973b", late: "#f27e00", station: "#2d327d", stoppedOnLine: "#eb0000", cancelled: "#8d8d8d", selected: "#212121" };
/** Colour from observable facts only: moving / at a station / stopped on the open line, and lateness. */
// On dark or satellite maps the dark SBB blue and charcoal lose contrast: lighter equivalents there.
export const DARK_COLOURS = { ...COLOURS, station: "#8f9cff", cancelled: "#a3a9b1", selected: "#ffffff" };
export function colourOf(motion: string, delay: number, atStop: string | null, pal: typeof COLOURS = COLOURS) {
  if (motion === "cancelled") return pal.cancelled;
  if (motion === "stopped" && !atStop) return pal.stoppedOnLine;
  if (delay >= 180) return pal.late;
  return motion === "moving" ? pal.moving : pal.station;
}
const lerp = (a: [number, number], b: [number, number], k: number): [number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

// Everything the canvas paints that changes with the theme, as [r, g, b, alpha]: a theme switch fades between the two.
type RGBA = [number, number, number, number];
const rgb = (hex: string, a = 1): RGBA => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(a) as RGBA;
const trainColours = (p: typeof COLOURS) => ({ moving: rgb(p.moving), late: rgb(p.late), station: rgb(p.station), stoppedOnLine: rgb(p.stoppedOnLine), cancelled: rgb(p.cancelled), selected: rgb(p.selected) });
const INK = {
  light: {
    ...trainColours(COLOURS),
    halo: [0, 0, 0, 0.45] as RGBA, // the thin dark halo, then a white outline
    outline: rgb("#ffffff"),
    contour: rgb("#0079c7"), // the selected train's sky-blue contour
    pill: [255, 255, 255, 0.95] as RGBA,
    pillLine: [0, 0, 0, 0.18] as RGBA,
    text: rgb("#212121"),
    delay: rgb("#eb0000"),
    selPill: rgb("#212121"),
    selText: rgb("#ffffff"),
    selDelay: rgb("#ff8a8a"),
    dim: [0, 0, 0, 0.2] as RGBA, // alpha of the trains outside the picked disruption
  },
  dark: {
    ...trainColours(DARK_COLOURS),
    halo: [0, 0, 0, 0.5] as RGBA, // on the dark map the outline is the ground's colour: the train's colour carries it
    outline: rgb("#17191c"),
    contour: rgb("#0079c7"),
    pill: [34, 37, 42, 0.95] as RGBA,
    pillLine: [255, 255, 255, 0.16] as RGBA,
    text: rgb("#f1f2f4"),
    delay: rgb("#ff4d4d"),
    selPill: rgb("#f1f2f4"),
    selText: rgb("#17191c"),
    selDelay: rgb("#c60018"),
    dim: [0, 0, 0, 0.28] as RGBA,
  },
};
type Ink = typeof INK.light;
const css = (c: RGBA) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.round(c[3] * 1000) / 1000})`;
function inkAt(m: number) {
  const out = {} as Record<keyof Ink, string>;
  for (const k of Object.keys(INK.light) as (keyof Ink)[]) out[k] = css(INK.light[k].map((v, i) => v + (INK.dark[k][i] - v) * m) as RGBA);
  return { ...out, dim: INK.light.dim[3] + (INK.dark.dim[3] - INK.light.dim[3]) * m };
}

export class TrainCanvas {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private trains = new Map<string, T>();
  private at = 0;
  private raf = 0;
  selected?: string;
  /** When set, only these trains are drawn at full strength; the others fade (a picked disruption). */
  focus?: Set<string>;
  following = false;
  visible = true; // the "Trains" layer switch
  count = 0;
  theme: Theme = "light";
  /** 0 light, 1 dark: animated from `from` to `to` over `ms`, read every frame. */
  private mix = { from: 0, to: 0, t0: 0, ms: 0 };
  private ink = { m: -1, s: inkAt(0) };

  constructor(private map: LibreMap) {
    this.canvas.className = "trains-canvas";
    map.getCanvasContainer().appendChild(this.canvas);
    const resize = () => {
      const r = map.getCanvas().getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      this.canvas.width = r.width * dpr;
      this.canvas.height = r.height * dpr;
      this.canvas.style.width = `${r.width}px`;
      this.canvas.style.height = `${r.height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    map.on("resize", resize);
    resize();
    // Draw inside the map's own frame so markers move exactly with the map while panning or zooming;
    // between map interactions, keep asking the map for frames so the trains keep gliding.
    map.on("render", () => this.draw());
    const tick = () => {
      // move the camera before the map renders this frame, so the followed train stays still on screen
      if (this.following && this.selected && this.visible) {
        const p = this.position(this.selected);
        if (p) this.map.jumpTo({ center: p });
      }
      this.map.triggerRepaint();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Switch the colours, fading over `ms` (0: at once), from wherever a running switch is. */
  setTheme(theme: Theme, ms: number) {
    const now = performance.now();
    this.mix = { from: this.mixAt(now), to: theme === "dark" ? 1 : 0, t0: now, ms };
    this.theme = theme;
  }
  private mixAt(now: number) {
    const { from, to, t0, ms } = this.mix;
    return ms <= 0 || now >= t0 + ms ? to : from + (to - from) * ease((now - t0) / ms);
  }
  private inkNow() {
    const m = this.mixAt(performance.now());
    if (m !== this.ink.m) this.ink = { m, s: inkAt(m) };
    return this.ink.s;
  }

  update(rows: SnapshotRow[]) {
    const k = this.k();
    const next = new Map<string, T>();
    for (const [id, lat, lon, bearing, speed, state, delay, line, cat, atStop, continuity] of rows) {
      const old = this.trains.get(id);
      let from: [number, number] = [lon, lat];
      // interpolate from where it is drawn now, unless the train jumped (continuity changed)
      if (old && old.continuity === continuity) from = lerp(old.from, old.to, k);
      next.set(id, { id, from, to: [lon, lat], bearing, speed, state, delay, line, cat, atStop, continuity });
    }
    this.trains = next;
    this.at = performance.now();
    this.count = rows.length;
  }
  private k() {
    return Math.min(1, (performance.now() - this.at) / 1000);
  }
  position(id: string) {
    const t = this.trains.get(id);
    return t ? lerp(t.from, t.to, this.k()) : undefined;
  }
  info(id: string) {
    return this.trains.get(id);
  }
  hit(x: number, y: number) {
    let best: string | undefined;
    let bestD = 14 * 14;
    const k = this.k();
    for (const t of this.trains.values()) {
      const p = this.map.project(lerp(t.from, t.to, k));
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t.id;
      }
    }
    return best;
  }

  private draw() {
    const { ctx, map } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.visible) return;
    const k = this.k();
    const zoom = map.getZoom();
    const size = zoom < 8 ? 4 : zoom < 10 ? 5 : zoom < 12 ? 6.5 : 8.5;
    const rot = map.getBearing();
    const labels = zoom >= 10.5;
    const view = map.getCanvas().getBoundingClientRect();
    ctx.font = '700 12px "SBB Web", "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = "middle";
    const ink = this.inkNow();
    const draw = (t: T, selected: boolean) => {
      const p = map.project(lerp(t.from, t.to, k));
      if (p.x < -20 || p.y < -20 || p.x > view.width + 20 || p.y > view.height + 20) return;
      const r = selected ? size * 1.6 : size;
      const dim = !selected && this.focus !== undefined && !this.focus.has(t.id);
      ctx.save();
      ctx.globalAlpha = dim ? ink.dim : 1;
      ctx.translate(p.x, p.y);
      if (selected) {
        // pulsing sky-blue ring: the selected train stands out on any map, in its own colour
        const pulse = (performance.now() % 1400) / 1400;
        ctx.beginPath();
        ctx.arc(0, 0, r * (2 + pulse * 2.4), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,121,199,${0.9 * (1 - pulse)})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, r * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,121,199,0.18)";
        ctx.fill();
      }
      ctx.rotate(((t.bearing - rot) * Math.PI) / 180);
      ctx.beginPath();
      if (t.state !== "moving") ctx.arc(0, 0, r * 0.95, 0, Math.PI * 2);
      else {
        ctx.moveTo(0, -r * 1.5);
        ctx.lineTo(r, r);
        ctx.lineTo(0, r * 0.45);
        ctx.lineTo(-r, r);
        ctx.closePath();
      }
      // contrast on every base map: a thin dark halo (the selected train: a sky-blue contour), an outline (white on the
      // light map, the ground's colour on the dark one), the colour
      ctx.lineJoin = "round";
      ctx.strokeStyle = selected ? ink.contour : ink.halo;
      ctx.lineWidth = selected ? 8 : 4.2;
      ctx.stroke();
      ctx.strokeStyle = ink.outline;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = colourOf(t.state, t.delay, t.atStop, ink); // selecting never changes the colour
      ctx.fill();
      ctx.restore();
      if ((labels || selected) && !dim) {
        // SBB-style tag: white pill (dark on the dark map), line in charcoal, delay in red
        const late = t.delay >= 60 ? ` +${Math.round(t.delay / 60)}′` : "";
        const lw = ctx.measureText(t.line).width;
        const dw = late ? ctx.measureText(late).width : 0;
        const x = p.x + r + 6;
        ctx.fillStyle = selected ? ink.selPill : ink.pill;
        ctx.strokeStyle = ink.pillLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, p.y - 9, lw + dw + 10, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = selected ? ink.selText : ink.text;
        ctx.fillText(t.line, x + 5, p.y + 0.5);
        if (late) {
          ctx.fillStyle = selected ? ink.selDelay : ink.delay;
          ctx.fillText(late, x + 5 + lw, p.y + 0.5);
        }
      }
    };
    const faded = (t: T) => this.focus !== undefined && !this.focus.has(t.id);
    for (const t of this.trains.values()) if (t.id !== this.selected && faded(t)) draw(t, false);
    for (const t of this.trains.values()) if (t.id !== this.selected && !faded(t)) draw(t, false);
    const sel = this.selected && this.trains.get(this.selected);
    if (sel) draw(sel, true);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}
