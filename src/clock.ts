// Replay clock: with RAIL_REPLAY="2026-09-10T05:30" (Swiss local time) the whole twin runs on a virtual clock that starts
// there and runs RAIL_REPLAY_SPEED times faster (default 1). Imported first by main.ts: Date.now() is replaced before
// anything reads it, so the timetable of that day loads and every module sees the same time.
import { serviceOrigin } from "./time.ts";

const spec = process.env.RAIL_REPLAY ?? "";
export const replaySpeed = Math.max(1, Number(process.env.RAIL_REPLAY_SPEED ?? 1) || 1);
export const replayFrom = (() => {
  const m = spec.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/);
  return m ? serviceOrigin(m[1]) + (Number(m[2]) * 60 + Number(m[3])) * 60_000 : null;
})();
if (spec && replayFrom === null) throw new Error(`RAIL_REPLAY must look like 2026-09-10T05:30, not "${spec}"`);
const realNow = Date.now.bind(Date);
const realStart = realNow();
if (replayFrom !== null) {
  Date.now = () => Math.round(replayFrom + (realNow() - realStart) * replaySpeed);
  console.log(`[sbb-twin] replay clock from ${spec} at ${replaySpeed}x`);
}
export const replaying = replayFrom !== null;
/** Real milliseconds until the next tick: one virtual second. */
export const nextTickIn = () => (replaying ? Math.max(5, 1000 / replaySpeed - ((Date.now() % 1000) / replaySpeed)) : 1000 - (Date.now() % 1000) + 5);
