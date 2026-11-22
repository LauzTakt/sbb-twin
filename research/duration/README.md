# Duration of a disruption (forecast contract, section 1)

`duration.py` builds the incidents, selects and fits the model, runs every baseline and writes `model.json` (applied
live by the twin, no Python at runtime) and `scorecard.json` (every number on this page comes from it):

```
/opt/venv/bin/python research/duration/duration.py      # ~15 s, one CPU
```

## What it predicts

S(t) = P(the disruption is still not resumed t minutes after its first public notice), from what is known at that
notice; once it has been open e minutes, S(t | e) = S(t) / S(e).

- **Clock**: starts at the first liveticker version that is `INFO` and titled "Interrupted service:" or "Limited
  service:" (a window announced in advance starts at its `duration_from`). Live: the moment the alert is first seen.
- **Label**: the first later version titled "Service resumed:" or with lifecycle `ENDED`. It is the administrative
  end, not the first train through. 520 of 550 incidents have one; 30 (withdrawn or never closed) are excluded.
- **Features** (the contract's, from the first active version): cause group of the VIA reason code, interrupted vs
  limited, one station vs a section, ln(announced minutes), no announced end, "at least" announcement, local start
  hour bucket, weekend.
- **Announced end**: `duration_to` for every duration type with an end. For the "at least" types the text says
  "at least until <duration_to>"; the `duration_at_least` column holds a shifted time of day and is not used. An
  announced end at or before the start, or more than 7 days later, is a placeholder and counts as "no end".

## Protocol

| step | data | use |
|---|---|---|
| fit | 2024-03..2024-12 (187 incidents ended before 2025) | both families x ridge x clock features on/off x recency weighting |
| validate | 2025 (193) | pick the setting (mean Brier at 60/120/240), cause smoothing, conformal band, point rule |
| refit | 2024-03..2025-12 (380 ended before 2026) | the model in `model.json` |
| test | 2026-01..2026-10 (140) | nothing is chosen on it |

Chosen on 2025: **log-normal AFT, ridge 1, all features, training incidents weighted by recency (half-life 365
days)**: mean validation Brier 0.1651; best discrete hazard 0.1660 (ridge 0.3, no clock features). The other family is
also scored on 2026 (`other_family_discrete_hazard`) for transparency.

Baselines: `prior` = Kaplan-Meier of the training durations; `cause` = survival per EG code shrunk towards the prior
(pseudo-count 2, chosen on 2025); `operator` = SBB's first announced end calibrated into a probability per horizon
(logistic on ln(announced / horizon), no-end and at-least flags, fitted on the training years); `operator_point` = 1 if
the announced end is after the horizon. For the end time: the announced end itself, the announced end plus the
training median residual, and Didac's gradient-boosted residual (`sbb_prediction_study.py`, re-run on these labels).
Intervals: 95% paired bootstrap over whole test weeks (2000 resamples), model minus baseline (negative = model better).

## Results on Jan-Oct 2026 (140 incidents)

| Brier, still not resumed at | model | operator (calibrated) | cause | prior | model - operator, 95% CI | model - prior, 95% CI |
|---|---|---|---|---|---|---|
| 60 min | **0.146** | 0.164 | 0.152 | 0.162 | **-0.035 .. -0.000** | -0.044 .. +0.012 |
| 120 min | 0.225 | 0.235 | **0.224** | 0.257 | -0.024 .. +0.007 | -0.065 .. +0.003 |
| 240 min | **0.188** | 0.200 | 0.198 | 0.225 | -0.026 .. +0.002 | **-0.066 .. -0.013** |

- From the first notice the model is best or level-best at every horizon. The gain is outside the noise against
  SBB's announcement at 60 min and against the historical rate at 240 min; the rest is within noise (per-cause rates
  are level at 120 min). The announcement taken literally (`operator_point`) is far worse: 0.31 / 0.39 / 0.23.
- **End time** (132 incidents with an announced end), mean absolute error: model median 121 min, announced end 117,
  announced end + median correction 109, Didac's learned residual 108. The model median does not beat the
  announcement as a point. So `model.json` reuses Didac's simple correction for the displayed end time
  (`pointForecast`: announced end + 27.5 min; chosen on 2025, where it scored 96 vs 99 for the model median and 101
  for the announcement); without an announced end it shows the model median.
