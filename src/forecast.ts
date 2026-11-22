// Live forecasts for every active disruption (contract: research/forecast-contract.md), from plain JSON models trained
// offline (src/forecastModels.ts):
//  - duration: P(still disrupted) at +60/+120/+240 min, the predicted end (median) with an 80 % band, and whether the
//    announced end looks optimistic, for real SBB alerts (GTFS-RT service alerts) and disruptions registered in the twin;
//  - after a resumption: the trains to check (src/resumption.ts);
//  - the section risk map (research/section_risk/segments.geojson), served as is.
// A shadow log keeps each disruption's first prediction and scores it when the disruption ends, so the dashboard shows
// how the model does live. Forecasts are advice: they never change the effective timetable or the planner.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { disruptions } from "./disruptions.ts";
import { alertsState, type RealAlert } from "./alerts.ts";
import { isScenario, stateAt } from "./scenario.ts";
import { causeOf } from "./catalogue.ts";
import { publish } from "./mqtt.ts";
import { STATE_FILE } from "./persist.ts";
import { offsetMinutes, zurich } from "./time.ts";
import { loaded, modelInfo, modelsGeneration, refreshModels, type DurationModel } from "./forecastModels.ts";
import { resumed, resumptionTick, resumptions } from "./resumption.ts";

type Qualifier = "until" | "at_least" | "none";
type Horizon = { minutes: number; at: number; label: string; p: number };
export type DisruptionForecast = {
  id: string;
  key: string; // the shadow log's key: the section of a real alert keeps it when "Interrupted" becomes "Limited"
  kind: "sbb" | "twin";
  title: string;
  where: string;
  cause: { label: string; group: string; source: "gtfs" | "text" | "code" | "none" };
  effect: "interrupted" | "limited";
  scope: "station" | "section";
  start: number;
  startLabel: string;
  startSource: "activePeriod" | "firstSeen" | "registered";
  elapsedMin: number;
  announced: { end: number | null; label: string | null; qualifier: Qualifier; source: "activePeriod" | "description" | "twin" | "none" };
  planned: boolean;
  inScope: boolean;
  scopeNote: string | null;
  horizons: Horizon[];
  median: { at: number; label: string } | null;
  band: { level: number; low: number; high: number; lowLabel: string; highLabel: string; method: "conformal" | "quantiles" } | null;
  pAtAnnounced: number | null;
  optimistic: boolean;
  overdue: boolean;
  say: string | null;
  placeholder: boolean;
  modelVersion: string;
};

// ---------------------------------------------------------------- time labels (Swiss local)
const MIN = 60_000;
const hhmm = (ms: number) => zurich(ms).time.slice(0, 5);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15:40", or "23 Nov 05:00" on another day. */
export function label(ms: number, now = Date.now()) {
  const z = zurich(ms);
  if (z.date === zurich(now).date) return z.time.slice(0, 5);
  return `${Number(z.date.slice(8, 10))} ${MONTHS[Number(z.date.slice(5, 7)) - 1]} ${z.time.slice(0, 5)}`;
}
const round5 = (ms: number, how: "round" | "floor" | "ceil" = "round") => Math[how](ms / (5 * MIN)) * 5 * MIN;
/** Epoch ms of a Swiss local date (YYYY-MM-DD) and time. */
function localTime(date: string, h: number, m: number) {
  const naive = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  return naive - offsetMinutes(naive) * MIN;
}

// ---------------------------------------------------------------- the model's maths
/** erfc with relative precision ~1e-7 everywhere (Numerical Recipes), so the survival tail stays exact. */
function erfc(x: number) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const upperTail = (z: number) => 0.5 * erfc(z / Math.SQRT2); // 1 - Phi(z)
const BINS = [0, 30, 60, 120, 240, 480]; // discrete_hazard bins (minutes); the last is [480, inf)

