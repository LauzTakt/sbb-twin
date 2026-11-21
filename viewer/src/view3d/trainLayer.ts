// Every train in 3D: a three.js scene drawn inside MapLibre's own WebGL context (custom layer, "3d" rendering mode,
// sharing the depth buffer with the terrain and the buildings). One instanced draw per batch (trains, replacement
// buses, ghosts in tunnels, the selected train's cars) plus the selection halo: a handful of draw calls for a thousand
// trains. Instance data is rewritten once per frame from the interpolated positions into preallocated buffers.
import { BackSide, BufferAttribute, Camera, DoubleSide, DynamicDrawUsage, FrontSide, GLSL3, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute, Matrix4, Mesh, PlaneGeometry, RawShaderMaterial, Scene, Vector3, WebGLRenderer } from "three";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";
import { COLOURS, DARK_COLOURS, colourOf, type TrainCanvas, type TrainState } from "../trains";
import { Tracks } from "./tracks";
import { Tunnels } from "./tunnels";

const C = 40_075_016.686; // earth circumference, metres
const RAD = Math.PI / 180;
// Local frame: metres east / north of the middle of Switzerland, metres up. Float32 keeps ~2 cm everywhere in the country.
const O_LAT = 46.8;
const OX = (8.2 + 180) / 360;
const OY = (1 - Math.log(Math.tan(Math.PI / 4 + (O_LAT * RAD) / 2)) / Math.PI) / 2;
const K = 1 / (C * Math.cos(O_LAT * RAD)); // mercator units per local metre
const mercY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2;

// length, width, height, car length (metres) by category; replacement buses (EV) are buses
type Spec = { len: number; w: number; h: number; car: number; bus: boolean };
const spec = (len: number, w: number, h: number, car: number, bus = false): Spec => ({ len, w, h, car, bus });
const SPECS: Record<string, Spec> = {
  TGV: spec(400, 2.9, 4.2, 22),
  ICE: spec(346, 2.9, 4.1, 26),
  EC: spec(300, 2.9, 4.1, 26),
  NJ: spec(380, 2.9, 4.3, 26),
  EN: spec(380, 2.9, 4.3, 26),
  RJX: spec(205, 2.9, 4.2, 26),
  IC: spec(330, 2.9, 4.6, 26.8),
  ICN: spec(300, 2.9, 4.1, 27),
  IR: spec(260, 2.9, 4.6, 26.8),
  EXT: spec(200, 2.9, 4.2, 26),
  IRE: spec(150, 2.9, 4.4, 25),
  RE: spec(150, 2.9, 4.4, 25),
  TER: spec(150, 2.9, 4.3, 25),
  PE: spec(140, 2.65, 3.8, 20),
  S: spec(120, 2.9, 4.6, 25),
  SN: spec(100, 2.9, 4.6, 25),
  R: spec(100, 2.9, 4.2, 25),
  RB: spec(100, 2.9, 4.2, 25),
  CC: spec(60, 2.65, 3.6, 18),
  EV: spec(15, 2.55, 3.2, 15, true),
  B: spec(12, 2.55, 3.2, 12, true),
  BUS: spec(12, 2.55, 3.2, 12, true),
};
const DEFAULT_SPEC = spec(120, 2.9, 4.2, 25);
const GAP = 1.1; // metres between the selected train's cars

// minimum size on screen (CSS px) so trains stay readable when zoomed out; real size takes over when larger.
// Slimmer over the whole country (dense, like the 2D markers), chunkier from zoom 12 where each train is looked at.
const MIN_PX_FAR = { len: 13, w: 4.6, h: 3.6 };
const MIN_PX_NEAR = { len: 16, w: 6.5, h: 5 };
const ELEV_EVERY = 60; // frames between elevation samples of a train that stands still (rolling, spread over all trains)
const TUNNEL_EVERY = 15;

const STRIDE = 16; // iPos 3, iDir 3, iSize 4 (length, width, height, car length), iColor 3, iNose 2, iFlag 1

