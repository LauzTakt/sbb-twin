// The twin: every train's position each second.
// Real mode: the train follows its real timeline (planned timetable + GTFS-RT predictions) along its track path,
// with smooth convergence when a prediction changes. Sim mode: a provoked disruption took control of the
// train (it brakes, holds, runs slowly); it keeps its own behaviour, with physics, until it is synced back.
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "./config.ts";
import { loadDay, stops, type Trip } from "./timetable.ts";
import { edgeId, edgeSpans, edgeTracks, metres, pathBetween, pointAt, type Path } from "./geometry.ts";
import { live, type TripLive } from "./realtime.ts";
import { addSystemDisruption, disruptions, type Disruption } from "./disruptions.ts";
import { addDays, zurich } from "./time.ts";

export type Motion = "running" | "dwelling" | "held" | "stopped" | "cancelled";
export type Train = {
  trip: Trip;
  eArr: Float64Array; // reference timeline, epoch ms (real: planned + live predictions; frozen in sim mode)
  eDep: Float64Array;
  skipped: Uint8Array;
  actArr: Float64Array; // actual times the twin observed, NaN until passed
  actDep: Float64Array;
  mode: "real" | "sim";
  tau: number; // where the train is on its reference timeline (epoch ms)
  warp: number; // real mode: t - tau, eased to 0 after a prediction change
  speed: number; // m/s
  accel: number;
  motion: Motion;
  call: number;
  leg: number; // -1 at a station
  s: number; // metres along the current leg
  lon: number;
  lat: number;
  bearing: number;
  edgeRef: number;
  bav: boolean;
  causes: Set<string>;
  holds: Map<string, number>; // disruption id -> wall time the hold started
  cancelled: boolean;
  cancelReason?: "realtime" | "provoked";
  cancelledAt?: number;
  hasRealtime: boolean;
  infoSig: string;
  infoAt: number;
  continuity: number; // +1 on every discontinuous jump (sync, large prediction change): do not interpolate across it
};

const BRAKE = 0.7; // m/s², service braking
const accelFor = (cat: string) => (cat === "EV" ? 0.9 : /^(S|SN|R|RE|T|PE|BAT|D)$/.test(cat) ? 0.7 : /^(IC|ICE|IR|IRE|EC|EN|NJ|RJX|TGV|ICN)$/.test(cat) ? 0.45 : 0.6);