/** S(t): the chance it is still not resumed t minutes after its start (unconditional). */
function survival(m: DurationModel, x: Record<string, number>): (t: number) => number {
  const lin = Object.entries(m.coef ?? {}).reduce((s, [f, c]) => s + c * (x[f] ?? 0), 0);
  if (m.type === "discrete_hazard") {
    const h = (m.binIntercepts ?? []).map((b) => 1 / (1 + Math.exp(-(b + lin))));
    const at = [1]; // S at the end of each bin
    for (let j = 0; j < BINS.length; j++) at.push(at[j] * (1 - (h[j] ?? 0.5)));
    return (t) => {
      if (t <= 0) return 1;
      for (let j = 0; j < BINS.length - 1; j++) if (t < BINS[j + 1]) return at[j] + ((at[j + 1] - at[j]) * (t - BINS[j])) / (BINS[j + 1] - BINS[j]);
      // the open last bin: its hazard applies to every further 480 minutes, linear inside each
      const f = 1 - (h[BINS.length - 1] ?? 0.5);
      const k = (t - 480) / 480;
      const base = at[BINS.length - 1] * f ** Math.floor(k);
      return base - base * (1 - f) * (k - Math.floor(k));
    };
  }
  const mu = (m.intercept ?? 0) + lin;
  const sigma = m.sigma && m.sigma > 0 ? m.sigma : 1;
  return (t) => (t <= 0 ? 1 : upperTail((Math.log(t) - mu) / sigma));
}
/** The t (minutes since the start, t >= e) where S(t | e) = S(t) / S(e) falls to q. */
function quantile(S: (t: number) => number, e: number, q: number) {
  const se = Math.max(S(e), 1e-300);
  let lo = Math.max(e, 0.5);
  let hi = Math.max(2 * lo, 60);
  while (S(hi) / se > q && hi < 86_400) hi *= 2; // 60 days at most
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (S(mid) / se > q) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ---------------------------------------------------------------- features
const GROUPS = ["infrastructure", "rolling_stock", "person", "external", "planned"] as const;
// the contract's cause groups in SBB's English wording ("This is due to ..."); order matters (a train fault before a technical fault)
const TEXT_GROUPS: [string, RegExp][] = [
  ["planned", /construction|maintenance|engineering work|building work|track work|renewal work/i],
  ["person", /accident involving a person|person|people|medical emergency|injur/i],
  ["rolling_stock", /defective train|faulty train|train (?:fault|breakdown|defect)|technical (?:fault|problem|defect) (?:on|with) (?:a|the) train|engine (?:fault|failure)|rolling stock|vehicle (?:fault|defect)|defective vehicle|locomotive|broken-down train|train blocking/i],
  ["infrastructure", /signal|interlocking|overhead (?:line|wire|contact)|catenary|track damage|damage to the track|power (?:failure|cut|outage)|infrastructure|points failure|switch (?:failure|fault)|level crossing|technical (?:difficult|fault|problem|disruption)/i],
  ["external", /police|outside (?:of )?our control|vandal|obstacle|tree|collision|road vehicle|storm|flood|natural hazard|snow|weather|landslide|rockfall|rock fall|avalanche|fire|animal|lightning|ice|wind/i],
];
function textGroup(text: string) {
  const reason = text.match(/due to ([^.]+)\./i)?.[1] ?? "";
  if (!reason) return undefined;
  for (const [g, re] of TEXT_GROUPS) if (re.test(reason)) return { group: g, label: reason.replace(/^(an?|the) /i, "").trim() };
  return undefined;
}
type Input = {
  id: string; key: string; kind: "sbb" | "twin"; title: string; where: string;
  cause: DisruptionForecast["cause"]; interrupted: boolean; station: boolean;
  start: number; startSource: DisruptionForecast["startSource"];
  announcedEnd: number | null; qualifier: Qualifier; announcedSource: DisruptionForecast["announced"]["source"];
  ends: string[];
};
function features(i: Input) {
  const x: Record<string, number> = {};
  if ((GROUPS as readonly string[]).includes(i.cause.group)) x[`cause:${i.cause.group}`] = 1;
  x.effect_interrupted = i.interrupted ? 1 : 0;
  x.scope_station = i.station ? 1 : 0;
  const minutes = i.announcedEnd !== null ? (i.announcedEnd - i.start) / MIN : 0;
  if (i.announcedEnd !== null && minutes > 0) {
    x.announced_log = Math.log(Math.max(1, minutes));
    x.announced_none = 0;
    x.announced_at_least = i.qualifier === "at_least" ? 1 : 0;
  } else {
    x.announced_log = 0;
    x.announced_none = 1;
    x.announced_at_least = 0;
  }
  const z = zurich(i.start);
  const hour = Number(z.time.slice(0, 2));
  const bucket = hour >= 22 || hour <= 5 ? "night" : hour <= 8 ? "am_peak" : hour >= 16 && hour <= 18 ? "pm_peak" : hour >= 19 ? "evening" : "day";
  if (bucket !== "day") x[`hour:${bucket}`] = 1;
  const dow = new Date(`${z.date}T12:00:00Z`).getUTCDay();
  x.weekend = dow === 0 || dow === 6 ? 1 : 0;
  return x;
}

// ---------------------------------------------------------------- one forecast
const LONG_PLANNED_MIN = 24 * 60; // planned works announced over more than a day: the announced end is the plan
const MAX_ELAPSED_MIN = 48 * 60; // on for more than two days: outside the incidents the model learned from
function forecastOne(m: DurationModel, placeholder: boolean, i: Input, now: number): DisruptionForecast {
  const e = Math.max(0, (now - i.start) / MIN);
  const planned = i.cause.group === "planned";
  const announcedMin = i.announcedEnd !== null ? (i.announcedEnd - i.start) / MIN : null;
  const base: DisruptionForecast = {
    id: i.id, key: i.key, kind: i.kind, title: i.title, where: i.where, cause: i.cause,
    effect: i.interrupted ? "interrupted" : "limited", scope: i.station ? "station" : "section",
    start: i.start, startLabel: label(i.start, now), startSource: i.startSource, elapsedMin: Math.round(e),
    announced: { end: i.announcedEnd, label: i.announcedEnd !== null ? label(i.announcedEnd, now) : null, qualifier: i.qualifier, source: i.announcedSource },
    planned, inScope: true, scopeNote: planned ? "Planned works: the announced end is usually kept." : null,
    horizons: [], median: null, band: null, pAtAnnounced: null, optimistic: false,
    overdue: i.announcedEnd !== null && i.announcedEnd < now, say: null, placeholder, modelVersion: m.version,
  };
  if (planned && announcedMin !== null && announcedMin > LONG_PLANNED_MIN) {
    return { ...base, inScope: false, scopeNote: `Planned works until ${base.announced.label}: the announced end is usually kept, and the model learned from shorter disruptions.`, say: placeholder ? null : `These are planned works until ${base.announced.label}; the announced end is usually kept.` };
  }
  if (e > MAX_ELAPSED_MIN) return { ...base, inScope: false, scopeNote: "On for more than two days: outside the disruptions the model learned from." };
  const S = survival(m, features(i));
  const se = Math.max(S(e), 1e-300);
  const cond = (t: number) => (t <= e ? 1 : Math.min(1, S(t) / se));
  const horizons = (m.horizonsMin ?? [60, 120, 240]).map((h) => ({ minutes: h, at: now + h * MIN, label: label(now + h * MIN, now), p: Math.round(cond(e + h) * 1000) / 1000 }));
  const med = quantile(S, e, 0.5);
  const medianAt = i.start + med * MIN;
  let band: DisruptionForecast["band"] = null;
  if (m.interval && Number.isFinite(m.interval.lowLogShift) && Number.isFinite(m.interval.highLogShift)) {
    // the calibrated band on ln T, around the median given the time already elapsed
    const low = Math.max(now, i.start + med * Math.exp(m.interval.lowLogShift) * MIN);
    const high = Math.max(low, i.start + med * Math.exp(m.interval.highLogShift) * MIN);
    band = { level: m.interval.level ?? 0.8, low, high, lowLabel: label(round5(low, "floor"), now), highLabel: label(round5(high, "ceil"), now), method: "conformal" };
  } else {
    const low = i.start + quantile(S, e, 0.9) * MIN;
    const high = i.start + quantile(S, e, 0.1) * MIN;
    band = { level: 0.8, low, high, lowLabel: label(round5(low, "floor"), now), highLabel: label(round5(high, "ceil"), now), method: "quantiles" };
  }
  const pAtAnnounced = i.announcedEnd !== null && i.announcedEnd > now ? Math.round(cond((i.announcedEnd - i.start) / MIN) * 1000) / 1000 : null;
  const optimistic = !planned && pAtAnnounced !== null && pAtAnnounced > 0.6;
  const medianLabel = label(round5(medianAt), now);
  let say: string | null = null;
  if (!placeholder) {
    say = planned
      ? `This is planned work${base.announced.label ? ` announced until ${base.announced.label}` : ""}; planned works usually end as announced.`
      : `Disruptions like this usually last until about ${medianLabel}, most likely between ${band.lowLabel} and ${band.highLabel}.`;
    if (optimistic) say += ` The announced end at ${base.announced.label} looks optimistic.`;
    else if (base.overdue && !planned) say += ` It has already run past the announced end at ${base.announced.label}.`;
  }
  return { ...base, horizons, median: { at: Math.round(medianAt), label: medianLabel }, band, pAtAnnounced, optimistic, say };
}

// ---------------------------------------------------------------- the live inputs
const ACTIVE = /^(Interrupted|Limited|Irregular) service/i;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** "Interrupted service: Wetzikon ZH - Bubikon" -> ["Wetzikon ZH", "Bubikon"]; "... between A and B" -> ["A", "B"]. */
function placesIn(title: string) {
  const rest = title.replace(ACTIVE, "").replace(/^\s*(?:between\s+)?[:\s]*/i, "").replace(/^between\s+/i, "");
  return rest.split(/\s+(?:-|–|and)\s+/).map((s) => s.trim()).filter(Boolean);
}
/** The announced end of a real alert: its active period's end, else "until (approx.) [DD.MM.YYYY,] HH:MM" in the text. */
function announcedOf(a: RealAlert, period: RealAlert["activePeriods"][number] | undefined, now: number) {
  const text = a.description ?? "";
  const qualifier: Qualifier = /at least until/i.test(text) ? "at_least" : "until";
  if (period?.end) return { end: period.end, qualifier, source: "activePeriod" as const };
  const m = text.match(/until\s+(?:approx(?:imately|\.)?\s*)?(?:(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s*)?(\d{1,2})[:.](\d{2})/i);
  if (m) {
    const date = m[3] ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : zurich(now).date;
    let end = localTime(date, Number(m[4]), Number(m[5]));
    if (!m[3] && end < now - 6 * 3600_000) end += 86_400_000; // "until 01:00" written late in the evening
    return { end, qualifier, source: "description" as const };
  }
  return { end: null, qualifier: "none" as const, source: "none" as const };
}

function inputs(m: DurationModel, now: number): Input[] {
  const out: Input[] = [];
  for (const a of alertsState.alerts.values()) {
    if (!ACTIVE.test(a.title)) continue;
    const period = a.activePeriods.find((p) => (p.start ?? 0) <= now && (p.end ?? Infinity) >= now) ?? a.activePeriods[0];
    const fromText = textGroup(a.description ?? "");
    const gtfsGroup = m.causeMap?.[`gtfs:${a.gtfsCause}`];
    const cause: Input["cause"] = fromText
      ? { label: fromText.label, group: fromText.group, source: "text" }
      : gtfsGroup
        ? { label: a.cause, group: gtfsGroup, source: "gtfs" }
        : { label: a.cause, group: "other", source: "none" };
    const names = placesIn(a.title);
    const key = `sbb:${cause.group === "planned" ? "p" : "u"}:${norm(names.join(" - ") || a.title)}`;
    const ends = names.map((n) => a.stations.find((s) => norm(s.name) === norm(n))?.id).filter((x): x is string => Boolean(x)).slice(0, 2);
    const seen = shadow.entries.get(key);
    const periodStart = period?.start ?? null;
    // the earliest start known for this section: an interruption that became "Limited service" keeps its start
    const start = Math.min(periodStart ?? Infinity, seen && seen.endedAt === null ? seen.start : Infinity, now);
    const ann = announcedOf(a, period, now);
    out.push({
      id: a.id, key, kind: "sbb", title: a.title, where: a.stations.slice(0, 3).map((s) => s.name).join(", "), cause,
      interrupted: /^Interrupted/i.test(a.title), station: a.stations.length <= 1,
      start, startSource: periodStart !== null && start === periodStart ? "activePeriod" : "firstSeen",
      announcedEnd: ann.end, qualifier: ann.qualifier, announcedSource: ann.source, ends: ends.length ? ends : a.stations.slice(0, 1).map((s) => s.id),
    });
  }
  for (const d of disruptions.values()) {
    if (!isScenario(d) || d.endedAt) continue;
    const sc = d.scenario;
    if (sc.start > now) continue;
    const st = stateAt(d, now, now);
    if (st.state === "resumed") continue;
    const code = sc.cause.code;
    const mapped = m.causeMap?.[code];
    const fromText = textGroup(`due to ${causeOf(code)?.clause.en ?? sc.cause.label}.`);
    const cause: Input["cause"] = mapped ? { label: sc.cause.label, group: mapped, source: "code" } : fromText ? { label: sc.cause.label, group: fromText.group, source: "text" } : { label: sc.cause.label, group: "other", source: "none" };
    const end = st.durationType === "UNKNOWN" ? null : st.until;
    out.push({
      id: d.id, key: `twin:${d.id}`, kind: "twin", title: `${st.state === "interrupted" ? "Interrupted service" : "Limited service"}: ${d.where}`, where: d.where, cause,
      interrupted: st.state === "interrupted", station: sc.b === undefined, start: sc.start, startSource: "registered",
      announcedEnd: end, qualifier: end === null ? "none" : st.durationType === "UNTIL_AT_LEAST" ? "at_least" : "until", announcedSource: end === null ? "none" : "twin",
      ends: [sc.a, sc.b].filter((x): x is string => Boolean(x)),
    });
  }
  return out;
}

// ---------------------------------------------------------------- shadow log
type ShadowEntry = {
  id: string; key: string; kind: "sbb" | "twin"; title: string; where: string; causeGroup: string; ends: string[];
  firstSeenAt: number; predictedAt: number | null; start: number; announcedEnd: number | null; qualifier: Qualifier; planned: boolean;
  prediction: { horizons: { minutes: number; at: number; p: number }[]; median: number | null; low: number | null; high: number | null } | null;
  modelVersion: string; placeholder: boolean;
  lastSeenAt: number; endedAt: number | null; endSource: "resumed" | "disappeared" | "offline" | null;
  score: { brier: Record<string, number>; operatorBrier: Record<string, number> | null; inBand: boolean | null; errorMin: number | null; operatorErrorMin: number | null } | null;
};
const SHADOW_FILE = `${STATE_FILE.replace(/\.json$/, "")}.forecast-shadow.json`;
const OFFLINE_GAP = 15 * MIN; // an alert gone after a longer gap in the polls ended while the twin was not looking
const shadow = { since: null as number | null, entries: new Map<string, ShadowEntry>(), dirty: false };

function loadShadow() {
  if (!existsSync(SHADOW_FILE)) return;
  try {
    const s = JSON.parse(readFileSync(SHADOW_FILE, "utf8")) as { since: number | null; entries: ShadowEntry[] };
    shadow.since = s.since;
    for (const e of s.entries) shadow.entries.set(e.key, e);
    console.log(`[forecast] shadow log: ${shadow.entries.size} disruptions from ${SHADOW_FILE}`);
  } catch (err) {
    console.warn("[forecast] could not read the shadow log:", (err as Error).message);
  }
}
function saveShadow() {
  if (!shadow.dirty) return;
  shadow.dirty = false;
  writeFileSync(`${SHADOW_FILE}.tmp`, JSON.stringify({ since: shadow.since, entries: [...shadow.entries.values()] }));
  renameSync(`${SHADOW_FILE}.tmp`, SHADOW_FILE);
}
const predictionOf = (f: DisruptionForecast): ShadowEntry["prediction"] =>
  f.inScope && f.median ? { horizons: f.horizons.map(({ minutes, at, p }) => ({ minutes, at, p })), median: f.median.at, low: f.band?.low ?? null, high: f.band?.high ?? null } : null;

function record(f: DisruptionForecast, i: Input, now: number) {
  const seenAt = f.kind === "sbb" ? alertsState.fetchedAt || now : now;
  let e = shadow.entries.get(f.key);
  if (e && e.endedAt !== null) {
    // the same section disrupted again after it ended (e.g. the next weekend of planned works): a new entry
    shadow.entries.delete(f.key);
    shadow.entries.set(`${f.key}~${e.endedAt}`, { ...e, key: `${f.key}~${e.endedAt}` });
    e = undefined;
  }
  if (!e) {
    shadow.since ??= now;
    shadow.entries.set(f.key, {
      id: f.id, key: f.key, kind: f.kind, title: f.title, where: f.where, causeGroup: f.cause.group, ends: i.ends,
      firstSeenAt: now, predictedAt: f.inScope ? now : null, start: f.start, announcedEnd: f.announced.end, qualifier: f.announced.qualifier, planned: f.planned,
      prediction: predictionOf(f), modelVersion: f.modelVersion, placeholder: f.placeholder,
      lastSeenAt: seenAt, endedAt: null, endSource: null, score: null,
    });
    shadow.dirty = true;
    return;
  }
  e.lastSeenAt = seenAt;
  e.id = f.id;
  e.title = f.title;
  if (e.ends.length < i.ends.length) e.ends = i.ends;
  // recorded with a placeholder (or before it was in scope): the first real prediction replaces it, at its own time
  if ((e.placeholder && !f.placeholder) || (!e.prediction && f.inScope && f.median)) {
    e.prediction = predictionOf(f);
    e.predictedAt = now;
    e.placeholder = f.placeholder;
    e.modelVersion = f.modelVersion;
    e.announcedEnd = f.announced.end;
    e.qualifier = f.announced.qualifier;
  }
  shadow.dirty = true;
}
function score(e: ShadowEntry) {
  if (!e.prediction || e.endedAt === null || e.endSource === "offline") return;
  const end = e.endedAt;
  const brier: Record<string, number> = {};
  const op: Record<string, number> = {};
  for (const h of e.prediction.horizons) {
    const y = end > h.at ? 1 : 0; // still disrupted at that time
    brier[h.minutes] = Math.round((h.p - y) ** 2 * 10_000) / 10_000;
    if (e.announcedEnd !== null) op[h.minutes] = ((e.announcedEnd > h.at ? 1 : 0) - y) ** 2; // the operator: over at the announced end
  }
  const { low, high, median } = e.prediction;
  e.score = {
    brier,
    operatorBrier: e.announcedEnd !== null ? op : null,
    inBand: low !== null && high !== null ? end >= low && end <= high : null,
    errorMin: median !== null ? Math.round(Math.abs(end - median) / MIN) : null,
    operatorErrorMin: e.announcedEnd !== null ? Math.round(Math.abs(end - e.announcedEnd) / MIN) : null,
  };
}
let lastAlertsAt = 0;
function closeEnded(seen: Set<string>, now: number) {
  const fresh = alertsState.fetchedAt > lastAlertsAt && !alertsState.error;
  for (const e of shadow.entries.values()) {
    if (e.endedAt !== null || seen.has(e.key)) continue;
    if (e.kind === "twin") {
      const d = disruptions.get(e.id);
      e.endedAt = d && isScenario(d) ? (d.scenario.resumedAt ?? d.endedAt ?? now) : now;
      e.endSource = d ? "resumed" : "disappeared";
    } else {
      if (!fresh) continue; // only a successful poll can say an alert is gone
      const gap = alertsState.fetchedAt - e.lastSeenAt;
      e.endedAt = gap > OFFLINE_GAP ? alertsState.fetchedAt : Math.round((e.lastSeenAt + alertsState.fetchedAt) / 2);
      e.endSource = gap > OFFLINE_GAP ? "offline" : "disappeared";
      // a real alert withdrawn after an unplanned disruption: the trains to check at its stations
      if (e.endSource === "disappeared" && !e.planned && e.ends.length) resumed({ id: e.key, kind: "sbb", where: e.title.replace(ACTIVE, "").replace(/^[:\s]+/, "") || e.where, ends: e.ends, resumedAt: e.endedAt }, now);
    }
    score(e);
    shadow.dirty = true;
  }
  if (fresh) lastAlertsAt = alertsState.fetchedAt;
}

export function shadowReport() {
  const all = [...shadow.entries.values()].sort((x, y) => (y.endedAt ?? y.firstSeenAt) - (x.endedAt ?? x.firstSeenAt));
  // the headline score: real SBB disruptions, predicted by a real model (twin tests and placeholders are listed, not counted)
  const scored = all.filter((e) => e.score && e.kind === "sbb" && !e.placeholder);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10_000) / 10_000 : null);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const hs = [...new Set(scored.flatMap((e) => Object.keys(e.score!.brier)))];
  const withOp = scored.filter((e) => e.score!.operatorBrier);
  const banded = scored.filter((e) => e.score!.inBand !== null);
  return {
    since: shadow.since,
    file: SHADOW_FILE.split("/").slice(-1)[0],
    open: all.filter((e) => e.endedAt === null).length,
    scored: scored.length,
    twinScored: all.filter((e) => e.score && e.kind === "twin").length,
    unscored: all.filter((e) => e.endedAt !== null && !e.score).length,
    placeholderEntries: all.filter((e) => e.placeholder).length,
    score: scored.length
      ? {
          n: scored.length,
          brier: Object.fromEntries(hs.map((h) => [h, mean(scored.map((e) => e.score!.brier[h]).filter((x) => x !== undefined))!])),
          operatorN: withOp.length,
          operatorBrier: withOp.length ? Object.fromEntries(hs.map((h) => [h, mean(withOp.map((e) => e.score!.operatorBrier![h]).filter((x) => x !== undefined))!])) : null,
          coverage: banded.length ? mean(banded.map((e) => (e.score!.inBand ? 1 : 0))) : null,
          medianAbsErrorMin: median(scored.map((e) => e.score!.errorMin).filter((x): x is number => x !== null)),
          operatorMedianAbsErrorMin: median(withOp.map((e) => e.score!.operatorErrorMin).filter((x): x is number => x !== null)),
        }
      : null,
    entries: all.slice(0, 60).map(({ ends, predictedAt, ...e }) => ({ ...e, predictedAt })),
  };
}