const VERT = `precision highp float;
uniform mat4 u_matrix;
uniform vec3 u_cam;
uniform float u_nose;
in vec3 position; // profile y, profile z, ring (0 head tip, 1 head shoulder, 2 tail shoulder, 3 tail tip)
in vec2 aTip;
in vec3 iPos;
in vec3 iDir;
in vec4 iSize;
in vec3 iColor;
in vec2 iNose;
in float iFlag;
out vec3 vRel;
out vec3 vColor;
out float vAlong;
out float vZ;
out float vCar;
out float vFlag;
out float vY;
flat out vec3 vF;
void main() {
  float L = iSize.x;
  float W = iSize.y;
  float H = iSize.z;
  float ring = position.z;
  bool head = ring < 1.5;
  bool tip = ring < 0.5 || ring > 2.5;
  float nose = head ? iNose.x : iNose.y;
  vec2 yz = tip ? mix(position.xy, aTip, nose) : position.xy;
  float noseLen = min(u_nose * W, 0.3 * L);
  float x = ring < 0.5 ? 0.0 : ring < 1.5 ? -noseLen : ring < 2.5 ? noseLen - L : -L;
  vec3 f = normalize(iDir);
  vec3 l = normalize(vec3(-f.y, f.x, 0.0));
  vec3 up = cross(f, l);
  vec3 world = iPos + f * x + l * (yz.x * W) + up * (yz.y * H);
  vRel = world - u_cam;
  vColor = iColor;
  vAlong = -x;
  vZ = yz.y;
  vCar = iSize.w;
  vFlag = iFlag;
  vY = yz.x;
  vF = f;
  gl_Position = u_matrix * vec4(world, 1.0);
}`;

const FRAG = `precision highp float;
uniform vec3 u_sun;
uniform float u_detail;
uniform float u_alpha;
uniform vec2 u_win;
in vec3 vRel;
in vec3 vColor;
in float vAlong;
in float vZ;
in float vCar;
in float vFlag;
in float vY;
flat in vec3 vF;
out vec4 outColor;
void main() {
  // flat shading from the surface itself: works for any instance size and slope
  vec3 n = normalize(cross(dFdx(vRel), dFdy(vRel)));
  if (dot(n, vRel) > 0.0) n = -n;
  float selected = step(1.5, vFlag);
  float simulated = step(0.5, mod(vFlag, 2.0));
  float side = 1.0 - abs(n.z);
  vec3 c = vColor;
  vec3 glass = mix(vec3(0.07, 0.09, 0.12), vec3(0.74, 0.8, 0.87), selected);
  // windows along the sides, the gaps between cars, the windscreen on the cab's slope
  float win = u_detail * step(0.8, side) * smoothstep(u_win.x - 0.02, u_win.x, vZ) * (1.0 - smoothstep(u_win.y, u_win.y + 0.02, vZ));
  float g = fract(vAlong / max(vCar, 1.0));
  float gap = u_detail * step(0.8, side) * (1.0 - step(0.022, min(g, 1.0 - g))) * step(vCar * 0.5, vAlong);
  float screen = u_detail * step(0.3, abs(dot(n, vF))) * step(0.2, n.z) * step(0.45, vZ);
  c = mix(c, glass, max(win * 0.8, screen * 0.85));
  c = mix(c, c * 0.35, gap);
  // a provoked (simulated) train carries a white stripe along its roof
  c = mix(c, vec3(0.97), simulated * step(0.75, n.z) * (1.0 - step(0.17, abs(vY))));
  float light = 0.56 + 0.16 * n.z + 0.5 * max(dot(n, u_sun), 0.0);
  outColor = vec4(c * light * u_alpha, u_alpha);
}`;

const HALO_VERT = `precision highp float;
uniform mat4 u_matrix;
uniform vec3 u_center;
uniform float u_radius;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  gl_Position = u_matrix * vec4(u_center + vec3(position.xy * 2.0 * u_radius, 0.0), 1.0);
}`;
const HALO_FRAG = `precision highp float;
uniform float u_phase;
uniform vec3 u_color;
in vec2 vUv;
out vec4 outColor;
void main() {
  // the 2D look in 3D: a soft disc, a crisp ring, and a ring pulsing outwards
  float r = length(vUv);
  float aa = fwidth(r) * 1.5;
  float disc = (1.0 - smoothstep(0.52 - aa, 0.52, r)) * 0.16;
  float edge = (1.0 - smoothstep(0.0, 0.03 + aa, abs(r - 0.52))) * 0.85;
  float pr = 0.55 + u_phase * 0.42;
  float pulse = (1.0 - smoothstep(0.0, 0.025 + aa, abs(r - pr))) * 0.9 * (1.0 - u_phase);
  float a = max(disc, max(edge, pulse));
  if (a < 0.004) discard;
  outColor = vec4(u_color * a, a);
}`;

