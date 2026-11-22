// HTTP and MQTT forecast payloads. Times are epoch milliseconds and labels use Swiss local time.
export type ModelSource = "real" | "placeholder" | "missing";
export type ModelInfo = { name: string; version: string; source: ModelSource; type?: string; trainedOn?: string; testedOn?: string; file: string };
export type Models = { duration: ModelInfo; post_resumption: ModelInfo; section_risk: ModelInfo };

type Horizon = { minutes: number; at: number; label: string; p: number };
/** One active disruption (a real SBB alert or one registered in the twin) and how long it is likely to last. */
export type DisruptionForecast = {
  id: string;
  key: string; // stable across changes to the headline of an SBB alert
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
  announced: { end: number | null; label: string | null; qualifier: "until" | "at_least" | "none"; source: "activePeriod" | "description" | "twin" | "none" };
  planned: boolean;
  /** false: outside what the model was trained on (e.g. weeks of planned works); no numbers then */
  inScope: boolean;
  scopeNote: string | null;
  horizons: Horizon[]; // P(still disrupted) at now + 60 / 120 / 240 min
  /** the end time shown: the announced end + the 2026-tested correction while that is ahead, else the model median */
  median: { at: number; label: string; method: "announced_plus_correction" | "model_median"; modelMedian: number } | null;
  band: { level: number; low: number; high: number; lowLabel: string; highLabel: string; method: "conformal" | "quantiles" } | null;
  pAtAnnounced: number | null; // P(still disrupted at the announced end)
  optimistic: boolean; // the announcement looks optimistic (pAtAnnounced > 0.6)
  overdue: boolean; // the announced end has passed and it is still on
  say: string | null; // one sentence for the voice assistant (null with a placeholder model)
  placeholder: boolean;
  modelVersion: string;
};

type Place = { id: string; name: string };
export type ForecastTrain = {
  trainId: string;
  line: string;
  category: string;
  headsign: string;
  station: Place; // its first named stop after the notice
  plannedTime: number;
  leadMinutes: number;
  calls: { station: Place; plannedTime: number }[]; // every named stop of this run
  risk: number; // the model's raw risk (0..1); shown as its band
  band: string;
  bandObserved: number | null; // share of trains in this band that lost a stop in the 2026 test
  officialStatus: "scheduled" | "cancelled" | "skipped"; // the effective timetable now: an official change wins
};
export type Resumption = {
  v: 1;
  kind: "sbb" | "twin";
  disruptionId: string;
  where: string;
  resumedAt: number;
  issuedAt: number;
  updatedAt: number;
  expiresAt: number;
  endpoints: Place[];
  windowMinutes: number;
  modelVersion: string;
  placeholder: boolean;
  formula: string;
  coefficients: { a: number; b: number };
  bands: { label: string; min: number; observed: number | null }[];
  trains: ForecastTrain[];
  note: string;
};

export type ForecastsResponse = { v: 1; generatedAt: number; status: "real" | "placeholder" | "partial"; models: Models; disruptions: DisruptionForecast[]; resumed: Resumption[]; note: string };

/** research/<model>/scorecard.json (contract section 3); extra fields vary by model. */
export type Metric = { name: string; lowerIsBetter: boolean; values: Record<string, number>; ci95?: Record<string, [number, number]>; note?: string; [k: string]: unknown };
type CalibrationBin = { bin: string; predicted: number; observed: number; n: number; [k: string]: unknown };
export type Scorecard = {
  model: string; generatedAt: string; version?: string; placeholder?: boolean;
  data: { incidentsTrain?: number; incidentsTest?: number; source?: string; [k: string]: unknown };
  headline: string;
  metrics: Metric[];
  calibration?: CalibrationBin[];
  calibrationByBand?: CalibrationBin[];
  examples?: { id: string; title: string; announced: string; predicted: string; actual: string; [k: string]: unknown }[];
  notes?: string[];
  [k: string]: unknown;
};
export type ScorecardEntry = { source: ModelSource; file: string; scorecard: Scorecard | null };
export type ScorecardsResponse = { duration: ScorecardEntry; post_resumption: ScorecardEntry; section_risk: ScorecardEntry };

/** The live shadow test: each disruption's first prediction, scored when it ends. */
export type ShadowEntry = {
  id: string; key: string; kind: "sbb" | "twin"; title: string; where: string; causeGroup: string;
  firstSeenAt: number; predictedAt: number | null; start: number; announcedEnd: number | null; qualifier: "until" | "at_least" | "none"; planned: boolean;
  prediction: { horizons: { minutes: number; at: number; p: number }[]; median: number | null; low: number | null; high: number | null } | null;
  modelVersion: string; placeholder: boolean;
  lastSeenAt: number; endedAt: number | null; endSource: "resumed" | "disappeared" | "offline" | null;
  score: { brier: Record<string, number>; operatorBrier: Record<string, number> | null; inBand: boolean | null; errorMin: number | null; operatorErrorMin: number | null } | null;
};
type ShadowScore = {
  n: number; brier: Record<string, number>; operatorN: number; operatorBrier: Record<string, number | null> | null;
  coverage: number | null; medianAbsErrorMin: number | null; operatorMedianAbsErrorMin: number | null;
};
export type ShadowResponse = { file: string; twinScored: number; since: number | null; open: number; scored: number; unscored: number; placeholderEntries: number; score: ShadowScore | null; entries: ShadowEntry[] };
