// What a disruption can be (its cause) and what the control centre can decide on it (measures).
// Defaults from 550 real VIA incidents (extern-liveticker): the effect of the first headline, the median duration
// rounded to 15 minutes (cap 240), the usual duration type and the share of incidents that mention a replacement bus.
// The cause clauses are the wording SBB uses in its English bulletins ("This is due to ...").
import { expectedFirstBus } from "./buses.ts";

export type EffectState = "interrupted" | "limited";
export type DurationType = "UNTIL" | "UNTIL_AT_LEAST" | "UNKNOWN";
export type Cause = {
  code: string;
  label: string;
  effect: EffectState;
  minutes: number;
  durationType: DurationType;
  busShare: number; // 0..1
  clause: { en: string };
};

const c = (code: string, label: string, effect: EffectState, minutes: number, durationType: DurationType, busShare: number, en: string): Cause => ({ code, label, effect, minutes, durationType, busShare, clause: { en } });

export const CAUSES: Cause[] = [
  c("EG_010", "Technical fault on the infrastructure", "interrupted", 120, "UNTIL_AT_LEAST", 0.64, "technical difficulties on the infrastructure"),
  c("EG_047", "Person accident", "interrupted", 180, "UNTIL_AT_LEAST", 0.77, "an accident involving a person"),
  c("EG_070", "Event outside our control", "interrupted", 180, "UNTIL", 0.71, "an event outside of our control"),
  c("EG_006", "Track damage", "interrupted", 225, "UNTIL_AT_LEAST", 0.66, "damage to the tracks"),
  c("EG_008", "Overhead line fault", "interrupted", 240, "UNTIL_AT_LEAST", 0.58, "a defect in the overhead line"),
  c("EG_014", "Train blocking the line", "interrupted", 90, "UNTIL", 0.36, "a train blocking the tracks"),
  c("EG_158", "Extraordinary construction work", "interrupted", 240, "UNTIL", 0.73, "exceptional construction work"),
  c("EG_001", "Level crossing fault", "interrupted", 90, "UNTIL", 0.71, "a disrupted level crossing"),
  c("EG_110", "Fire", "interrupted", 105, "UNTIL", 0.83, "a fire"),
  c("EG_063", "Operational disruption", "interrupted", 105, "UNTIL", 0.5, "a service disruption"),
  c("EG_193", "Collision with a vehicle", "interrupted", 195, "UNTIL", 0.8, "a collision with a vehicle"),
  c("EG_100", "Obstacle on the track", "interrupted", 180, "UNTIL", 0.89, "an obstacle on the tracks"),
  c("EG_028", "Derailment", "interrupted", 240, "UNTIL_AT_LEAST", 1, "a derailment"),
  c("EG_052", "Vandalism", "limited", 120, "UNTIL", 1, "vandalism"),
  c("EG_011", "Power cut", "interrupted", 210, "UNTIL_AT_LEAST", 0.5, "a power failure"),
  c("EG_030", "Road vehicle incident", "interrupted", 165, "UNTIL", 0.75, "an incident with a road vehicle"),
  c("EG_046", "People near the track", "interrupted", 105, "UNTIL", 0.33, "people close to the track"),
  c("EG_050", "Animals near the track", "limited", 30, "UNTIL", 0, "animals close to the track"),
  c("EG_049", "Police operation", "interrupted", 60, "UNTIL", 0, "a police operation"),
];
export const causeOf = (code: string) => CAUSES.find((x) => x.code === code);