/** Trapezoidal run between two stops: accelerate, cruise, brake, so that L metres take T seconds. */
function profile(L: number, T: number, a: number, u: number) {
  if (T <= 0.5 || L <= 0.5) return { s: u > 0 ? L : 0, v: 0 };
  let acc = a;
  let disc = acc * acc * T * T - 4 * acc * L;
  if (disc < 0) {
    acc = (4 * L) / (T * T);
    disc = 0;
  }
  const v = (acc * T - Math.sqrt(disc)) / 2;
  const t1 = v / acc;
  if (u <= 0) return { s: 0, v: 0 };
  if (u >= T) return { s: L, v: 0 };
  if (u < t1) return { s: 0.5 * acc * u * u, v: acc * u };
  if (u > T - t1) {
    const r = T - u;
    return { s: L - 0.5 * acc * r * r, v: acc * r };
  }
  return { s: 0.5 * acc * t1 * t1 + v * (u - t1), v };
}
function invert(L: number, T: number, a: number, s: number) {
  if (s <= 0) return 0;
  if (s >= L) return T;
  let lo = 0;
  let hi = T;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (profile(L, T, a, mid).s < s) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Real timeline of a trip: planned times shifted by the live predictions, made physically consistent. */
function timeline(trip: Trip, rt?: TripLive) {
  const n = trip.arr.length;
  const eArr = new Float64Array(trip.arr);
  const eDep = new Float64Array(trip.dep);
  const skipped = new Uint8Array(n);
  if (rt?.updates.length) {
    const arrD: (number | undefined)[] = new Array(n).fill(undefined);
    const depD: (number | undefined)[] = new Array(n).fill(undefined);
    let from = 0;
    for (const u of rt.updates) {
      let k = -1;
      if (u.stopId) for (let i = from; i < n; i++) if (stops[trip.stops[i]]?.id === u.stopId) { k = i; break; }
      if (k < 0) continue;
      from = k;
      arrD[k] = u.arrDelay !== undefined ? u.arrDelay * 1000 : u.arrTime ? u.arrTime * 1000 - trip.arr[k] : undefined;
      depD[k] = u.depDelay !== undefined ? u.depDelay * 1000 : u.depTime ? u.depTime * 1000 - trip.dep[k] : undefined;
      if (u.skipped) skipped[k] = 1;
    }
    let cur = arrD.find((x) => x !== undefined) ?? depD.find((x) => x !== undefined) ?? 0;
    for (let i = 0; i < n; i++) {
      if (arrD[i] !== undefined) cur = arrD[i]!;
      eArr[i] = trip.arr[i] + cur;
      if (depD[i] !== undefined) cur = depD[i]!;
      eDep[i] = Math.max(trip.dep[i] + cur, eArr[i], trip.dep[i]); // trains never leave early
    }
  }
  for (let i = 1; i < n; i++) {
    const planned = trip.arr[i] - trip.dep[i - 1];
    eArr[i] = Math.max(eArr[i], eDep[i - 1] + Math.max(20_000, 0.6 * planned));
    if (eDep[i] < eArr[i]) eDep[i] = eArr[i];
    if (skipped[i]) eDep[i] = eArr[i];
    // Timetables often show no dwell; a real stop takes ~20 s, borrowed from the approach.
    else if (i < n - 1 && eDep[i] - eArr[i] < 20_000 && eArr[i] - eDep[i - 1] >= 90_000) eArr[i] = eDep[i] - 20_000;
  }
  return { eArr, eDep, skipped };
}

const legPath = (trip: Trip, i: number) => pathBetween(stops[trip.stops[i]], stops[trip.stops[i + 1]]);
const legT = (tr: Train, i: number) => (tr.eArr[i + 1] - tr.eDep[i]) / 1000;

/** Where a train is when it is at time tau of its reference timeline. */
function place(tr: Train, tau: number) {
  const { eArr, eDep, trip } = tr;
  const n = eArr.length;
  let call = 0;
  let leg = -1;
  let u = 0;
  if (tau >= eArr[n - 1]) call = n - 1;
  else if (tau > eDep[0]) {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (eArr[mid] <= tau) lo = mid;
      else hi = mid;
    }
    call = lo;
    if (tau > eDep[lo]) {
      leg = lo;
      u = (tau - eDep[lo]) / 1000;
    }
  }
  if (leg >= 0) {
    const path = legPath(trip, leg);
    const { s, v } = profile(path.len, legT(tr, leg), tr.accel, u);
    return { call, leg, s, v, path, ...pointAt(path, s) };
  }
  const path = call < n - 1 ? legPath(trip, call) : legPath(trip, call - 1);
  const s = call < n - 1 ? 0 : path.len;
  return { call, leg, s, v: 0, path, ...pointAt(path, s) };
}

// ---------------------------------------------------------------- disruption effects
// brake: stop as soon as possible; brakeRate: deceleration (service 0.7, emergency 1.2 m/s²);
// cruise: driven speed (m/s) instead of the timetable pace; hard: a point the train cannot pass (an obstacle or a
// train stopped ahead when protection is off).
type Limits = { limit: number; caps: { from: number; to: number; v: number }[]; causes: string[]; brake: boolean; brakeRate: number; cruise?: number; hard?: { at: number; d?: Disruption; rear?: Train } };
const MAX_KMH = (cat: string) => (cat === "EV" ? 80 : /^(IC|ICE|IR|IRE|EC|EN|NJ|RJX|TGV|ICN)$/.test(cat) ? 200 : /^(RE)$/.test(cat) ? 160 : 140);
export const collisions: { trainId: string; disruptionId: string; impactKmh: number; t: number; withTrain?: string }[] = [];
/** God-mode switches. protection = train protection/signalling: with it, a train never runs into one stopped ahead. */
export const settings = { protection: true };
const SIGHT_M = 500; // without protection, a driver sees a stopped train this far ahead
let stoppedOnLine: Train[] = [];
const sameDir = (a: number, b: number) => Math.sign(a) === Math.sign(b);

