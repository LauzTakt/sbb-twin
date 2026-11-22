# Replacement buses (EV, "Ersatzverkehr")

`buses.py` measures how fast replacement buses really arrive (SBB liveticker), how fast they drive (EV trips of the
official 2026 GTFS) and which real bus stop serves each rail station. It writes `model.json` (read by the twin, no
Python at runtime) and `scorecard.json` (every number on this page comes from it):

```
/opt/venv/bin/python research/buses/buses.py [--no-osrm]   # ~40 s with osrm_cache.json, ~3 min on a cold cache
```

## Lead times (liveticker, 550 incidents)

- **Clock**: the earliest `created_at_source` / `created_date` of the incident's first version (versions ordered by
  `last_modified_date`). **Events**: every PUBLISHED message version, classified by regexes on title + text in its
  original language (search / confirmed / shortage / running; "running" skips sentences in the future tense and
  negated or uncertain ones: "pas de bus en service", "noch nicht klar, wann dieser Bus vor Ort ist", "en cours de mise
  en place"). Values < 0 or > 24 h are dropped.
- First search message: median **41 min** (p25 29, p75 62, n=176). First bus running: median **87 min** (p25 60,
  p75 142, n=182). Search to running: median 35 min (n=70). Shortage or no bus: 11 incidents.
- **0%** of incidents had a bus running within 15 min, 25% within 1 h, 68% within 2 h: the twin's old "first bus
  15 min after the decision" was far too optimistic.
- Out of time (fit on the earliest 60% by start date, check the later 73): 56% fall in the fitted p25-p75 window
  (nominal 50%), 81% in p10-p90 (nominal 80%).
- `model.json` keeps the sorted samples (`samples`): while buses are being organised, the twin shows the middle half
  of the incidents that had no bus yet after the same elapsed time (src/buses.ts `expectedFirstBus`).
- Bus sentence in the bulletin: in the **first** version of 148/480 interrupted incidents (31%); in **some** version
  of 347/480 (72%). An earlier hand count quoted "72% from the first version": that is the any-version count.
- The earlier hand count (search n=38, median 46; running n=41, median 69) used titles only. Titles only here: search
  n=33 (median 44), running n=35 (median 90).

## Speed (GTFS, 341 EV routes)

Road factor **1.23** = median OSRM driving / straight distance on 120 random distinct EV hops (p25 1.11, p75 1.39).
Speed per hop = straight km x 1.23 / scheduled time, identical hops per route counted once: median **32 km/h**
(p25 24, p75 44, 6,447 hops, 330 routes); by straight distance <=2 km 27, <=5 km 33, <=10 km 38, <=20 km 44,
>20 km 53 km/h. Dwell at intermediate stops: median 0 s (timetables are rounded to minutes). On 30% of routes held
out by hash, hop-time MAE is 2.19 min with the band speeds vs 2.70 min for the old flat 50 km/h x 1.3.

## Station stops

1,592 of 1,736 Swiss rail stations get a bus stop: 1,306 used by EV trips within 600 m, 286 other bus stops
("<station>, Bahnhof" or nearest within 400 m). walkMin comes from transfers.txt footpaths for 1,481. Olten ->
"Olten, Bahnhof" (80 m, 5 min); Aarau -> "Aarau, Bahnhof" (80 m, 4 min).

## Limits

- The liveticker records when the control centre *published*, not when a bus left; the regexes are hand-built and
  give the shortage and confirmed counts only roughly.
- The speeds come from timetabled EV trips (planned closures). Emergency buses have no timetable; their speed is assumed.
- 9 EV routes that stop mostly at rail platform stop ids are dropped (one is route type 109); the type-106 EV route
  has road stops and is kept.