export type MeasureType = "short_turn" | "replacement_bus" | "cancel_lines" | "hold" | "one_track_open" | "partial_resumption" | "interruption" | "prognosis" | "resume";
export const MEASURES: { type: MeasureType; label: string; states: EffectState[]; params: Record<string, string>; behaviour: string }[] = [
  { type: "hold", label: "Hold trains", states: ["interrupted"], params: { maxWaitMin: "longest wait before a train is turned back instead (default 20)" }, behaviour: "Trains wait at the last station before the section and continue when it reopens. Without short turns this is what every train does." },
  { type: "short_turn", label: "Short turn", states: ["interrupted", "limited"], params: { at: '"A", "B" or "both" (default both): which side turns trains back' }, behaviour: "A train that would wait more than 20 minutes ends its run at the last open station before the section; its remaining stops are cancelled and the vehicle leaves service. Trains that already passed continue." },
  { type: "replacement_bus", label: "Replacement bus", states: ["interrupted", "limited"], params: { sought: "true: ordered, being searched (requested): no trip runs until the buses are confirmed (POST /disruptions/{id}/buses/confirm). The default when no times are given", firstAt: "confirmed: first departure, HH:MM or epoch ms (from both ends; with one bus, B follows once it got there)", firstAtB: "optional: first departure from B", everyMin: "confirmed: minutes between departures per direction", buses: "or how many buses: the headway is then what they can run (a round trip on the road, 5 min turnaround at each end)", firstInMin: "older one-shot form: first departure, minutes after the decision", minutesA: "or fixed minutes past the hour from A, e.g. [10, 40]", minutesB: "and from B", withdrawAt: "epoch ms: last departures before this time" }, behaviour: "Requested: the bulletin says buses are being organised and the disruption shows when the first bus usually runs in real incidents (expectedFirstBus); nothing runs. Confirmed: buses (EV) run both ways between A and B, calling at the stations between, from the real bus stops (\"Olten, Bahnhof\"), on the road (OSRM) at the scheduled speed of the real EV buses; they are real trips: fleet, boards and the journey planner show them, and rail closures do not stop them. Withdrawn: buses on the road finish their trip." },
  { type: "cancel_lines", label: "Cancel lines", states: ["interrupted", "limited"], params: { lines: 'line names, e.g. ["S2", "S25"]' }, behaviour: "From its time, trains of these lines do not run through the section: they end at the last station before it." },
  { type: "one_track_open", label: "One track open", states: ["limited"], params: { kmh: "speed through the section (default 40)", cancelShare: "share of trains cancelled through the section, 0..1 (default 0.5)" }, behaviour: "Trains run through on one track at reduced speed; the chosen share (picked by train) ends at the last station before the section." },
  { type: "partial_resumption", label: "Partial resumption", states: ["interrupted"], params: {}, behaviour: "The disruption becomes limited at its time (interrupted -> limited)." },
  { type: "interruption", label: "Interruption", states: ["limited"], params: {}, behaviour: "The disruption becomes interrupted again (limited -> interrupted)." },
  { type: "prognosis", label: "Recovery prognosis", states: ["interrupted", "limited"], params: { until: "epoch ms or HH:MM", minutes: "or minutes from now", durationType: "UNTIL | UNTIL_AT_LEAST | UNKNOWN" }, behaviour: "A new expected end. Holds, short turns and buses follow it." },
  { type: "resume", label: "Resume", states: ["interrupted", "limited"], params: {}, behaviour: "Service resumed at its time: trains run again, held trains continue, future buses are withdrawn." },
];

/** A suggested decision: postable as is to POST /api/disruptions/{id}/measures. */
export type Suggested = { type: MeasureType; label: string; why: string; probability?: number; [param: string]: unknown };
export type Proposal = { measures: Suggested[]; note: string };
const label = (type: MeasureType) => MEASURES.find((m) => m.type === type)?.label ?? type;
/** The default plan for a new disruption, suggested to the operator (applied only on request). */
export function proposal(cause: Cause, effect: EffectState, remainingMin: number | null): Proposal {
  const out: Suggested[] = [];
  if (effect === "interrupted") {
    if (remainingMin !== null && remainingMin <= 20) out.push({ type: "hold", label: label("hold"), why: `The line should reopen within ${Math.round(remainingMin)} minutes: trains wait.` });
    else out.push({ type: "short_turn", label: "Short-turn trains at both ends", at: "both", why: remainingMin === null ? "No reopening time is known: trains end their run before the section." : `The interruption lasts about ${Math.round(remainingMin)} more minutes: trains end their run before the section instead of waiting.` });
  } else out.push({ type: "one_track_open", label: "One track open, every second train cancelled", kmh: 40, cancelShare: 0.5, why: "One track open: trains run slowly through it and every second one ends before the section." });
  // ordered, not timed: buses are searched for first (research/buses: when the first one runs in real incidents)
  if (cause.busShare >= 0.5) {
    const w = expectedFirstBus(0, 0);
    out.push({ type: "replacement_bus", label: "Order replacement buses", sought: true, probability: cause.busShare, why: `${Math.round(cause.busShare * 100)} % of real ${cause.label.toLowerCase()} incidents had a replacement bus; the first one usually runs ${w.fromMin} to ${w.toMin} minutes after the start, once the operator confirms its times.` });
  }
  const note = `Based on real ${cause.label.toLowerCase()} incidents${remainingMin === null ? "" : ` and about ${Math.round(remainingMin)} minutes to go`}.`;
  return { measures: out, note };
}