- **80% band** (split conformal on 2025): covers 79% of 2026 incidents (95% CI 73-84%), median width 5.1 h; the
  uncalibrated log-normal band covers 75%.
- **Still open after 30 or 60 min.** S(t)/S(e) with the start features only (as in the contract) loses to SBB's
  latest announcement, calibrated (e.g. open at 60 min, Brier at 120 min 0.207 vs 0.170). Re-reading the announced
  end from the latest version (`model_updated`, same coefficients, clock from the original start) fixes most of
  that: 0.105 / 0.205 / 0.168 (open at 30 min, horizons 60/120/240) and 0.180 / 0.184 (open at 60 min, 120/240),
  better than start-only at every pair (intervals below zero in 4 of 5) and level with the calibrated latest
  announcement (point estimates better in 4 of 5, intervals include zero). `model.json` states this `updates` rule.
- **Calibration** at 120 min: the model under-predicts "still open" in 2026 (predicted 0.45 / observed 0.59 in the
  40-50% bin). 2026 disruptions lasted longer than in 2024-25 (still open at 4 h: 30% vs 17-19%), while the announced
  durations stayed the same (median 70 min) and "at least" announcements fell from 37-44% to 20%. Refitting every
  month on everything ended by then does not help (`deployment.monthlyRefit`, intervals include zero).

### Planned construction

The liveticker holds unplanned disruptions; its "construction" cases are mostly EG_158 *unscheduled* construction
work (urgent repairs): 17 in training, 7 in the test. Their end is **not** as announced: 14% of the test cases (29% in
training) ended within 30 min of the announced end; mean absolute error of the announcement 108 min, of the model
median 60 min (Brier at 120 min 0.158 vs 0.215; 7 incidents, so only indicative). Timetable-planned closures
(GTFS-RT `CONSTRUCTION` / `MAINTENANCE` alerts published days ahead) are not in this data, so nothing here
validates them; for those the alert's announced active period is the natural end.

### Live cause

`causeMap` maps all 93 VIA reason codes and all 12 GTFS-RT `Alert.Cause` values to the contract groups (EG_028
derailment and EG_034 train collision are counted as infrastructure, EG_001 barrier failure too). SBB's alerts often
carry the cause only in the text, so `causeText` lists the reason phrases in de/fr/it/en (longest first) for the
twin to match in the alert header or description.

## Compared with Astra's numbers

Astra reported, on 145 held-out 2026 incidents, Brier at 120 min 0.2104 vs cause 0.2210, operator horizon 0.2316 and
prior 0.2502, for a model fitted only for that horizon and a clock starting at VIA creation. Here, on 140 incidents
with the clock at the first public notice: 0.225 vs 0.224 / 0.235 / 0.257. The 120-min Brier is not improved (the
labels and clock differ, so the numbers are not like for like). What is new: one survival curve for every horizon
(the 60 and 240 min results above, where the model leads), the end time (MAE 117 -> 109 min with the reused
correction; Didac's 112.3 -> 104.3 was on other labels), a calibrated 80% band (79% coverage where Didac's nominal
80% covered 68%), and the conditional case with updated announcements, where Astra found the gain inconclusive and
here the updated model is level with SBB's latest estimate.

## Limits

- 140 test incidents: differences of about 0.01 Brier are within noise unless the interval excludes zero.
- Distribution shift: 2026 disruptions last longer; a model frozen on 2024-25 under-predicts them.
- Test-set reuse, stated openly: a first version (equal weights, no clock-feature choice) scored 0.148 / 0.227 /
  0.190 on the same test; recency weighting and the clock-feature option were then added to the 2025 grid, which
  chose the current setting. 2026 never chose among settings, but it was looked at twice.
- Administrative labels and clock (liveticker, not trains). Incidents never closed are excluded, not censored.
- Live, the GTFS-RT cause enum is coarser than the VIA reason codes the model was fitted on.