// ---------------------------------------------------------------- the live list, MQTT, API helpers
let current: DisruptionForecast[] = [];
let currentAt = 0;
let lastSig = "";
let lastGen = -1;
const NOTE = "Advice only: forecasts never change the effective timetable or the planner. Times are Swiss local.";
function status() {
  const s = [loaded("duration").source, loaded("resumption").source, loaded("segments").source];
  return s.every((x) => x === "real") ? "real" : s.every((x) => x !== "real") ? "placeholder" : "partial";
}
export function forecastsPayload(now = Date.now()) {
  return { v: 1 as const, generatedAt: currentAt || now, status: status(), models: modelInfo(), disruptions: current, resumed: resumptions(), note: NOTE };
}

let lastModelCheck = 0;
/** Recompute every forecast (every few seconds, and at once after a control change). */
export function forecastTick(now = Date.now()) {
  if (now - lastModelCheck >= 60_000) {
    lastModelCheck = now;
    refreshModels();
  }
  resumptionTick(now);
  const dm = loaded("duration");
  const list: DisruptionForecast[] = [];
  const seen = new Set<string>();
  if (dm.data) {
    for (const i of inputs(dm.data, now)) {
      const f = forecastOne(dm.data, dm.source !== "real", i, now);
      list.push(f);
      seen.add(f.key);
      record(f, i, now);
    }
    closeEnded(seen, now);
  }
  list.sort((a, b) => Number(b.effect === "interrupted") - Number(a.effect === "interrupted") || Number(a.planned) - Number(b.planned) || a.start - b.start);
  current = list;
  currentAt = now;
  // retained on MQTT whenever a number someone would read changed (not every elapsed minute)
  const sig = JSON.stringify([modelsGeneration.n, list.map((f) => [f.id, f.effect, f.announced.end, f.median?.label, f.band?.lowLabel, f.band?.highLabel, f.horizons.map((h) => Math.round(h.p * 100)), f.optimistic, f.overdue, f.inScope])]);
  if (sig !== lastSig || lastGen !== modelsGeneration.n) {
    lastSig = sig;
    lastGen = modelsGeneration.n;
    publish("forecasts/disruptions", forecastsPayload(now), { retain: true, qos: 1 });
  }
}