function legLimits(tr: Train, leg: number, path: Path, sCur: number, vCur: number): Limits {
  const out: Limits = { limit: Infinity, caps: [], causes: [], brake: false, brakeRate: BRAKE };
  const spans = edgeSpans(path);
  const id = tr.trip.trainId;
  for (const d of disruptions.values()) {
    if (d.endedAt) continue;
    if (d.effect === "section_closure") {
      const hit = spans.find((sp) => sp.to > sCur && d.edges.has(Math.abs(sp.ref)));
      if (!hit) continue;
      if (sCur < hit.from - 150) out.limit = Math.min(out.limit, hit.from - 150);
      else out.brake = true; // already inside the closed section: stop where it can
      out.causes.push(d.id);
    } else if (d.effect === "target_speed" && d.scope.kind === "train" && d.scope.trainId === id) {
      out.cruise = Math.min(MAX_KMH(tr.trip.cat), Math.max(5, d.params.kmh ?? 100)) / 3.6;
      out.causes.push(d.id);
    } else if (d.effect === "obstacle" && d.scope.kind === "train" && d.scope.trainId === id) {
      if (d.params.collidedAt) {
        out.brake = true; // immobilised after the impact
        out.causes.push(d.id);
      } else if (d.params.atLeg === leg && (d.params.atS ?? 0) > sCur - 1) {
        out.hard = { at: d.params.atS ?? 0, d };
        out.limit = Math.min(out.limit, d.params.atS ?? 0);
        out.brakeRate = Math.max(out.brakeRate, 1.2); // the driver sees it: emergency braking
        out.causes.push(d.id);
      }
    } else if (d.effect === "train_speed" && d.scope.kind === "train" && d.scope.trainId === id) {
      out.caps.push({ from: 0, to: path.len, v: Math.max(5, d.params.maxKmh ?? 60) / 3.6 });
      out.causes.push(d.id);
    } else if (d.effect === "speed_restriction") {
      for (const sp of spans) if (sp.to > sCur && d.edges.has(Math.abs(sp.ref))) out.caps.push({ from: sp.from, to: sp.to, v: (d.params.maxKmh ?? 40) / 3.6 });
      if (out.caps.length) out.causes.push(d.id);
    } else if (d.effect === "signal_failure" && d.station !== undefined) {
      const v = (d.params.maxKmh ?? 30) / 3.6;
      if (tr.trip.stops[leg] === d.station) out.caps.push({ from: 0, to: Math.min(path.len, 1500), v });
      if (tr.trip.stops[leg + 1] === d.station) out.caps.push({ from: Math.max(0, path.len - 1500), to: path.len, v });
      if (out.caps.length) out.causes.push(d.id);
    } else if ((d.effect === "train_breakdown" || (d.effect === "obstacle" && d.params.collidedAt)) && d.scope.kind === "train") {
      if (d.scope.trainId === id) {
        out.brake = true;
        if (d.params.brakeMs2) out.brakeRate = Math.max(out.brakeRate, d.params.brakeMs2);
        out.causes.push(d.id);
        continue;
      }
      if (!settings.protection) continue; // no signalling: see sightLimits
      const broken = byTrainId.get(d.scope.trainId);
      if (!broken || broken.cancelled) continue;
      if (broken.leg >= 0 && broken.trip.stops[broken.leg] === tr.trip.stops[leg] && broken.trip.stops[broken.leg + 1] === tr.trip.stops[leg + 1]) {
        if (broken.s > sCur) {
          out.limit = Math.min(out.limit, Math.max(sCur, broken.s - 400));
          out.causes.push(d.id);
        }
        continue;
      }
      if (!broken.edgeRef) continue;
      const single = edgeTracks(broken.edgeRef) < 2;
      const hit = spans.find((sp) => sp.to > sCur && Math.abs(sp.ref) === Math.abs(broken.edgeRef) && (single || sameDir(sp.ref, broken.edgeRef)));
      if (!hit) continue;
      if (sCur < hit.from - 150) out.limit = Math.min(out.limit, hit.from - 150);
      else {
        // already on that track: stop behind it if it is ahead of us
        const end = pointAt(path, hit.to);
        const ours = hit.to - sCur;
        const theirs = metres(broken.lon, broken.lat, end.lon, end.lat);
        if (ours > theirs) out.limit = Math.min(out.limit, Math.max(sCur, sCur + ours - theirs - 400));
        else continue;
      }
      out.causes.push(d.id);
    }
  }
  if (!settings.protection) sightLimits(tr, leg, path, sCur, out);
  return out;
}