type Shape = { position: BufferAttribute; tip: BufferAttribute; index: BufferAttribute };
/** A unit body: a cross-section profile (y left, z up) extruded from the head (x 0) back to the tail, with a cab shape at each end. */
function bodyShape(profile: [number, number][], tip: [number, number][]): Shape {
  const P = profile.length;
  const pos: number[] = [];
  const tp: number[] = [];
  for (let r = 0; r < 4; r++)
    for (let i = 0; i < P; i++) {
      pos.push(profile[i][0], profile[i][1], r);
      const t = r === 0 || r === 3 ? tip[i] : profile[i];
      tp.push(t[0], t[1]);
    }
  const idx: number[] = [];
  // sides, wound counter-clockwise seen from outside (x forward, y left, z up)
  for (let r = 0; r < 3; r++)
    for (let i = 0; i < P; i++) {
      const a = r * P + i;
      const b = r * P + ((i + 1) % P);
      const c = (r + 1) * P + ((i + 1) % P);
      const d = (r + 1) * P + i;
      idx.push(a, c, b, a, d, c);
    }
  for (let i = 1; i < P - 1; i++) idx.push(0, i, i + 1, 3 * P, 3 * P + i + 1, 3 * P + i);
  return { position: new BufferAttribute(new Float32Array(pos), 3), tip: new BufferAttribute(new Float32Array(tp), 2), index: new BufferAttribute(new Uint16Array(idx), 1) };
}
const TRAIN_SHAPE = (): Shape =>
  bodyShape(
    [[0.5, 0.05], [0.5, 0.8], [0.38, 1], [-0.38, 1], [-0.5, 0.8], [-0.5, 0.05]],
    [[0.42, 0.05], [0.42, 0.48], [0.3, 0.6], [-0.3, 0.6], [-0.42, 0.48], [-0.42, 0.05]],
  );
const BUS_SHAPE = (): Shape =>
  bodyShape(
    [[0.5, 0.07], [0.5, 0.92], [0.45, 1], [-0.45, 1], [-0.5, 0.92], [-0.5, 0.07]],
    [[0.48, 0.07], [0.48, 0.9], [0.43, 0.97], [-0.43, 0.97], [-0.48, 0.9], [-0.48, 0.07]],
  );

