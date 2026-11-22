// Scripted replays of real disruptions: the control centre's decisions at their real times (from the VIA incident
// versions and the TCC messages), applied to the twin as its clock reaches them. Run on a replay clock
// (src/clock.ts) on the day's timetable, e.g.:
//   RAIL_REPLAY=2026-09-10T05:30 RAIL_REPLAY_SPEED=20 RAIL_REPLAY_SCENARIO=waedenswil-2026-09-10 RAIL_DAYS_DIR=/workspace/sbb/gtfs
// or start one with POST /api/replays/{name}/start (steps already due are applied at once, at their own times).
import { disruptions, InputError, type Disruption, type Scenario } from "./disruptions.ts";
import { addMeasure, createScenario, parseTime, scenarioTick, withdrawMeasure } from "./scenario.ts";
import { zurich } from "./time.ts";
import { liveTimes, trains, type Train } from "./engine.ts";
import { stops } from "./timetable.ts";

type Ctx = { d?: Disruption & { scenario: Scenario }; m: Record<string, string> };
type Step = { at: string; note: string; run: (ctx: Ctx, now: number) => void };
type Replay = { title: string; date: string; source: string; steps: Step[] };

const need = (ctx: Ctx) => {
  if (!ctx.d) throw new Error("replay: no disruption yet");
  return ctx.d;
};
const measure = (key: string | null, input: Record<string, unknown>) => (ctx: Ctx, now: number) => {
  const m = addMeasure(need(ctx), input, now);
  if (key) ctx.m[key] = m.id;
};
const withdraw = (key: string, at: string, replaced = false) => (ctx: Ctx, now: number) => {
  withdrawMeasure(need(ctx), ctx.m[key], at, now, replaced);
};

const W = "8503206"; // Wädenswil
const P = "8503209"; // Pfäffikon SZ

export const REPLAYS: Record<string, Replay> = {
  "waedenswil-2026-09-10": {
    title: "Overhead line fault Wädenswil - Pfäffikon SZ, 10 September 2026",
    date: "2026-09-10",
    source: "VIA incident 2195005182293 (12 versions) and its 27 TCC messages, extern-liveticker export",
    steps: [
      { at: "05:43", note: "VIA: interrupted, overhead line fault, end unknown", run: (ctx, now) => void (ctx.d = createScenario({ cause: "EG_008", scope: { kind: "section", from: W, to: P }, effect: "interrupted", durationType: "UNKNOWN" }, now)) },
      { at: "06:54", note: "TCC: replacement buses are being sought", run: measure("sought", { type: "replacement_bus", sought: true }) },
      { at: "06:56", note: "TCC: long-distance trains diverted (the twin turns them back before the section)", run: measure("turn", { type: "short_turn", at: "both" }) },
      { at: "06:58", note: "TCC: S2, S8 and S25 cancelled between Wädenswil and Pfäffikon SZ", run: measure("cancel1", { type: "cancel_lines", lines: ["S2", "S8", "S25"] }) },
      {
        at: "07:13",
        note: "TCC: shuttle bus, Wädenswil at :10, Pfäffikon SZ at :40",
        run: (ctx, now) => {
          withdraw("sought", "07:13", true)(ctx, now);
          measure("bus1", { type: "replacement_bus", minutesA: [10], minutesB: [40] })(ctx, now);
        },
      },
      { at: "07:17", note: "VIA: at least until 12:00", run: measure(null, { type: "prognosis", until: "12:00", durationType: "UNTIL_AT_LEAST" }) },
      {
        at: "08:32",
        note: "TCC: new bus times, Wädenswil :15 and :50, Pfäffikon SZ :22 and :42",
        run: (ctx, now) => {
          withdraw("bus1", "08:32", true)(ctx, now);
          measure("bus2", { type: "replacement_bus", minutesA: [15, 50], minutesB: [22, 42] })(ctx, now);
        },
      },
      { at: "10:35", note: "VIA: at least until 11:00", run: measure(null, { type: "prognosis", until: "11:00", durationType: "UNTIL_AT_LEAST" }) },
      {
        at: "10:53",
        note: "VIA: limited service from 11:00, at least until 19:00",
        run: (ctx, now) => {
          measure(null, { type: "prognosis", until: "19:00", durationType: "UNTIL_AT_LEAST" })(ctx, now);
          measure(null, { type: "partial_resumption", at: "11:00", kmh: 80 })(ctx, now);
        },
      },
      {
        at: "10:55",
        note: "TCC: from 11:00 S2, S25 and IC3 stay cancelled, the S8 and IR35 run; no more buses from 11:00",
        run: (ctx, now) => {
          withdraw("cancel1", "11:00", true)(ctx, now);
          withdraw("turn", "11:00", true)(ctx, now);
          measure(null, { type: "cancel_lines", lines: ["IC3", "S2", "S25"], at: "11:00" })(ctx, now);
          withdraw("bus2", "11:00")(ctx, now);
        },
      },
      { at: "14:19", note: "VIA: at least until 16:00", run: measure(null, { type: "prognosis", until: "16:00", durationType: "UNTIL_AT_LEAST" }) },
      { at: "15:23", note: "VIA: service resumed", run: measure(null, { type: "resume" }) },
    ],
  },
};

