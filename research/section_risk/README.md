# Section risk map (prevention)

Which stretches of the Swiss rail network concentrate disruptions, and does a ranking learnt on one period
predict where the disruptions of the next period happen? Contract: `research/forecast-contract.md`, section 4.

```
/opt/venv/bin/python research/section_risk/section_risk.py      # ~10 s, one CPU
```

writes `segments.geojson` (the map layer) and `scorecard.json` (the evidence). Every number in the scorecard comes
from the script, on local data: the VIA liveticker export (`/workspace/sbb/Daten/extern-liveticker`, not
committed) and the twin's own `data/network.json.gz`, `data/paths.json.gz` and `data/days/*.json.gz`.

## Result (out of time: ranked on 2024-03..2025-12, checked on 2026-01-01..2026-10-12)

Share of the 140 test-period disruptions that fall in the top k % of the 1,954 ranked segments (each incident
counts once, spread over the segments of its section), 95 % paired bootstrap intervals over incidents:

| Ranking | top 5 % | top 10 % | top 20 % | km of network in the top 10 % |
|---|---|---|---|---|
| **model** (regression + regional history + shrinkage) | **33 %** [27, 40] | **53 %** [46, 61] | **75 %** [68, 81] | 15 % |
| raw training counts per segment | 37 % | 52 % | 71 % | 13 % |
| train-km (trains per day x km) | 14 % | 23 % | 39 % | 22 % |
| trains per day | 11 % | 20 % | 46 % | 6 % |
| track length | 10 % | 20 % | 35 % | 30 % |

- The model beats every exposure baseline at every cut-off by a wide margin (model minus trains per day at 10 %:
  +0.23 to +0.44; the week-block bootstrap gives the same picture).
- It does **not** clearly beat the plain count of past incidents per segment: -0.04 [-0.08, 0.00] at 5 %,
  +0.01 [-0.03, 0.05] at 10 %, +0.04 [0.00, 0.08] at 20 % (the week-block interval at 20 % touches zero). Where
  disruptions happened before is by far the strongest signal; traffic and length add little. The model's value
  over raw counts is that it gives every segment a rate (also segments with no past incident, through the regional
  term) and damps one-off counts, not a measurably better top list.
- Calibration: the model expected 166 test incidents and 140 happened (2026 had fewer published incidents per
  month than 2024-25); the top 5 % expected 62 and got 46 (regression to the mean on the hottest segments).

## Method

- **Segments.** The BAV track graph (the twin's `network.json.gz`, 3,485 BAV Netzsegmente) cut at every station
  served by a train in the twin's GTFS day files, at every junction and track end, and at every station a training
  incident names (a few lines have no trains in the November 2026 timetable, for example Moutier - Sonceboz). Each
  segment is the track between two consecutive served stations, or between a station and a junction. Ranked:
  segments with trains, plus any segment a training incident touched: 1,954 segments, 4,933 km.
- **Exposure.** Track km (from the BAV geometry) and trains per day on Monday 2026-11-23 (each train run counted once
  per segment its stop-to-stop track paths use, `paths.json.gz`; lines without trains that Monday take the busiest
  other day file). Single-track share from the BAV track count.
- **Incidents to segments.** All VIA incidents with an "Interrupted service" or "Limited service" version (543; 7
  withdrawn ones left out). The section is read from the last active version's summary (fallback: earlier ones):
  "A - B" goes to the segments of the shortest track path from A to B over track with trains (else over any
  track); "A - B and C" uses both branches; "A" alone goes to the segments at station A. Names are matched with the
  history study's normalisation (`/workspace/sbb/history/build_effects.py`, `norm`). A cross-border section is
  placed on its Swiss part (path to the Swiss node nearest the foreign station). Each incident's weight 1 is spread
  evenly over its segments. Cause groups follow the contract and the EG mapping of `research/duration/model.json` (`planned`, `infrastructure`, `rolling_stock`,
  `person`, `external`, `other`) from the first active version's EG code.
- **Model.** Poisson regression of each segment's training-period count on log km, log(1 + trains per day),
  single-track share and the log of past incidents on other segments within about 20 km (a Gaussian kernel that
  leaves the segment itself out), then Poisson-gamma empirical Bayes: rate = mu x (y + a) / (mu + a) with a = 0.3.
  The kernel width (none, 5, 10, 20, 40 km) and the shrinkage a (negative-binomial ML, 0.03 .. 3, none) were chosen
  on an internal split, fit 2024-03..2024-12 and validate on 2025 (`validationGrid` in the scorecard; the
  negative-binomial ML value shrank far too much, because incidents are spread fractionally over segments). Then
  refit on 2024-03..2025-12 and tested once on 2026.
- **Check.** recall@k = share of test-incident weight inside the top k % of segments by count of segments; baselines
  rank by track length, trains per day, train-km and raw training counts (ties broken by trains per day, then a
  fixed random order). Paired bootstrap, 2,000 resamples of test incidents, and a week-block bootstrap (whole ISO
  weeks resampled, for storms that hit several segments at once).

## `segments.geojson`

1,954 LineStrings in rank order (simplified to 15 m, coordinates to 5 decimals, 0.9 MB). Properties:
`id` (BAV station ids of the two ends), `name` ("A - B"), `km`, `risk` (expected incidents per year / the
maximum, 0..1), `rank` (1 = riskiest), `perYear` (expected incidents per year), `trainsPerDay`, `incidentsTrain`
and `incidentsTest` (incidents touching the segment in 2024-03..2025-12 and 2026-01..10), `topCauses` (cause
groups of the training incidents, by weight), `edges` (the BAV Netzsegment ids, the ids of the twin's
`network-lines.geojson` features, to highlight a segment on the existing layer).

## Honest limits

- **The source is not all disruptions.** The liveticker holds about 200 published, service-interrupting incidents a
  year, 70 % of them first written in French: the map ranks where *these* incidents happen, and western Switzerland
  (Broye line Payerne - Estavayer - Cugy, Lausanne - Romont, Nyon - Gland) dominates. A national map needs a
  national incident feed.
- **History is the signal.** The model is level with ranking by raw past counts; its added value is a rate for every
  segment and less noise, not a better top 10 %. Exposure alone is a poor predictor here.
- **Sections are coarse.** An incident on "A - B" is spread evenly over the whole path, a one-station incident over
  every segment at the station; the true spot inside the section is unknown.
- **Exposure is today's timetable** (November 2026) applied to 2024-26; trains passing without stopping count.
- **Small test.** 140 test incidents in 9.3 months; the intervals above are wide for single segments, so a
  segment's own `perYear` is uncertain even where the ranking holds as a whole.
- Not placed: 12 incidents entirely abroad or with foreign stations the twin does not know (listed under
  `unplaced` in the scorecard: Brig - Domodossola, Bellegarde - Bourg-en-Bresse, Thonon - Evian, Varese -
  Malpensa, ...).