/** What the passenger brief says about one disruption: a sentence to speak, never a placeholder number. */
export function briefForecast(id: string) {
  const f = current.find((x) => x.id === id);
  if (!f) return null;
  if (f.placeholder) return { status: "placeholder" as const, note: "The duration model is not trained yet: no forecast to tell passengers." };
  return {
    status: "real" as const,
    say: f.say,
    predictedEnd: f.median?.at ?? null,
    predictedEndLabel: f.median?.label ?? null,
    band: f.band ? { low: f.band.low, high: f.band.high, label: `${f.band.lowLabel}–${f.band.highLabel}` } : null,
    announcedEnd: f.announced.end,
    announcedLabel: f.announced.label,
    optimistic: f.optimistic,
    planned: f.planned,
    stillDisrupted: f.horizons.map((h) => ({ inMinutes: h.minutes, p: h.p })),
    modelVersion: f.modelVersion,
  };
}

export function scorecards() {
  const one = (model: "durationCard" | "resumptionCard" | "segmentsCard") => {
    const c = loaded(model);
    return { source: c.source, file: c.file, scorecard: c.data };
  };
  return { duration: one("durationCard"), post_resumption: one("resumptionCard"), section_risk: one("segmentsCard") };
}
let segmentsBody: { gen: number; file: string; body: string } | undefined;
/** The section risk layer as GeoJSON (the file as trained, with `placeholder` set when it is one). */
export function segmentsGeoJson() {
  const s = loaded("segments");
  if (!segmentsBody || segmentsBody.gen !== modelsGeneration.n || segmentsBody.file !== s.file) {
    const fc = s.data ?? { type: "FeatureCollection" as const, features: [] };
    // the tier of each section in the ranking, the same cut as the out-of-time check (recall@top 5 / 10 / 20 %)
    const n = fc.features.length;
    const order = fc.features.map((f, i) => ({ i, rank: Number(f.properties.rank), risk: Number(f.properties.risk) || 0 }));
    order.sort((a, b) => (Number.isFinite(a.rank) && Number.isFinite(b.rank) ? a.rank - b.rank : b.risk - a.risk));
    const tiers = new Array<string>(n);
    order.forEach((o, k) => (tiers[o.i] = k < 0.05 * n ? "top5" : k < 0.1 * n ? "top10" : k < 0.2 * n ? "top20" : "rest"));
    const features = fc.features.map((f, i) => ({ ...f, properties: { ...f.properties, tier: tiers[i] } }));
    segmentsBody = { gen: modelsGeneration.n, file: s.file, body: JSON.stringify({ ...fc, features, placeholder: s.source !== "real", source: s.source, file: s.file }) };
  }
  return segmentsBody.body;
}

/** Start: the shadow log from disk, a forecast every 5 s, the log saved every 5 s when it changed. */
export function startForecasts() {
  loadShadow();
  forecastTick();
  setInterval(() => forecastTick(), 5000).unref();
  setInterval(saveShadow, 5000).unref();
}