class Batch {
  readonly data: Float32Array;
  readonly mesh: Mesh;
  readonly ids: string[] = [];
  n = 0;
  private buf: InstancedInterleavedBuffer;
  private geo = new InstancedBufferGeometry();
  constructor(
    shape: Shape,
    readonly max: number,
    material: RawShaderMaterial,
  ) {
    this.data = new Float32Array(max * STRIDE);
    this.buf = new InstancedInterleavedBuffer(this.data, STRIDE, 1).setUsage(DynamicDrawUsage);
    const g = this.geo;
    g.setIndex(shape.index);
    g.setAttribute("position", shape.position);
    g.setAttribute("aTip", shape.tip);
    g.setAttribute("iPos", new InterleavedBufferAttribute(this.buf, 3, 0));
    g.setAttribute("iDir", new InterleavedBufferAttribute(this.buf, 3, 3));
    g.setAttribute("iSize", new InterleavedBufferAttribute(this.buf, 4, 6));
    g.setAttribute("iColor", new InterleavedBufferAttribute(this.buf, 3, 10));
    g.setAttribute("iNose", new InterleavedBufferAttribute(this.buf, 2, 13));
    g.setAttribute("iFlag", new InterleavedBufferAttribute(this.buf, 1, 15));
    g.instanceCount = 0;
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  push(id: string, u: number, v: number, w: number, fx: number, fy: number, fz: number, len: number, wid: number, hgt: number, car: number, rgb: Float32Array, noseF: number, noseR: number, flag: number) {
    if (this.n >= this.max) return;
    const d = this.data;
    const o = this.n * STRIDE;
    d[o] = u;
    d[o + 1] = v;
    d[o + 2] = w;
    d[o + 3] = fx;
    d[o + 4] = fy;
    d[o + 5] = fz;
    d[o + 6] = len;
    d[o + 7] = wid;
    d[o + 8] = hgt;
    d[o + 9] = car;
    d[o + 10] = rgb[0];
    d[o + 11] = rgb[1];
    d[o + 12] = rgb[2];
    d[o + 13] = noseF;
    d[o + 14] = noseR;
    d[o + 15] = flag;
    this.ids[this.n++] = id;
  }
  commit() {
    this.geo.instanceCount = this.n;
    this.buf.clearUpdateRanges();
    if (this.n) {
      this.buf.addUpdateRange(0, this.n * STRIDE);
      this.buf.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }
  dispose() {
    this.geo.dispose();
  }
}

type Slot = { t?: TrainState; spec: Spec; seen: number; phase: number; elev: number; elevLon: number; elevLat: number; slope: number; sampled: boolean; tunnel: boolean };
export type TrainLayerStats = { trains: number; buses: number; ghosts: number; cars: number; drawCalls: number; triangles: number; msPerFrame: number; msUpdate: number; elevationQueriesPerFrame: number };

export class TrainLayer implements CustomLayerInterface {
  readonly id = "rail3d-trains";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  stats: TrainLayerStats = { trains: 0, buses: 0, ghosts: 0, cars: 0, drawCalls: 0, triangles: 0, msPerFrame: 0, msUpdate: 0, elevationQueriesPerFrame: 0 };

  private renderer?: WebGLRenderer;
  private scene = new Scene();
  private camera = new Camera();
  private toWorld = new Matrix4();
  private mvp = new Matrix4();
  private inv = new Matrix4();
  private shared = { u_matrix: { value: new Matrix4() }, u_cam: { value: new Vector3() }, u_sun: { value: new Vector3(-0.42, 0.52, 0.74).normalize() }, u_detail: { value: 0 } };
  private trainMat: RawShaderMaterial;
  private busMat: RawShaderMaterial;
  private ghostMat: RawShaderMaterial;
  private haloMat: RawShaderMaterial;
  private bodies: Batch;
  private buses: Batch;
  private ghosts: Batch;
  private cars: Batch;
  private halo: Mesh;
  private batches: Batch[];
  private bodyMats: RawShaderMaterial[];
  private slots = new Map<string, Slot>();
  private colours = new Map<string, Float32Array>();
  private tunnels?: Tunnels;
  private tracks?: Tracks;
  private tracksLoading?: Promise<void>;
  private frameNo = 0;
  private slotNo = 0;
  private queries = 0;
  private ll: [number, number] = [0, 0];
  private dists = new Float64Array(64);
  private pts = new Float64Array(128);
  // per-frame values read by the per-train callback
  private zoom = 0;
  private mpp = 1;
  private minLen = 0;
  private minW = 0;
  private minH = 0;
  private resample = 15; // metres a train moves before its elevation is sampled again
  private wCentre = 1; // clip-space w (depth) of the map centre
  private tag?: { el: HTMLDivElement; line: HTMLSpanElement; late: HTMLSpanElement; text: string };
  private sel?: string;
  private selT?: TrainState;
  private selLon = 0;
  private selLat = 0;
  private pal = COLOURS;

  constructor(
    private map: LibreMap,
    /** The trains to draw, and whether to draw them (the App's "Trains" toggle); both may change between 3D sessions. */
    public trains: TrainCanvas,
    public show: () => boolean,
  ) {
    const make = (vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, transparent: boolean) =>
      new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, transparent, premultipliedAlpha: true, depthWrite: !transparent, side: DoubleSide });
    this.trainMat = make(VERT, FRAG, { ...this.shared, u_nose: { value: 1.4 }, u_alpha: { value: 1 }, u_win: { value: [0.42, 0.72] } }, false);
    this.busMat = make(VERT, FRAG, { ...this.shared, u_nose: { value: 0.12 }, u_alpha: { value: 1 }, u_win: { value: [0.4, 0.86] } }, false);
    this.ghostMat = make(VERT, FRAG, { ...this.shared, u_nose: { value: 1.4 }, u_alpha: { value: 0.34 }, u_win: { value: [0.42, 0.72] } }, true);
    this.haloMat = make(HALO_VERT, HALO_FRAG, { u_matrix: this.shared.u_matrix, u_center: { value: new Vector3() }, u_radius: { value: 1 }, u_phase: { value: 0 }, u_color: { value: new Vector3(0, 121 / 255, 199 / 255) } }, true);
    this.haloMat.depthTest = false;
    this.bodyMats = [this.trainMat, this.busMat, this.ghostMat];
    const train = TRAIN_SHAPE();
    this.bodies = new Batch(train, 4096, this.trainMat);
    this.buses = new Batch(BUS_SHAPE(), 512, this.busMat);
    this.cars = new Batch(train, 32, this.trainMat);
    this.ghosts = new Batch(train, 1024, this.ghostMat);
    this.batches = [this.bodies, this.buses, this.ghosts, this.cars];
    this.halo = new Mesh(new PlaneGeometry(1, 1), this.haloMat);
    this.halo.frustumCulled = false;
    this.halo.matrixAutoUpdate = false;
    // opaque first, then the ghosts, then the halo on top (no sorting: the order below is the draw order)
    this.scene.add(this.bodies.mesh, this.buses.mesh, this.cars.mesh, this.ghosts.mesh, this.halo);
    this.scene.matrixAutoUpdate = false;
    void Tunnels.load()
      .then((t) => (this.tunnels = t))
      .catch((e) => console.warn("[3d] tunnels unavailable", e));
  }

  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    if (this.renderer) return; // added again after a style change: keep the GPU resources
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl as unknown as WebGLRenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.sortObjects = false;
    // compile every program now rather than on the first selection or tunnel (a visible hitch); visibility is set per frame
    for (const o of this.scene.children) o.visible = true;
    this.renderer.compile(this.scene, this.camera);
    // three.js touched the GL state while setting up: let MapLibre set everything again
    (map as unknown as { painter?: { context?: { setDirty?: () => void } } }).painter?.context?.setDirty?.();
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const renderer = this.renderer;
    if (!renderer) return;
    const t0 = performance.now();
    this.frame(args);
    this.stats.msUpdate = this.stats.msUpdate * 0.95 + (performance.now() - t0) * 0.05;
    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.render(this.scene, this.camera);
    const info = renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.msPerFrame = this.stats.msPerFrame * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** The train under a screen point (CSS px), measured along each train's drawn body. */
  hit(x: number, y: number): string | undefined {
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const m = this.mvp.elements;
    const screen = (u: number, v: number, z: number, out: number[]) => {
      const cw = m[3] * u + m[7] * v + m[11] * z + m[15];
      if (cw <= 0) return false;
      out[0] = ((m[0] * u + m[4] * v + m[8] * z + m[12]) / cw + 1) * 0.5 * w;
      out[1] = (1 - (m[1] * u + m[5] * v + m[9] * z + m[13]) / cw) * 0.5 * h;
      return true;
    };
    const a = [0, 0];
    const b = [0, 0];
    let best: string | undefined;
    let bestD = Infinity;
    for (const batch of [this.cars, this.bodies, this.buses, this.ghosts]) {
      const d = batch.data;
      for (let i = 0; i < batch.n; i++) {
        const o = i * STRIDE;
        const z = d[o + 2] + d[o + 8] * 0.5;
        const len = d[o + 6];
        const fl = Math.hypot(d[o + 3], d[o + 4], d[o + 5]) || 1;
        if (!screen(d[o], d[o + 1], z, a) || !screen(d[o] - (d[o + 3] / fl) * len, d[o + 1] - (d[o + 4] / fl) * len, z - (d[o + 5] / fl) * len, b)) continue;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const dist = Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
        const reach = 10 + (d[o + 7] / this.mpp) * 0.5;
        if (dist < reach && dist < bestD) {
          bestD = dist;
          best = batch.ids[i];
        }
      }
    }
    return best;
  }

