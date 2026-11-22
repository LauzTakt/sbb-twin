# Duration of a disruption (forecast contract, section 1)

`duration.py` builds the incidents, selects and fits the model, runs every baseline and writes `model.json` (applied
live by the twin, no Python at runtime) and `scorecard.json` (every number on this page comes from it):

```
/opt/venv/bin/python research/duration/duration.py      # ~10 s, one CPU
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
| fit | 2024-03..2024-12 (187 incidents ended before 2025) | both families, ridge grid |
| validate | 2025 (193) | pick family + ridge (mean Brier at 60/120/240), cause smoothing, conformal band |
| refit | 2024-03..2025-12 (380 ended before 2026) | the model in `model.json` |
| test | 2026-01..2026-10 (140) | once; nothing was tuned on it |

Chosen on 2025: **log-normal AFT, ridge 1** (mean validation Brier 0.1666; best discrete hazard 0.1680, ridge 0.3).
The other family is also scored on 2026 (`other_family_discrete_hazard`) for transparency.

Baselines: `prior` = Kaplan-Meier of the training durations; `cause` = survival per EG code shrunk towards the prior
(pseudo-count chosen on 2025); `operator` = SBB's first announced end calibrated into a probability per horizon
(logistic on ln(announced / horizon), no-end and at-least flags, fitted on training years); `operator_point` = 1 if
the announced end is after the horizon. For the end time: the announced end itself, the announced end plus the
training median residual, and Didac's gradient-boosted residual (`sbb_prediction_study.py`, re-run on these labels).
Intervals: 95% paired bootstrap over whole test weeks (2000 resamples), model minus baseline (negative = model better).

## Results on Jan-Oct 2026 (140 incidents)

| Brier (lower is better) | model | operator (calibrated) | cause | prior | model - operator, 95% CI | model - prior, 95% CI |
|---|---|---|---|---|---|---|
| still open at 60 min | **0.148** | 0.164 | 0.152 | 0.162 | -0.032 .. +0.002 | -0.044 .. +0.015 |
| still open at 120 min | 0.227 | 0.235 | **0.224** | 0.257 | -0.023 .. +0.009 | -0.065 .. +0.005 |
| still open at 240 min | **0.190** | 0.200 | 0.198 | 0.225 | -0.022 .. +0.003 | **-0.064 .. -0.011** |

- The model is the best or level-best at every horizon from the first notice, but only the gain over the historical
  rate at 240 min is outside the noise; against SBB's calibrated announcement and the per-cause rates the intervals
  include zero. The raw announcement taken literally (`operator_point`) is far worse (Brier 0.31 / 0.39 / 0.23).
- **End time** (132 incidents with an announced end): mean absolute error of the model median 120 min, the
  announced end 117 min, announced end + training median correction (+27.5 min) 109 min, Didac's learned residual 108 min. The
  model median does not beat the announcement as a point forecast; the corrected announcement is the better point
  when an end is announced (interval of model minus Didac: +0.2 .. +31 min).
- **80% band** (conformal on 2025): covers 78% of 2026 incidents (95% CI 72-84%), median width 5.1 h; the
  uncalibrated log-normal band covers 74%.
- **Still open after 30 or 60 min**: the model with S(t)/S(e) uses start features only, while SBB's *latest*
  announcement at that moment, calibrated, is better: at 60 min elapsed, Brier at 120 min 0.207 vs 0.170 (model
  worse, CI +0.001 .. +0.073). Once a disruption is under way, the operator's updated estimate wins.
- Calibration (120 min): the model under-predicts "still open" in 2026 (e.g. predicted 0.36 / observed 0.48 in the
  30-40% bin). 2026 disruptions lasted longer than 2024-25 (still open at 4 h: 30% vs 17-19%), while SBB's
  announced durations stayed the same (median 70 min) and "at least" announcements fell from 37-44% to 20%.

### Planned construction

The liveticker holds unplanned disruptions; its "construction" cases are mostly EG_158 *unscheduled* construction
work (urgent repairs), 17 in training and 7 in the test. Their end is **not** as announced: 14% of test cases (29% in
training) ended within 30 min of the announced end, mean absolute error 108 min. The model is better on them
(76 min, Brier at 120 min 0.155 vs 0.215, on 7 incidents). Timetable-planned closures (GTFS-RT `CONSTRUCTION` /
`MAINTENANCE` alerts published days ahead) are not in this data, so nothing here validates them; for those the
announced active period is the natural end.

## Compared with Astra's numbers

Astra (advisor) reported Brier at 120 min 0.2104 vs cause 0.2210, operator 0.2316, prior 0.2502 on 145 held-out 2026
incidents, with a clock starting at VIA creation and a model fitted only for that horizon. This model covers every
horizon (one survival curve), the conditional case, the end time and a calibrated band, but on its own labels it
does not improve the 120-min Brier (0.227 vs its own baselines 0.224 / 0.235 / 0.257); the 60 and 240 min horizons
are where it leads. The comparison is not like for like (different clock and label definitions).

## Limits

- 140 test incidents: differences of about 0.01 Brier are within noise unless the interval excludes zero.
- Distribution shift: 2026 disruptions last longer; a model frozen on 2024-25 under-predicts them.
- Administrative labels and clock (liveticker, not trains). Incidents never closed are excluded, not censored.
- Live, the cause comes from the GTFS-RT alert cause enum (`causeMap` covers all 12 values), which is coarser than the
  VIA reason codes the model was fitted on.