/** Without train protection a driver only reacts to a train stopped ahead once it is in sight: emergency braking,
 * and a rear-end collision if the distance is too short. */
function sightLimits(tr: Train, leg: number, path: Path, sCur: number, out: Limits) {
  const spans = edgeSpans(path);
  for (const other of stoppedOnLine) {
    if (other === tr || other.cancelled) continue;
    let gap: number | undefined;
    if (other.trip.stops[other.leg] === tr.trip.stops[leg] && other.trip.stops[other.leg + 1] === tr.trip.stops[leg + 1]) {
      if (other.s > sCur) gap = other.s - sCur;
    } else if (other.edgeRef) {
      const single = edgeTracks(other.edgeRef) < 2;
      const hit = spans.find((sp) => sp.to > sCur && Math.abs(sp.ref) === Math.abs(other.edgeRef) && (single || sameDir(sp.ref, other.edgeRef)));
      if (hit) {
        const end = pointAt(path, hit.to);
        const ours = hit.to - sCur;
        const theirs = metres(other.lon, other.lat, end.lon, end.lat);
        if (ours > theirs) gap = ours - theirs;
      }
    }
    if (gap === undefined || gap > SIGHT_M) continue;
    const at = sCur + Math.max(0, gap - 25);
    if (!out.hard || at < out.hard.at) out.hard = { at, rear: other };
    out.limit = Math.min(out.limit, at);
    out.brakeRate = Math.max(out.brakeRate, 1.2);
    out.causes.push("protection-off");
  }
}

/** Hold at a station (call i) or skip it. Returns the disruption ids holding the train, and whether to skip. */
function stationRules(tr: Train, i: number, t: number) {
  const n = tr.eArr.length;
  const holding: string[] = [];
  let skip = false;
  let cancel = false;
  const id = tr.trip.trainId;
  for (const d of disruptions.values()) {
    if (d.endedAt) continue;
    if (d.effect === "cancellation" && d.scope.kind === "train" && d.scope.trainId === id) cancel = true;
    if (i >= n - 1) continue;
    if ((d.effect === "station_closure" || (d.effect === "skip_stop" && d.scope.kind === "train" && d.scope.trainId === id)) && d.station === tr.trip.stops[i] && i > 0) {
      skip = true;
      d.affected.add(id);
    } else if (d.effect === "section_closure") {
      if (edgeSpans(legPath(tr.trip, i)).some((sp) => d.edges.has(Math.abs(sp.ref)))) holding.push(d.id);
    } else if ((d.effect === "train_breakdown" || (d.effect === "obstacle" && d.params.collidedAt)) && d.scope.kind === "train") {
      if (d.scope.trainId === id) holding.push(d.id);
      else if (!settings.protection) continue; // no signalling: nobody holds the trains behind
      else {
        const broken = byTrainId.get(d.scope.trainId);
        if (!broken?.edgeRef || broken.cancelled) continue;
        const single = edgeTracks(broken.edgeRef) < 2;
        if (edgeSpans(legPath(tr.trip, i)).some((sp) => Math.abs(sp.ref) === Math.abs(broken.edgeRef) && (single || sameDir(sp.ref, broken.edgeRef)))) holding.push(d.id);
      }
    } else if ((d.effect === "signal_failure" && d.station === tr.trip.stops[i]) || (d.effect === "train_delay" && d.scope.kind === "train" && d.scope.trainId === id)) {
      const started = tr.holds.get(d.id) ?? t;
      tr.holds.set(d.id, started);
      if (t < started + (d.params.holdMinutes ?? 3) * 60_000) holding.push(d.id);
      else if (d.effect === "train_delay") d.endedAt = t; // done: the train continues late
    }
  }
  return { holding, skip, cancel };
}

// ---------------------------------------------------------------- the world
export const trains = new Map<string, Train>(); // by trip key
export const byTrainId = new Map<string, Train>();
let trips: Trip[] = [];
let loadedDate = "";
const finished = new Set<string>();
const meta: Record<string, [string, string, string]> = {};
export const tripMeta = (tripId: string) => meta[tripId];