  /** Hands the tracks loader a head start (the selected train's cars follow the track). */
  private ensureTracks() {
    this.tracksLoading ??= Tracks.load()
      .then((t) => void (this.tracks = t))
      .catch((e) => console.warn("[3d] network unavailable for the selected train's cars", e));
  }

  private rgb(hex: string) {
    let c = this.colours.get(hex);
    if (!c) {
      const n = parseInt(hex.slice(1), 16);
      c = new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
      this.colours.set(hex, c);
    }
    return c;
  }

  private elevation(lon: number, lat: number) {
    this.queries++;
    this.ll[0] = lon;
    this.ll[1] = lat;
    return this.map.queryTerrainElevation(this.ll) ?? 0;
  }

  /** How much farther than the map centre a point is from the camera, softened: far trains shrink, but slower than perspective. */
  private farther(u: number, v: number, z: number) {
    const m = this.mvp.elements;
    const w = m[3] * u + m[7] * v + m[11] * z + m[15];
    return w > 0 ? Math.min(3, Math.max(0.7, Math.sqrt(w / this.wCentre))) : 1;
  }

  private onScreen(u: number, v: number, z: number) {
    const m = this.mvp.elements;
    const cw = m[3] * u + m[7] * v + m[11] * z + m[15];
    if (cw <= 0) return false;
    const nx = (m[0] * u + m[4] * v + m[8] * z + m[12]) / cw;
    const ny = (m[1] * u + m[5] * v + m[9] * z + m[13]) / cw;
    return nx > -1.4 && nx < 1.4 && ny > -1.4 && ny < 1.4;
  }

