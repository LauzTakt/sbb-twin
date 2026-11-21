// 3D mode for the viewer: terrain relief with sky and fog, swisstopo buildings in 3D, and every train as a 3D model
// drawn by three.js inside MapLibre's WebGL context. three.js loads on first use, so the 2D bundle does not grow.
//
//   await enable3D(map, trains)   tilt, relief, buildings, 3D trains (the 2D canvas trains stay hidden meanwhile)
//   disable3D(map, trains)        back to the flat 2D view
//
// Both are idempotent. While 3D is on it puts itself back after a base map setStyle (style.load) and follows the
// light / dark / satellite switches made in place; reapply3D(map, trains) does the same on demand.
// Following a train (trains.following + trains.selected) becomes a chase camera behind it.
import type { Map as LibreMap } from "maplibre-gl";
import { lastTrainCanvas, type TrainCanvas } from "../trains";
import { add3DStyle, lookOf, remove3DStyle, restyle3D, styleReady, widenNetwork } from "./style3d";
import type { TrainLayer } from "./trainLayer";

const PITCH = 60;
const FOLLOW_PITCH = 65;
const FOLLOW_ZOOM = 15;
const RAD = Math.PI / 180;

type Follow = { id?: string; bearing: number; zoomOwned: boolean; lastZoom: number; last: number };
type Session = {
  map: LibreMap;
  trains: TrainCanvas;
  on: boolean;
  ready?: Promise<void>;
  layer?: TrainLayer;
  raf: number;
  frame: number;
  maxPitch: number;
  wantVisible: boolean; // what the App asks of the 2D trains ("Trains" toggle): the 3D trains obey it instead
  follow: Follow;
  onStyle: () => void;
  loop: (now: number) => void;
};

let session: Session | undefined;
let layerModule: Promise<typeof import("./trainLayer")> | undefined;

const styleLoaded = (map: LibreMap) => (styleReady(map) ? Promise.resolve() : new Promise<void>((resolve) => map.once("style.load", () => resolve())));

/** Whether the 3D mode is on (for this map, when given). */
export function is3D(map?: LibreMap) {
  return Boolean(session?.on && (!map || session.map === map));
}

export function enable3D(map: LibreMap, trains: TrainCanvas): Promise<void> {
  if (session?.on) {
    if (session.map === map && session.trains === trains) return session.ready ?? Promise.resolve();
    disable3D(session.map, session.trains);
  }
  const reuse = session?.map === map ? session.layer : undefined; // keep the GPU resources of an earlier 3D session
  const s: Session = {
    map,
    trains,
    on: true,
    layer: reuse,
    raf: 0,
    frame: 0,
    maxPitch: map.getMaxPitch(),
    wantVisible: trains.visible,
    follow: { bearing: 0, zoomOwned: true, lastZoom: 0, last: 0 },
    onStyle: () => apply(s),
    loop: (now) => tick(s, now),
  };
  session = s;
  s.ready = (async () => {
    await styleLoaded(map);
    if (!s.on) return;
    const mod = await (layerModule ??= import("./trainLayer"));
    if (!s.on) return;
    s.layer ??= new mod.TrainLayer(map, trains, () => s.wantVisible);
    s.layer.trains = trains;
    s.layer.show = () => s.wantVisible;
    map.setMaxPitch(Math.max(s.maxPitch, 72));
    apply(s);
    hide2D(s);
    map.on("style.load", s.onStyle);
    s.raf = requestAnimationFrame(s.loop);
    if (!(trains.following && trains.selected)) map.easeTo({ pitch: PITCH, duration: 1400 });
  })();
  return s.ready;
}

export function disable3D(map: LibreMap, trains: TrainCanvas) {
  const s = session;
  if (!s?.on || s.map !== map) return;
  s.on = false;
  cancelAnimationFrame(s.raf);
  map.off("style.load", s.onStyle);
  try {
    if (s.layer && map.getLayer(s.layer.id)) map.removeLayer(s.layer.id);
    remove3DStyle(map);
  } catch (e) {
    console.warn("[3d] could not remove everything (style reloading?)", e);
  }
  show2D(s);
  map.setMaxPitch(s.maxPitch);
  // the 2D follow moves the map every frame and would cut an animation short: flatten at once then
  if (trains.following && trains.selected) map.jumpTo({ pitch: 0, bearing: 0 });
  else map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
}

/** Puts the 3D style and trains back now (e.g. right after the App replaced the base style). */
export function reapply3D(map: LibreMap, _trains?: TrainCanvas) {
  if (session?.on && session.map === map) apply(session);
}

