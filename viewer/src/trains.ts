// Every train drawn on one canvas above the map, interpolated between the 1 Hz MQTT snapshots (60 fps).
import type { Map as LibreMap } from "maplibre-gl";
import type { SnapshotRow } from "./feed";

type T = { id: string; from: [number, number]; to: [number, number]; bearing: number; speed: number; state: string; delay: number; line: string; cat: string; atStop: string | null; continuity: number };
/** One train as last received (read-only view for the 3D mode). */
export type TrainState = Readonly<T>;
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

/** The most recently created TrainCanvas, so the 3D mode (and tests) can reach it without App. */
export let lastTrainCanvas: TrainCanvas | undefined;

export class TrainCanvas {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private trains = new Map<string, T>();
  private at = 0;
  private raf = 0;
  simulated = new Set<string>();
  selected?: string;
  following = false;
  visible = true;
  count = 0;
  theme: "light" | "dark" = "light";

  constructor(private map: LibreMap) {
    lastTrainCanvas = this;
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
  /** Read-only, for the 3D mode: every train with its interpolated position, without allocating per train. */
  forEachTrain(fn: (t: TrainState, lon: number, lat: number) => void) {
    const k = this.k();
    for (const t of this.trains.values()) fn(t, t.from[0] + (t.to[0] - t.from[0]) * k, t.from[1] + (t.to[1] - t.from[1]) * k);
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
    const draw = (t: T, selected: boolean) => {
      const p = map.project(lerp(t.from, t.to, k));
      if (p.x < -20 || p.y < -20 || p.x > view.width + 20 || p.y > view.height + 20) return;
      const r = selected ? size * 1.6 : size;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (selected) {
        // pulsing sky-blue ring around a charcoal marker: the selected train stands out on any map
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
      if (this.simulated.has(t.id)) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.95, 0, Math.PI * 2);
        ctx.strokeStyle = this.theme === "light" ? "#212121" : "#ffffff";
        ctx.lineWidth = 1.6;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
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
      // contrast on every base map: a thin dark halo, then a white outline, then the colour
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 4.2;
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      const pal = this.theme === "dark" ? DARK_COLOURS : COLOURS;
      ctx.fillStyle = selected ? pal.selected : colourOf(t.state, t.delay, t.atStop, pal);
      ctx.fill();
      ctx.restore();
      if (labels || selected) {
        // SBB-style tag: white pill, line in charcoal, delay in red
        const late = t.delay >= 60 ? ` +${Math.round(t.delay / 60)}′` : "";
        const lw = ctx.measureText(t.line).width;
        const dw = late ? ctx.measureText(late).width : 0;
        const x = p.x + r + 6;
        ctx.fillStyle = selected ? "#212121" : "rgba(255,255,255,0.95)";
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, p.y - 9, lw + dw + 10, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = selected ? "#ffffff" : "#212121";
        ctx.fillText(t.line, x + 5, p.y + 0.5);
        if (late) {
          ctx.fillStyle = selected ? "#ff8a8a" : "#eb0000";
          ctx.fillText(late, x + 5 + lw, p.y + 0.5);
        }
      }
    };
    for (const t of this.trains.values()) if (t.id !== this.selected) draw(t, false);
    const sel = this.selected && this.trains.get(this.selected);
    if (sel) draw(sel, true);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}