  private frame(args: CustomRenderMethodInput) {
    const map = this.map;
    this.frameNo++;
    this.queries = 0;
    const zoom = map.getZoom();
    const centre = map.getCenter();
    const lat = centre.lat;
    const ws = 512 * 2 ** zoom;
    this.zoom = zoom;
    this.mpp = (C * Math.cos(lat * RAD)) / ws;
    const near = Math.min(1, Math.max(0, (zoom - 8.5) / 3.5));
    this.minLen = this.mpp * (MIN_PX_FAR.len + (MIN_PX_NEAR.len - MIN_PX_FAR.len) * near);
    this.minW = this.mpp * (MIN_PX_FAR.w + (MIN_PX_NEAR.w - MIN_PX_FAR.w) * near);
    this.minH = this.mpp * (MIN_PX_FAR.h + (MIN_PX_NEAR.h - MIN_PX_FAR.h) * near);
    this.resample = Math.max(15, this.mpp * 3); // finer than that the drawn relief cannot show
    // local metres -> MapLibre world (pixels at this zoom, z in metres) -> clip space, composed in float64
    this.toWorld.set(K * ws, 0, 0, OX * ws, 0, -K * ws, 0, OY * ws, 0, 0, 1, 0, 0, 0, 0, 1);
    this.mvp.fromArray(args.modelViewProjectionMatrix as ArrayLike<number> as number[]).multiply(this.toWorld);
    this.shared.u_matrix.value.copy(this.mvp);
    const e = this.inv.copy(this.mvp).invert().elements;
    this.shared.u_cam.value.set(e[8] / e[11], e[9] / e[11], e[10] / e[11]);
    this.shared.u_detail.value = Math.min(1, Math.max(0, (zoom - 13) / 1.5));
    this.cullSide(centre.lng, lat);
    {
      const m = this.mvp.elements;
      const cu = ((centre.lng + 180) / 360 - OX) / K;
      const cv = (OY - mercY(lat)) / K;
      this.wCentre = Math.max(1e-9, m[3] * cu + m[7] * cv + m[11] * this.elevation(centre.lng, lat) + m[15]);
    }

    for (const b of this.batches) b.n = 0;
    this.sel = this.trains.selected;
    this.selT = undefined;
    this.pal = this.trains.theme === "dark" ? DARK_COLOURS : COLOURS;
    if (this.show()) this.trains.forEachTrain(this.each);
    if (this.selT) this.drawSelected(this.selT, this.selLon, this.selLat);
    else {
      this.halo.visible = false;
      this.placeTag();
    }
    for (const b of this.batches) b.commit();
    // forget trains that left service
    if (this.frameNo % 120 === 0) for (const [id, s] of this.slots) if (this.frameNo - s.seen > 240) this.slots.delete(id);
    const st = this.stats;
    st.trains = this.bodies.n;
    st.buses = this.buses.n;
    st.ghosts = this.ghosts.n;
    st.cars = this.cars.n;
    st.elevationQueriesPerFrame = st.elevationQueriesPerFrame * 0.95 + this.queries * 0.05;
  }

  /** Front faces are counter-clockwise on screen unless the projection mirrors them: check once per frame. */
  private cullSide(lon: number, lat: number) {
    const m = this.mvp.elements;
    const u = ((lon + 180) / 360 - OX) / K;
    const v = (OY - mercY(lat)) / K;
    // an upward-facing triangle at the map centre, counter-clockwise seen from above
    const w0 = m[3] * u + m[7] * v + m[15];
    const w1 = w0 + m[3];
    const w2 = w0 + m[7];
    const ax = (m[0] * u + m[4] * v + m[12]) / w0;
    const ay = (m[1] * u + m[5] * v + m[13]) / w0;
    const bx = (m[0] * (u + 1) + m[4] * v + m[12]) / w1;
    const by = (m[1] * (u + 1) + m[5] * v + m[13]) / w1;
    const cx = (m[0] * u + m[4] * (v + 1) + m[12]) / w2;
    const cy = (m[1] * u + m[5] * (v + 1) + m[13]) / w2;
    const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
    const side = ccw ? FrontSide : BackSide;
    for (const mat of this.bodyMats) if (mat.side !== side) mat.side = side;
  }

