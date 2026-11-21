// Every train drawn on one canvas above the map, interpolated between the 1 Hz MQTT snapshots (60 fps).
import type { Map as LibreMap } from "maplibre-gl";
import type { SnapshotRow } from "./feed";

type T = { id: string; from: [number, number]; to: [number, number]; bearing: number; speed: number; state: string; delay: number; line: string; cat: string; atStop: string | null; continuity: number };
export const COLOURS = { moving: "#3ddc97", late: "#ffc65a", station: "#7fb2ff", stoppedOnLine: "#ff5d6c", cancelled: "#8b93a1" };
/** Colour from observable facts only: moving / at a station / stopped on the open line, and lateness. */
export function colourOf(motion: string, delay: number, atStop: string | null) {
  if (motion === "cancelled") return COLOURS.cancelled;
  if (motion === "stopped" && !atStop) return COLOURS.stoppedOnLine;
  if (delay >= 180) return COLOURS.late;
  return motion === "moving" ? COLOURS.moving : COLOURS.station;
}
const lerp = (a: [number, number], b: [number, number], k: number): [number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

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
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
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
    const size = zoom < 8 ? 3.2 : zoom < 10 ? 4.2 : zoom < 12 ? 5.5 : 7;
    const rot = map.getBearing();
    const labels = zoom >= 10.5;
    const view = map.getCanvas().getBoundingClientRect();
    if (this.following && this.selected) {
      const p = this.position(this.selected);
      if (p) map.jumpTo({ center: p });
    }
    ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const draw = (t: T, selected: boolean) => {
      const p = map.project(lerp(t.from, t.to, k));
      if (p.x < -20 || p.y < -20 || p.x > view.width + 20 || p.y > view.height + 20) return;
      const r = selected ? size * 1.6 : size;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (selected) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.fill();
      }
      if (this.simulated.has(t.id)) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
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
      ctx.fillStyle = colourOf(t.state, t.delay, t.atStop);
      ctx.strokeStyle = "rgba(5,8,13,0.85)";
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (labels || selected) {
        const text = t.line + (t.delay >= 60 ? ` +${Math.round(t.delay / 60)}′` : "");
        ctx.fillStyle = "rgba(5,8,13,0.75)";
        const tw = ctx.measureText(text).width;
        ctx.fillRect(p.x + r + 4, p.y - 8, tw + 8, 16);
        ctx.fillStyle = "#e8edf5";
        ctx.fillText(text, p.x + r + 8, p.y);
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
