# Forecast contract (shared by the model research and the twin integration)

Two models, both trained offline in Python (research/) and applied live in TypeScript (src/forecast.ts) with NO Python
at runtime: the model files below are plain JSON.

## 1. Duration of a disruption: `research/duration/model.json`

Predicts, for a disruption that is (still) active, the probability that it is still not resumed at a given time.
Features (computed identically offline and live; all known at the moment of prediction, no leakage):

| name | value |
|---|---|
| `cause:<group>` | one-hot, groups: `infrastructure` (signal box, overhead line, track damage, power failure, technical difficulties on the infrastructure), `rolling_stock` (engine fault, defective train, rolling stock), `person` (accident involving a person, persons near the tracks, medical emergency), `external` (police, event outside our control, vandalism, obstacle, fallen tree, collision with a vehicle, storm damage, flooding), `planned` (construction work, maintenance), `other` (anything else; the reference group, no column) |
| `effect_interrupted` | 1 if interrupted, 0 if limited / irregular |
| `scope_station` | 1 if a single station, 0 for a section |
| `announced_log` | ln(announced minutes from start to the announced end), 0 if none |
| `announced_none` | 1 if no announced end |
| `announced_at_least` | 1 if the announced end is a lower bound ("at least until", UNTIL_AT_LEAST) |
| `hour:<bucket>` | one-hot on the Swiss local start hour: `night` (22-5), `am_peak` (6-8), `pm_peak` (16-18), `evening` (19-21); `day` (9-15) is the reference |
| `weekend` | 1 on Saturday/Sunday |

```jsonc
{
  "name": "duration", "version": "…", "trainedOn": "2024-03..2025-12", "testedOn": "2026-01..2026-10",
  "type": "aft_lognormal" | "discrete_hazard",
  // aft_lognormal: ln(T minutes) ~ Normal(mu, sigma), mu = intercept + sum(coef[f] * x[f]); S(t) = 1 - Phi((ln t - mu) / sigma)
  // discrete_hazard: bins (minutes) [0,30),[30,60),[60,120),[120,240),[240,480),[480,inf); hazard in bin j = sigmoid(binIntercept[j] + sum(coef[f]*x[f]));
  //   S(end of bin j) = prod_{i<=j} (1 - h_i); interpolate linearly inside a bin
  "intercept": 0, "binIntercepts": [], "sigma": 0, "coef": { "cause:infrastructure": 0, "…": 0 },
  "causeMap": { "EG_010": "infrastructure", "…": "…",
                "gtfs:TECHNICAL_PROBLEM": "infrastructure", "gtfs:ACCIDENT": "person", "gtfs:CONSTRUCTION": "planned", "gtfs:MAINTENANCE": "planned",
                "gtfs:POLICE_ACTIVITY": "external", "gtfs:MEDICAL_EMERGENCY": "person", "gtfs:WEATHER": "external", "gtfs:OTHER_CAUSE": "other", "gtfs:UNKNOWN_CAUSE": "other" },
  "horizonsMin": [60, 120, 240],
  "interval": { "level": 0.8, "method": "conformal", "lowLogShift": 0, "highLogShift": 0 }  // optional calibrated band on ln T
}
```
Conditional on still being open after `e` elapsed minutes: S(t | e) = S(t) / S(e) for t > e.

## 2. Trains after a resumption: `research/post_resumption/model.json`

```jsonc
{ "name": "post_resumption", "version": "…", "a": -0.96, "b": -1.64,   // risk = sigmoid(a + b * leadMinutes / 60)
  "bands": [{ "min": 0.25, "label": "check first" }, { "min": 0.12, "label": "check" }, { "min": 0, "label": "low" }] }
```

## 3. Evidence for the dashboard: `research/<model>/scorecard.json`

```jsonc
{
  "model": "duration", "generatedAt": "ISO", "data": { "incidentsTrain": 0, "incidentsTest": 0, "source": "…" },
  "headline": "one sentence a judge understands",
  "metrics": [ { "name": "Brier at 120 min", "lowerIsBetter": true, "values": { "model": 0, "operator": 0, "cause": 0, "prior": 0 },
                 "ci95": { "model_vs_operator": [0, 0] } } ],
  "calibration": [ { "bin": "0-10%", "predicted": 0, "observed": 0, "n": 0 } ],
  "examples": [ { "id": "…", "title": "…", "announced": "…", "predicted": "…", "actual": "…" } ],
  "notes": ["honest limits"]
}
```
Numbers in a scorecard must come from a script in the same folder that anyone can re-run on the local data.