  private each = (t: TrainState, lon: number, lat: number) => {
    let s = this.slots.get(t.id);
    if (!s) {
      s = { spec: DEFAULT_SPEC, seen: 0, phase: this.slotNo++ % ELEV_EVERY, elev: 0, elevLon: 0, elevLat: 0, slope: 0, sampled: false, tunnel: false };
      this.slots.set(t.id, s);
    }
    s.seen = this.frameNo;
    if (s.t !== t) {
      s.t = t;
      s.spec = SPECS[t.cat] ?? DEFAULT_SPEC;
    }
    if (t.id === this.sel) {
      this.selT = t;
      this.selLon = lon;
      this.selLat = lat;
      return;
    }
    const sp = s.spec;
    const u = ((lon + 180) / 360 - OX) / K;
    const v = (OY - mercY(lat)) / K;
    const k = this.farther(u, v, s.elev);
    const len = Math.max(sp.len, this.minLen * k);
    const wid = Math.max(sp.w, this.minW * k);
    const hgt = Math.max(sp.h, this.minH * k);
    const fx = Math.sin(t.bearing * RAD);
    const fy = Math.cos(t.bearing * RAD);
    // terrain elevation under the head (and the tail, for the slope), sampled in a rolling window
    const moved = Math.abs(lon - s.elevLon) * 76_000 + Math.abs(lat - s.elevLat) * 111_000 > this.resample;
    // nothing in Switzerland lies at 0 m: 0 means the relief under the train had not loaded yet, so ask again soon
    const due = (this.frameNo + s.phase) % (s.elev === 0 ? 8 : ELEV_EVERY) === 0;
    if ((!s.sampled || moved || due) && (!s.sampled || this.onScreen(u, v, s.elev))) {
      s.elev = this.elevation(lon, lat);
      s.elevLon = lon;
      s.elevLat = lat;
      s.sampled = true;
      if (len === sp.len && this.zoom >= 12) {
        const back = len / 111_320;
        const tail = this.elevation(lon - (fx * back) / Math.cos(lat * RAD), lat - fy * back);
        s.slope = (s.elev - tail) / len;
      } else s.slope = 0;
    }
    if (this.tunnels && (this.frameNo + s.phase) % TUNNEL_EVERY === 0) s.tunnel = this.tunnels.contains(lon, lat);
    // lift what is drawn larger than life a little, so its ends do not sink into the coarse relief of a far view
    const w = s.elev + 0.3 + (hgt - sp.h) * 0.35;
    const rgb = this.rgb(colourOf(t.state, t.delay, t.atStop, this.pal));
    const flag = this.trains.simulated.has(t.id) ? 1 : 0;
    const batch = sp.bus ? this.buses : s.tunnel && this.zoom >= 10.5 ? this.ghosts : this.bodies;
    batch.push(t.id, u, v, w, fx, fy, s.slope, len, wid, hgt, sp.car * (len / sp.len), rgb, 1, 1, flag);
  };

