// Control helpers: releasing trains.
import { disruptions } from "./disruptions.ts";

/** Ends everything we did to one train (stops, holds, speeds, obstacles): it moves on, still late until synced. */
export function releaseTrain(trainId: string) {
  const ended: string[] = [];
  for (const d of disruptions.values())
    if (!d.endedAt && ((d.scope.kind === "train" && d.scope.trainId === trainId) || d.scenario?.linkedTrain === trainId)) {
      d.endedAt = Date.now();
      ended.push(d.id);
    }
  return ended;
}
/** Ends every disruption. */
export function releaseAll() {
  let n = 0;
  for (const d of disruptions.values()) if (!d.endedAt) {
    d.endedAt = Date.now();
    n++;
  }
  return n;
}
