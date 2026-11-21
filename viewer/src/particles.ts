// Falling rain, drifting snow and wind streaks inside the god-mode weather areas: a light canvas drawn in the map frame.
import type { Map as LibreMap } from "maplibre-gl";

export type Area = { id: string; lon: number; lat: number; radiusKm: number; precipMm: number; gustKmh: number; snow: boolean };
type P = { u: number; v: number; s: number; w: number };

export class WeatherParticles {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private areas: { area: Area; ps: P[] }[] = [];
  private last = performance.now();
  dark = false;

  constructor(private map: LibreMap) {
    this.canvas.className = "weather-canvas";
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
    map.on("render", () => this.draw());
  }

  set(areas: Area[]) {
    this.areas = areas
      .filter((a) => a.precipMm >= 0.3 || a.gustKmh >= 60)
      .map((area) => {
        const old = this.areas.find((x) => x.area.id === area.id);
        const n = Math.min(260, Math.round(40 + area.precipMm * 30 + (area.gustKmh >= 60 ? 60 : 0)));
        const ps = old && old.ps.length === n ? old.ps : Array.from({ length: n }, () => ({ u: Math.random() * 2 - 1, v: Math.random() * 2 - 1, s: 0.6 + Math.random() * 0.8, w: Math.random() * Math.PI * 2 }));
        return { area, ps };
      });
  }

  private draw() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { ctx, map } = this;
    const view = map.getCanvas().getBoundingClientRect();
    ctx.clearRect(0, 0, view.width, view.height);
    for (const { area, ps } of this.areas) {
      const c = map.project([area.lon, area.lat]);
      const edge = map.project([area.lon + area.radiusKm / (111.32 * Math.cos((area.lat * Math.PI) / 180)), area.lat]);
      const R = Math.abs(edge.x - c.x);
      if (R < 6 || c.x + R < 0 || c.y + R < 0 || c.x - R > view.width || c.y - R > view.height) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.clip();
      const windy = area.gustKmh >= 60;
      const drift = windy ? Math.min(2.2, area.gustKmh / 50) : 0.25;
      for (const p of ps) {
        // motion in units of the radius per second: rain falls fast, snow slowly, wind pushes sideways
        const fall = area.snow ? 0.12 : 0.9;
        p.v += fall * p.s * dt;
        p.u += (drift * 0.25 + (area.snow ? Math.sin(now / 900 + p.w) * 0.05 : 0)) * dt;
        if (p.v > 1) p.v -= 2;
        if (p.u > 1) p.u -= 2;
        const x = c.x + p.u * R;
        const y = c.y + p.v * R;
        if (area.snow) {
          ctx.fillStyle = this.dark ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.95)";
          ctx.strokeStyle = "rgba(0,60,110,0.35)";
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.arc(x, y, 1.4 + p.s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (area.precipMm >= 0.3) {
          const len = 7 + p.s * 6;
          ctx.strokeStyle = this.dark ? "rgba(140,200,255,0.7)" : "rgba(0,90,190,0.55)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - drift * 3, y - len);
          ctx.stroke();
        }
        if (windy && p.s > 1.1) {
          ctx.strokeStyle = this.dark ? "rgba(255,255,255,0.35)" : "rgba(45,50,125,0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 18 - p.s * 10, y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}