let active: { name: string; replay: Replay; next: number; ctx: Ctx; log: { at: number; note: string; error?: string }[] } | undefined;

/** Start a replay: its steps run as the clock reaches their times (those already due run at once). */
export function startReplay(name: string) {
  const replay = REPLAYS[name];
  if (!replay) throw new InputError(`Unknown replay "${name}" (${Object.keys(REPLAYS).join(", ")})`);
  if (zurich(Date.now()).date !== replay.date) throw new InputError(`This replay needs the twin's clock on ${replay.date} (RAIL_REPLAY=${replay.date}T05:30)`);
  active = { name, replay, next: 0, ctx: { m: {} }, log: [] };
  replayTick(Date.now());
  return replayStatus();
}

/** Run the steps that are due (each at its own time). */
export function replayTick(t: number) {
  if (!active) return;
  let ran = false;
  while (active.next < active.replay.steps.length) {
    const step = active.replay.steps[active.next];
    const at = parseTime(step.at, t);
    if (at > t) break;
    active.next++;
    try {
      step.run(active.ctx, at);
      active.log.push({ at, note: step.note });
      console.log(`[replay] ${step.at} ${step.note}`);
    } catch (err) {
      active.log.push({ at, note: step.note, error: (err as Error).message });
      console.warn(`[replay] ${step.at} failed: ${(err as Error).message}`);
    }
    ran = true;
  }
  if (ran) scenarioTick(t, true);
}

export function replayStatus() {
  if (!active) return { active: null, available: Object.entries(REPLAYS).map(([name, r]) => ({ name, title: r.title, date: r.date, source: r.source })) };
  const d = active.ctx.d && disruptions.get(active.ctx.d.id);
  return {
    active: active.name,
    title: active.replay.title,
    source: active.replay.source,
    disruptionId: d?.id ?? null,
    done: active.log,
    upcoming: active.replay.steps.slice(active.next).map((s) => ({ at: s.at, note: s.note })),
  };
}

// ---------------------------------------------------------------- what the twin did (to score against Ist-Daten)
type Outcome = { trainId: string; line: string; category: string; headsign: string; calls: { id: string; plannedArr: number | null; plannedDep: number | null; actualArr: number | null; actualDep: number | null; served: boolean }[]; terminatedAt: number | null; cancelled: boolean };
const outcomes = new Map<string, Outcome>();
const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x) : null);
function outcomeOf(tr: Train): Outcome | undefined {
  const d = active?.ctx.d;
  if (!d) return undefined;
  const ids = new Set([d.scenario.a, d.scenario.b, ...d.scenario.inside].filter(Boolean) as string[]);
  const n = tr.trip.stops.length;
  const idx = Array.from(tr.trip.stops).map((k, i) => ({ k, i })).filter(({ k }) => ids.has(stops[k].id));
  if (idx.length < 2) return undefined;
  const last = liveTimes(tr.trip, Date.now()).lastServed;
  return {
    trainId: tr.trip.trainId,
    line: tr.trip.line,
    category: tr.trip.cat,
    headsign: tr.trip.head,
    calls: idx.map(({ k, i }) => ({ id: stops[k].id, plannedArr: i > 0 ? tr.trip.arr[i] : null, plannedDep: i < n - 1 ? tr.trip.dep[i] : null, actualArr: n0(tr.actArr[i]), actualDep: n0(tr.actDep[i]), served: !tr.cancelled && i <= last })),
    terminatedAt: tr.terminatedAt ?? null,
    cancelled: tr.cancelled,
  };
}
/** Keep what trains through the replayed section did when they leave service. */
export function recordRemoved(removed: Train[]) {
  if (!active) return;
  for (const tr of removed) {
    const o = outcomeOf(tr);
    if (o) outcomes.set(o.trainId, o);
  }
}
export function replayOutcome() {
  const now = [...trains.values()].map(outcomeOf).filter((o): o is Outcome => Boolean(o));
  return [...outcomes.values(), ...now.filter((o) => !outcomes.has(o.trainId))];
}