/** Instances and draw calls of the last frame, and the JS cost per frame (ms, averaged). */
export function stats3D() {
  return session?.layer?.stats;
}

function apply(s: Session) {
  const { map, layer } = s;
  if (!s.on || !layer || !styleReady(map)) return;
  try {
    add3DStyle(map, lookOf(map, s.trains.theme));
  } catch (e) {
    console.warn("[3d] relief or buildings unavailable", e); // the trains still go 3D
  }
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

const canvas2D = (s: Session) => s.map.getCanvasContainer().querySelector<HTMLCanvasElement>(".trains-canvas");

/** The 3D trains replace the 2D canvas: the canvas reads `visible` as false (and is hidden), clicks hit the 3D bodies. */
function hide2D(s: Session) {
  const t = s.trains;
  const c = canvas2D(s);
  if (c) c.style.visibility = "hidden"; // whatever is still on it from the last 2D frame
  if (Object.getOwnPropertyDescriptor(t, "visible")?.get) return;
  s.wantVisible = t.visible;
  Object.defineProperty(t, "visible", {
    configurable: true,
    enumerable: true,
    get: () => false,
    set: (v: boolean) => {
      s.wantVisible = v;
    },
  });
  Object.defineProperty(t, "hit", { configurable: true, writable: true, value: (x: number, y: number) => s.layer?.hit(x, y) });
}

function show2D(s: Session) {
  const t = s.trains;
  const c = canvas2D(s);
  if (c) c.style.visibility = "";
  if (Object.getOwnPropertyDescriptor(t, "visible")?.get) {
    Reflect.deleteProperty(t, "visible");
    t.visible = s.wantVisible;
  }
  Reflect.deleteProperty(t, "hit");
}

function tick(s: Session, now: number) {
  if (!s.on) return;
  s.raf = requestAnimationFrame(s.loop);
  const { map, layer } = s;
  follow(s, now);
  // every half second: keep the 3D style in place (a reloaded base style, a theme switched in place, a late network layer)
  if (++s.frame % 30 === 0 && layer && styleReady(map)) {
    if (!map.getLayer(layer.id) || !map.getTerrain()) apply(s);
    else {
      restyle3D(map, lookOf(map, s.trains.theme));
      widenNetwork(map);
    }
  }
  map.triggerRepaint(); // the trains glide between the 1 Hz updates
}

/** Chase camera: behind the followed train, looking along its bearing (eased the short way round). */
function follow(s: Session, now: number) {
  const { map, trains } = s;
  const f = s.follow;
  const id = trains.following ? trains.selected : undefined;
  if (!id) {
    f.id = undefined;
    return;
  }
  const t = trains.info(id);
  const p = trains.position(id);
  if (!t || !p) return;
  if (f.id !== id) {
    f.id = id;
    f.bearing = map.getBearing();
    f.zoomOwned = true;
    f.lastZoom = map.getZoom();
    f.last = now;
  }
  const dt = Math.min(0.1, Math.max(0, (now - f.last) / 1000));
  f.last = now;
  const zoomNow = map.getZoom();
  if (Math.abs(zoomNow - f.lastZoom) > 1e-3) f.zoomOwned = false; // the user zoomed: their zoom stays from now on
  f.bearing += ((((t.bearing - f.bearing) % 360) + 540) % 360 - 180) * (1 - Math.exp(-dt / 0.9));
  const pitch = map.getPitch() + (FOLLOW_PITCH - map.getPitch()) * (1 - Math.exp(-dt / 0.6));
  const zoom = f.zoomOwned ? zoomNow + (FOLLOW_ZOOM - zoomNow) * (1 - Math.exp(-dt / 0.7)) : zoomNow;
  // aim a little ahead of the train: it sits below the middle of the screen with the line ahead in view
  const cos = Math.cos(p[1] * RAD);
  const ahead = ((40_075_016.686 * cos) / (512 * 2 ** zoom)) * map.getCanvas().clientHeight * 0.3;
  const b = f.bearing * RAD;
  map.jumpTo({ center: [p[0] + (Math.sin(b) * ahead) / (111_320 * cos), p[1] + (Math.cos(b) * ahead) / 110_574], bearing: f.bearing, pitch, zoom });
  f.lastZoom = map.getZoom();
}

// handy in the console and for tests: window.rail3d.enable3D(window.railMap, window.rail3d.trains())
(window as unknown as { rail3d?: unknown }).rail3d = { enable3D, disable3D, reapply3D, is3D, stats: stats3D, trains: () => lastTrainCanvas };