export async function loadTimetable(t = Date.now()) {
  const today = zurich(t).date;
  if (today === loadedDate) return false;
  trips = await loadDay(today);
  loadedDate = today;
  const m = join(config.dataDir, "trips-meta.json.gz");
  if (existsSync(m) && !Object.keys(meta).length) Object.assign(meta, JSON.parse(gunzipSync(readFileSync(m)).toString()));
  return true;
}
export const timetableDate = () => loadedDate;
export const nextDate = () => addDays(loadedDate, 1);

function makeTrain(trip: Trip, t: number, rt?: TripLive): Train {
  const tl = timeline(trip, rt);
  const tr: Train = {
    trip,
    ...tl,
    actArr: new Float64Array(trip.arr.length).fill(NaN),
    actDep: new Float64Array(trip.arr.length).fill(NaN),
    mode: "real",
    tau: t,
    warp: 0,
    speed: 0,
    accel: accelFor(trip.cat),
    motion: "dwelling",
    call: 0,
    leg: -1,
    s: 0,
    lon: 0,
    lat: 0,
    bearing: 0,
    edgeRef: 0,
    bav: false,
    causes: new Set(),
    holds: new Map(),
    cancelled: Boolean(rt?.cancelled),
    cancelReason: rt?.cancelled ? "realtime" : undefined,
    cancelledAt: rt?.cancelled ? t : undefined,
    hasRealtime: Boolean(rt),
    infoSig: "",
    infoAt: 0,
    continuity: 0,
  };
  settle(tr, place(tr, t), 0);
  return tr;
}

function settle(tr: Train, p: ReturnType<typeof place>, speed: number) {
  tr.call = p.call;
  tr.leg = p.leg;
  tr.s = p.s;
  tr.lon = p.lon;
  tr.lat = p.lat;
  tr.bearing = p.bearing;
  tr.edgeRef = p.edge;
  tr.bav = p.path.bav;
  tr.speed = speed;
}

/** Re-anchor a real-mode train on fresh predictions without a jump: it eases onto the new timeline. */
function refresh(tr: Train) {
  if (tr.mode !== "real" || tr.cancelled) return;
  const rt = live.trips.get(tr.trip.key);
  tr.hasRealtime = Boolean(rt);
  if (rt?.cancelled) {
    cancel(tr, "realtime", Date.now());
    return;
  }
  const oldArr = tr.eArr;
  const next = timeline(tr.trip, rt);
  tr.eArr = next.eArr;
  tr.eDep = next.eDep;
  tr.skipped = next.skipped;
  let tauNew: number;
  if (tr.leg >= 0) {
    const path = legPath(tr.trip, tr.leg);
    tauNew = tr.eDep[tr.leg] + invert(path.len, legT(tr, tr.leg), tr.accel, tr.s) * 1000;
  } else {
    const i = tr.call;
    tauNew = Math.min(Math.max(tr.eArr[i] + (tr.tau - oldArr[i]), tr.eArr[i]), tr.eDep[i]);
  }
  const now = tr.tau + tr.warp;
  const w = now - tauNew;
  tr.warp = Math.abs(w) > 300_000 ? 0 : w;
  if (Math.abs(w) > 300_000) tr.continuity++;
  tr.tau = now - tr.warp;
}

function cancel(tr: Train, reason: Train["cancelReason"], t: number) {
  tr.cancelled = true;
  tr.cancelReason = reason;
  tr.cancelledAt = t;
  tr.motion = "cancelled";
  tr.speed = 0;
}

