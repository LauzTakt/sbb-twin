# Post-resumption train risk

When SBB publishes "Service resumed" for a section, some trains due at the section's stations in the next hour
still lose those stops. This experiment checks whether the time from the notice to the train predicts that.
It reproduces the design of the advisor, Astra, on the SBB records.

```
risk = sigmoid(a + b * lead_minutes / 60)
lead_minutes = minutes from the resumption notice to the train's first scheduled call at a named endpoint
```

Run `/opt/venv/bin/python research/post_resumption/post_resumption.py` (about 20 s, one process). The script
writes two files in the format of [`../forecast-contract.md`](../forecast-contract.md):

- [`model.json`](model.json) (section 2) holds `a`, `b`, the bands, and the roster and lead definitions the twin
  must apply.
- [`scorecard.json`](scorecard.json) (section 3) holds the headline, the metrics with 95% intervals, the
  calibration, examples and notes.

No row-level data is written. The inputs stay outside the repo:

- the VIA liveticker export, `/workspace/sbb/Daten/extern-liveticker`
- the monthly Ist-Daten extracts, `/workspace/sbb/history/months`
- `norm()` from `/workspace/sbb/history/build_effects.py`

## Method

- **Notice.** For each VIA incident, the versions are the audit rows plus the current row, ordered by
  `last_modified_date`. The notice is the first `Service resumed:` version after the first `INFO` version
  titled `Interrupted service:` or `Limited service:`. That gives 520 notices from 550 incidents.
- **Endpoints.** The stations named in the resumption title, normalised with `build_effects.norm`. For
  "A - B and C" the first branch (A - B) is used. Single-station incidents are kept.
- **Runs.** Regular trains only, with extra services excluded, grouped by operating day and trip.
  - A run needs exactly one row at each named endpoint, and at most 120 scheduled minutes between them.
  - The scheduled time is the planned arrival, otherwise the departure, on the Europe/Zurich clock.
  - A run is kept when its earlier named call falls in [notice, notice + 60 min).
- **Unscorable notices.** 25 notices name an endpoint that is missing from the records. Another 31 had no
  eligible regular train in the hour, and 1 notice at a month edge was left out. That leaves 463 scored notices
  and 2,766 runs.
- **Label.** Any of the run's endpoint calls flagged cancelled (`FAELLT_AUS_TF`) in the operating record.
- **Folds.** Training uses earlier years and testing the next year, by the notice's local year. The baseline
  predicts the training years' cancellation rate for every run. The model is fitted with
  `LogisticRegression(C=1)`.
- **Interval.** A paired bootstrap of the Brier improvement, baseline minus model, so above zero means the model
  is better. It resamples whole ISO weeks of the notice 5,000 times, with seed 1234.

## Scorecard

| Train → test | Test notices | Test runs | Cancelled | Baseline Brier | Model Brier | Improvement, 95% week-bootstrap interval |
|---|---:|---:|---:|---:|---:|---:|
| 2024 → 2025 | 170 | 1,043 | 154 | 0.12607 | **0.12206** | +0.00401 [+0.00057, +0.00768] |
| 2024–25 → Jan–Oct 2026 | 123 | 769 | 157 | 0.16492 | **0.15615** | +0.00878 [+0.00652, +0.01159] |

**Acceptance: passed.** The model has a lower Brier score than the baseline in both forward years, and both
intervals are above zero.

The 2025 improvement is small, and across ten bootstrap seeds its lower bound ranged from +0.00038 to
+0.00067. Weighting every notice equally keeps the improvement in both years: 0.12974 → 0.12640 in 2025 and
0.13351 → 0.12530 in 2026.

**Gradient and calibration in the 2026 test year.** The table gives the share of runs with a cancelled endpoint
call, by minutes after the notice.

| Minutes after notice | 0–15 | 15–30 | 30–45 | 45–60 |
|---|---:|---:|---:|---:|
| Observed 2026 | 73/195 (37%) | 37/195 (19%) | 26/190 (14%) | 21/189 (11%) |
| Mean predicted, 2024–25 fit | 24% | 17% | 12% | 9% |
| Observed 2025 | 66/259 (25%) | 38/279 (14%) | 20/248 (8%) | 30/257 (12%) |
| Observed, all years (2,766 runs) | 213/711 (30%) | 103/699 (15%) | 75/693 (11%) | 75/663 (11%) |

By band in 2026, the share of runs with a cancelled endpoint call was:

| Band | Runs | Observed | Mean predicted |
|---|---:|---:|---:|
| *check first*, 25% or more | 72 | 33 (46%) | 26% |
| *check*, 12% to 25% | 420 | 91 (22%) | 18% |
| *low*, below 12% | 277 | 33 (12%) | 9% |

The frozen model under-predicts 2026: 15.5% on average against 20.4% observed, and mostly in the first
quarter-hour. In 2025 it predicted 16.0% against 14.8% observed. The ranking holds, because early trains are
riskier in every year. For that reason the bands and the observed shares should be shown rather than precise
probabilities.

**Coefficients**, with `lead_minutes / 60` as the input.

| Fit | a | b | Runs |
|---|---:|---:|---:|
| 2024 (2025 fold) | −0.919662 | −1.618185 | 954 |
| **2024–25 (2026 fold, in `model.json`)** | **−0.962943** | **−1.635479** | 1,997 |
| All years, 2024-03 to 2026-10 (reference only, not tested on a later period) | −0.785566 | −1.820373 | 2,766 |

With `model.json` the risk is 28% at 0 minutes, 20% at 15, 14% at 30, 10% at 45 and 7% at 60 minutes.
*check first* covers trains due within about 5 minutes. *check* covers about 5 to 38 minutes, and *low* applies
after that.

**The advisor's replay example** is Sion - Sierre/Siders on 2 January 2026, VIA 2195004968685, with the
notice at 18:08:36. The R91 due at Sion at 18:11 scores 26%, and the record flags Sierre/Siders cancelled. The
IR90 due at Sion at 18:56 scores 9.5% and both its stops were served. The other four trains in that hour
scored 11% to 22%, and all their stops were served. All six are in `scorecard.json`.

## Comparison with the advisor's numbers

Every count, Brier score, coefficient, gradient and calibration figure above matches the advisor's report
exactly:

- 520 notices, 463 of them scored, and 2,766 runs
- folds of 954 → 1,043 runs and 1,997 → 769 runs
- a = −0.962943 and b = −1.635479
- 73/195 against 21/189, and 15.5% predicted against 20.4% observed

The bootstrap lower bounds differ slightly: +0.00057 here against +0.00048 for 2025, and +0.00652 against
+0.00647 for 2026. The advisor did not record its resampling code, and the lower bound moves by about ±0.0001
with the seed. Both intervals stay above zero.

## What this does not show

- **When a cancellation was decided.** The operating record holds the final status only. Some early trains
  were probably already cancelled before the notice, so part of the early-train risk is "this train is usually
  still off". Live, an official cancellation or skipped stop must win over the band. Whether the model also
  helps for trains whose status was unknown at the notice has not been tested.
- **Calibration on other sources.** The probabilities are fitted on the liveticker's VIA notices. The advisor
  found the same gradient but lower absolute risks on SBB's public notices. That was not re-checked here.
- **Live performance.** Nothing here was scored on live resumptions. The historical roster comes from runs that
  reached Ist-Daten, while a live roster comes from the timetable.