  /** The selected train: its cars along the track behind the head when close enough, and the halo around it. */
  private drawSelected(t: TrainState, lon: number, lat: number) {
    const s = this.slots.get(t.id)!;
    const sp = s.spec;
    const hu = ((lon + 180) / 360 - OX) / K;
    const hv = (OY - mercY(lat)) / K;
    const head = this.elevation(lon, lat);
    const k = this.farther(hu, hv, head);
    const len = Math.max(sp.len, this.minLen * k);
    const wid = Math.max(sp.w, this.minW * k);
    const hgt = Math.max(sp.h, this.minH * k);
    const rgb = this.rgb(this.pal.selected);
    const flag = 2 + (this.trains.simulated.has(t.id) ? 1 : 0);
    if (this.tunnels && this.frameNo % 6 === 0) s.tunnel = this.tunnels.contains(lon, lat);
    const batch = sp.bus ? this.buses : s.tunnel && this.zoom >= 10.5 ? this.ghosts : this.cars;
    const fx = Math.sin(t.bearing * RAD);
    const fy = Math.cos(t.bearing * RAD);
    let tu = hu - fx * len;
    let tv = hv - fy * len;
    const real = len === sp.len && !sp.bus && this.zoom >= 12.5;
    if (real) this.ensureTracks();
    const nCars = Math.max(1, Math.min(24, Math.round((sp.len + GAP) / (sp.car + GAP))));
    const car = (sp.len - GAP * (nCars - 1)) / nCars;
    let laid = false;
    if (real && this.tracks && nCars > 1) {
      const d = this.dists;
      for (let k = 0; k < nCars; k++) {
        d[2 * k] = k * (car + GAP);
        d[2 * k + 1] = k * (car + GAP) + car;
      }
      if (this.tracks.behind(lon, lat, t.bearing, d, 2 * nCars, this.pts)) {
        laid = true;
        const p = this.pts;
        for (let k = 0; k < nCars; k++) {
          const flon = p[4 * k];
          const flat = p[4 * k + 1];
          const rlon = p[4 * k + 2];
          const rlat = p[4 * k + 3];
          const fu = ((flon + 180) / 360 - OX) / K;
          const fv = (OY - mercY(flat)) / K;
          const ru = ((rlon + 180) / 360 - OX) / K;
          const rv = (OY - mercY(rlat)) / K;
          const ef = k === 0 ? head : this.elevation(flon, flat);
          const er = this.elevation(rlon, rlat);
          const dx = fu - ru;
          const dy = fv - rv;
          const dl = Math.hypot(dx, dy) || 1;
          batch.push(t.id, fu, fv, ef + 0.3, dx / dl, dy / dl, (ef - er) / dl, car, wid, hgt, car, rgb, k === 0 ? 1 : 0, k === nCars - 1 ? 1 : 0, flag);
          if (k === nCars - 1) {
            tu = ru;
            tv = rv;
          }
        }
      }
    }
    if (!laid) batch.push(t.id, hu, hv, head + 0.3 + (hgt - sp.h) * 0.35, fx, fy, 0, len, wid, hgt, sp.car * (len / sp.len), rgb, 1, 1, flag);
    // halo: centred on the whole train, never smaller than ~24 px across
    const h = this.haloMat.uniforms;
    (h.u_center.value as Vector3).set((hu + tu) / 2, (hv + tv) / 2, head + 0.5);
    h.u_radius.value = Math.max(Math.hypot(hu - tu, hv - tv) * 0.62 + 12, this.mpp * 24 * k);
    h.u_phase.value = (performance.now() % 1400) / 1400;
    this.halo.visible = true;
    this.placeTag(t, hu, hv, head + hgt * 1.1);
  }

  /** The selected train's SBB-style tag (line, delay) next to its head, as in 2D. */
  private placeTag(t?: TrainState, u = 0, v = 0, z = 0) {
    const m = this.mvp.elements;
    const w = m[3] * u + m[7] * v + m[11] * z + m[15];
    if (!t || w <= 0) {
      if (this.tag) this.tag.el.style.display = "none";
      return;
    }
    if (!this.tag) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;left:0;top:0;z-index:2;pointer-events:none;padding:1px 6px;border-radius:4px;background:#212121;color:#fff;font:700 12px/16px 'SBB Web','Helvetica Neue',Arial,sans-serif;white-space:nowrap;box-shadow:0 0 0 1px rgba(255,255,255,0.5),0 1px 4px rgba(0,0,0,0.35);will-change:transform";
      const line = document.createElement("span");
      const late = document.createElement("span");
      late.style.color = "#ff8a8a";
      el.append(line, late);
      this.map.getCanvasContainer().appendChild(el);
      this.tag = { el, line, late, text: "" };
    }
    const tag = this.tag;
    const late = t.delay >= 60 ? ` +${Math.round(t.delay / 60)}′` : "";
    if (tag.text !== t.line + late) {
      tag.text = t.line + late;
      tag.line.textContent = t.line;
      tag.late.textContent = late;
    }
    const canvas = this.map.getCanvas();
    const x = ((m[0] * u + m[4] * v + m[8] * z + m[12]) / w + 1) * 0.5 * canvas.clientWidth;
    const y = (1 - (m[1] * u + m[5] * v + m[9] * z + m[13]) / w) * 0.5 * canvas.clientHeight;
    tag.el.style.display = "";
    tag.el.style.transform = `translate(${Math.round(x + 12)}px, ${Math.round(y - 20)}px)`;
  }

  onRemove() {
    if (this.tag) this.tag.el.style.display = "none";
  }

  dispose() {
    this.tag?.el.remove();
    this.tag = undefined;
    for (const b of this.batches) b.dispose();
    this.halo.geometry.dispose();
    for (const m of [this.trainMat, this.busMat, this.ghostMat, this.haloMat]) m.dispose();
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