function step(tr: Train, t: number, dt: number) {
  if (tr.cancelled) return;
  const n = tr.eArr.length;
  let target: number;
  if (tr.mode === "real") {
    if (tr.warp) {
      const k = 0.25 * dt * 1000;
      tr.warp = Math.abs(tr.warp) <= k ? 0 : tr.warp - Math.sign(tr.warp) * k;
    }
    target = t - tr.warp;
  } else target = tr.tau + dt * 1000;
  target = Math.max(target, tr.tau);
  const causes: string[] = [];
  let held = false;

  if (tr.leg < 0) {
    // at a station: may be held, skip it, or end the run here
    const i = tr.call;
    const rules = stationRules(tr, i, t);
    if (rules.cancel) {
      cancel(tr, "provoked", t);
      return;
    }
    if (rules.skip && target < tr.eDep[i]) {
      target = Math.max(target, tr.eDep[i]);
      tr.skipped[i] = 1;
      causes.push(...disruptionsAt(tr, "station_closure"));
    }
    if (rules.holding.length && target >= tr.eDep[i] && i < n - 1) {
      target = Math.min(target, tr.eDep[i] - 1);
      held = true;
      causes.push(...rules.holding);
    }
    if (tr.mode === "sim" && !rules.skip && i < n - 1 && target >= tr.eDep[i] && t < tr.trip.dep[i]) target = Math.min(target, tr.eDep[i] - 1);
  }
  let p = place(tr, target);
  let speed = p.v;
  if (p.leg >= 0 && p.leg === tr.leg && !held) {
    // moving along a leg: brake for closures and stopped trains ahead, obey speed limits
    const lim = legLimits(tr, p.leg, p.path, tr.s, tr.speed);
    if (lim.cruise !== undefined && !lim.brake) {
      // driven: accelerate/brake to the set speed, obey limits, brake to stop at the next station
      const L = p.path.len;
      const rate = lim.brakeRate;
      let v = tr.speed < lim.cruise ? Math.min(lim.cruise, tr.speed + tr.accel * dt) : Math.max(lim.cruise, tr.speed - BRAKE * dt);
      v = Math.min(v, Math.sqrt(2 * BRAKE * Math.max(0, L - tr.s)));
      if (lim.limit < Infinity) v = Math.min(v, Math.sqrt(2 * rate * Math.max(0, lim.limit - tr.s)));
      for (const c of lim.caps) if (tr.s >= c.from - 1 && tr.s <= c.to) v = Math.min(v, Math.max(c.v, tr.speed - BRAKE * dt));
      v = Math.max(v, tr.speed - rate * dt, 0);
      const allowed = Math.min(((tr.speed + v) / 2) * dt, Math.max(0, Math.min(lim.limit, L) - tr.s));
      const reach = tr.s + allowed >= L - 0.5;
      const tauOnLeg = reach ? tr.eArr[p.leg + 1] : tr.eDep[p.leg] + invert(L, legT(tr, p.leg), tr.accel, tr.s + allowed) * 1000;
      target = Math.max(tr.tau, tauOnLeg);
      p = place(tr, target);
      speed = reach ? 0 : v;
      causes.push(...lim.causes);
    } else if (lim.causes.length || tr.mode === "sim") {
      // physics: accelerate at most `accel`, brake at most 1.5x service braking, obey limits and caps
      const ds = Math.max(0, p.s - tr.s);
      const rate = lim.brakeRate;
      let vMax = tr.speed + tr.accel * dt;
      if (lim.brake) vMax = Math.min(vMax, tr.speed - rate * dt);
      if (lim.limit < Infinity) vMax = Math.min(vMax, Math.sqrt(2 * rate * Math.max(0, lim.limit - tr.s)));
      for (const c of lim.caps) {
        if (tr.s >= c.from && tr.s <= c.to) vMax = Math.min(vMax, Math.max(c.v, tr.speed - BRAKE * dt));
        else if (c.from > tr.s) vMax = Math.min(vMax, Math.sqrt(c.v * c.v + 2 * BRAKE * (c.from - tr.s)));
      }
      vMax = Math.max(vMax, tr.speed - rate * dt, 0);
      let allowed = Math.min(ds, ((tr.speed + vMax) / 2) * dt, Math.max(0, lim.limit - tr.s));
      // an obstacle it could not stop for: impact at the remaining speed, then immobilised
      if (lim.hard && !lim.hard.d?.params.collidedAt && tr.s + ((tr.speed + vMax) / 2) * dt >= lim.hard.at - 0.5 && tr.speed > 0.5) {
        allowed = Math.max(0, lim.hard.at - tr.s);
        const impact = Math.round(Math.sqrt(Math.max(0, tr.speed * tr.speed - 2 * rate * allowed)) * 3.6);
        const d =
          lim.hard.d ??
          addSystemDisruption({
            type: "rear_end_collision",
            label: "Rear-end collision",
            reasonCode: "EG_034",
            effect: "obstacle",
            scope: { kind: "train", trainId: tr.trip.trainId },
            where: `${tr.trip.line} → ${tr.trip.head} ran into ${lim.hard.rear!.trip.line} → ${lim.hard.rear!.trip.head}`,
            params: { withTrain: lim.hard.rear!.trip.trainId },
            origin: "train protection off",
          });
        d.params.collidedAt = t;
        d.params.impactKmh = impact;
        d.affected.add(tr.trip.trainId);
        lim.causes.push(d.id);
        collisions.push({ trainId: tr.trip.trainId, disruptionId: d.id, impactKmh: impact, t, withTrain: d.params.withTrain });
        vMax = 0;
      } else if (lim.hard && tr.speed <= 0.5 && tr.s >= lim.hard.at - 2) {
        vMax = 0; // stopped just in time in front of it
      }
      if (allowed < ds - 0.01 || vMax < p.v - 0.05) {
        const path = p.path;
        const tauOnLeg = tr.eDep[p.leg] + invert(path.len, legT(tr, p.leg), tr.accel, tr.s + allowed) * 1000;
        target = Math.max(tr.tau, Math.min(target, tauOnLeg));
        p = place(tr, target);
        speed = lim.hard?.d?.params.collidedAt === t || vMax === 0 ? 0 : Math.min(vMax, (2 * allowed) / dt);
        if (lim.causes.length) causes.push(...lim.causes);
      } else if (tr.mode === "sim") speed = Math.min(p.v, ds / dt);
    }
  } else if (p.leg >= 0 && p.leg !== tr.leg && tr.leg >= 0) {
    // crossed a station within one tick (short stop): fine, physics resumes next tick
  }
  if (causes.length) {
    if (tr.mode === "real") {
      tr.mode = "sim";
      tr.warp = 0;
    }
    for (const c of causes) {
      tr.causes.add(c);
      disruptions.get(c)?.affected.add(tr.trip.trainId);
    }
  }
  tr.tau = target;
  if (p.leg !== tr.leg || p.call !== tr.call) {
    // record the actual times of what the train just did
    if (tr.leg < 0 && p.leg >= 0) tr.actDep[tr.call] = t;
    if (p.leg < 0 && tr.leg >= 0 && Number.isNaN(tr.actArr[p.call])) tr.actArr[p.call] = t;
    for (let i = (tr.leg >= 0 ? tr.leg : tr.call) + 1; i < (p.leg >= 0 ? p.leg + 1 : p.call); i++) {
      tr.actArr[i] = t;
      tr.actDep[i] = t;
    }
    if (p.leg >= 0 && tr.leg >= 0 && p.leg > tr.leg) tr.actDep[p.leg] = t;
  }
  settle(tr, p, speed);
  tr.motion = held ? "held" : p.leg < 0 ? "dwelling" : speed < 0.3 && causes.length ? "stopped" : "running";
}
const disruptionsAt = (tr: Train, effect: Disruption["effect"]) =>
  [...disruptions.values()].filter((d) => !d.endedAt && (d.effect === effect || d.effect === "skip_stop") && d.station === tr.trip.stops[tr.call]).map((d) => d.id);

/** Where an obstacle `metres` ahead of a train lies on its route (current leg, or the next one at a station). */
export function obstacleAhead(tr: Train, metres: number) {
  const n = tr.eArr.length;
  const leg = tr.leg >= 0 ? tr.leg : tr.call < n - 1 ? tr.call : -1;
  if (leg < 0) return undefined;
  const len = legPath(tr.trip, leg).len;
  const from = tr.leg >= 0 ? tr.s : 0;
  return { leg, s: Math.min(len - 5, from + metres) };
}

/** Delay at the next stop in seconds (+ = late): departure delay at intermediate stops (what passengers see),
 * arrival delay at the terminus. */
export function delayOf(tr: Train, t: number) {
  const lag = t - tr.tau;
  const n = tr.eArr.length;
  const k = tr.leg < 0 ? tr.call : tr.leg + 1;
  if (k < n - 1) return Math.round((lag + tr.eDep[k] - tr.trip.dep[k]) / 1000);
  return Math.round((lag + tr.eArr[k] - tr.trip.arr[k]) / 1000);
}
const second = (ms: number) => Math.round(ms / 1000) * 1000;
export const expectedArrival = (tr: Train, k: number, t: number) => second(tr.eArr[k] + (t - tr.tau));
export const expectedDeparture = (tr: Train, k: number, t: number) => second(tr.eDep[k] + (t - tr.tau));
export const nextCall = (tr: Train) => (tr.leg >= 0 ? tr.leg + 1 : Math.min(tr.call + 1, tr.eArr.length - 1));
export const edgeName = (tr: Train) => edgeId(tr.edgeRef);

// ---------------------------------------------------------------- ticking
let lastTick = 0;
const provokedGone = new Map<string, string>(); // trains we cancelled and that left service: trainId -> trip key
let lastActivation = 0;
export type TickResult = { t: number; removed: Train[] };

export function tick(t: number): TickResult {
  const dt = lastTick ? Math.min(5, (t - lastTick) / 1000) : 1;
  lastTick = t;
  if (t - lastActivation >= 5000) {
    lastActivation = t;
    for (const trip of trips) {
      if (trains.has(trip.key) || finished.has(trip.key)) continue;
      const last = trip.arr[trip.arr.length - 1];
      if (trip.dep[0] - 3_600_000 > t || last + 4 * 3_600_000 < t) continue;
      const rt = live.trips.get(trip.key);
      const tl = timeline(trip, rt);
      if (t < tl.eDep[0] - 120_000 || t > tl.eArr[tl.eArr.length - 1] + 60_000) continue;
      const tr = makeTrain(trip, t, rt);
      trains.set(trip.key, tr);
      byTrainId.set(trip.trainId, tr);
    }
  }
  const removed: Train[] = [];
  stoppedOnLine = settings.protection ? [] : [...trains.values()].filter((x) => x.leg >= 0 && x.speed < 0.5 && !x.cancelled);
  for (const tr of trains.values()) {
    step(tr, t, dt);
    // A cancelled train stays visible as "cancelled" for a minute, then leaves service.
    const done = tr.cancelled ? t - (tr.cancelledAt ?? t) > 60_000 : tr.tau >= tr.eArr[tr.eArr.length - 1] + 60_000;
    if (done) removed.push(tr);
  }
  for (const tr of removed) {
    trains.delete(tr.trip.key);
    byTrainId.delete(tr.trip.trainId);
    finished.add(tr.trip.key);
    if (tr.cancelReason === "provoked") provokedGone.set(tr.trip.trainId, tr.trip.key);
  }
  for (const d of disruptions.values()) if (!d.endedAt && d.endsAt && t >= d.endsAt) d.endedAt = t;
  return { t, removed };
}

export function applyRealtime() {
  for (const tr of trains.values()) refresh(tr);
}

/** Back to reality: the train reads the real data again (snaps to its real position). */
export function sync(trainIds?: string[]) {
  const t = Date.now();
  const out: string[] = [];
  for (const tr of trains.values()) {
    if (trainIds && !trainIds.includes(tr.trip.trainId)) continue;
    if (tr.mode === "real" && !(tr.cancelled && tr.cancelReason === "provoked")) continue;
    const rt = live.trips.get(tr.trip.key);
    Object.assign(tr, timeline(tr.trip, rt));
    tr.mode = "real";
    tr.tau = t;
    tr.warp = 0;
    tr.causes.clear();
    tr.holds.clear();
    tr.cancelled = Boolean(rt?.cancelled);
    tr.cancelReason = rt?.cancelled ? "realtime" : undefined;
    tr.cancelledAt = rt?.cancelled ? t : undefined;
    const p = place(tr, t);
    settle(tr, p, p.v);
    tr.motion = p.leg < 0 ? "dwelling" : "running";
    tr.continuity++;
    out.push(tr.trip.trainId);
  }
  // trains we cancelled that already left service come back (from real data) on the next activation pass
  for (const [trainId, key] of provokedGone) {
    if (trainIds && !trainIds.includes(trainId)) continue;
    finished.delete(key);
    provokedGone.delete(trainId);
    out.push(trainId);
  }
  lastActivation = 0;
  return out;
}
