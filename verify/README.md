# Planner verification harness (gates A-E)

An independent check of the sbb-twin journey planner (`GET /api/plan`). It follows Astra's verification gates.
The claim under test: **for a stated timetable snapshot, departure time, endpoints, modes, transfer cap and
reopening assumption, the recommended journey is feasible and no permitted journey ranks better** by
(arrival, changes, −departure).

The harness reuses no planner code. The oracle reads the national GTFS ZIP itself
(`/workspace/sbb/gtfs/gtfs_fp2026_20261118.zip`). It reads only three twin artefacts, all of them data:

- the disruption **records** (`GET /api/disruptions/{id}`);
- the published **physical paths** (`data/paths.json.gz`, `data/network.json.gz`), used only to tell which rides
  occupy a closed track;
- the station coordinates the twin publishes (`/api/stations.geojson`), used for its documented bus timing model.

Everything runs against **private twins**, never 8787/8080. They have no realtime, no MQTT broker and no secrets
(`verify/twin.sh`). The planner under test is pinned to a commit in a detached worktree, so its author's
uncommitted edits never change a measurement.

<!-- RESULTS -->
Generated 2026-11-22 09:20 (Swiss time). before = `main` @ `8db1e72`, after = `feat/planner-exact` @ `9e9c2e0`.

**Gate A, external differential (transport.opendata.ch, static timetable, scheduled-to-scheduled in seconds, every disagreement arbitrated by the oracle)**

| | cases | identical | explained | unexplained | oracle agrees with planner | invalid journeys (Gate C) | name resolver disagreements |
|---|---|---|---|---|---|---|---|
| before | 217 | 102 | 9 | 106 | 100/217 | 68/579 | 15 |
| after | 217 | 165 | 52 | 0 | 212/217 | 1/1244 | 0 |

**Gate B, independent oracle (4 regional subnetworks, rail + EV + published footpaths, departure times still in the future, caps 3/1/0)**

| | cases | exact agreement (arrival, changes, departure) | failures by verdict | invalid journeys (Gate C) |
|---|---|---|---|---|
| before | 560 | 276/560 | fail-departure 4, fail-empty 211, fail-later 51, oracle-miss 18 | 62/1733 |
| after | 600 | 595/600 | oracle-miss 5 | 0/3391 |

**Gate D, seeded disruptions (closures, short turns, holds, UNTIL / UNTIL_AT_LEAST / UNKNOWN, added buses), oracle on our own projection of the record**

| | cases (stages) | oracle agreement | planner misses | certain journey invalid under the closure | projection differences (not counted) | certain detours outside the oracle region | other to check | invariant failures (remove / add bus / caps) | harness errors |
|---|---|---|---|---|---|---|---|---|---|
| after | 100 (151) | 122/151 | 2 | 0 | 9 | 18 | 0 | 0 / 0 / 0 | 0 |

**Gate E, Wädenswil replay (10 Sep 2026), observed witnesses**

| | W1: S8 18823 never crosses before the reopening, no certain crossing | W2: S8 18839 admitted after the 11:00 partial reopening |
|---|---|---|
| before | pass (0 violations) | pass (Wädenswil 11:07:02 -> Pfäffikon SZ 11:19:02, arrival error vs REAL -93 s) |
| after | pass (0 violations) | pass (Wädenswil 11:07:00 -> Pfäffikon SZ 11:19:00, arrival error vs REAL -95 s) |

**Summary (after):** A: 165/217 identical, 52 explained, 0 unexplained (oracle agrees 212/217); B: 595/600 oracle agreement; C: 1 invalid of 4635 journeys; D: 100 seeded cases (151 stages), 2 oracle mismatches, 0 invariant failures (122 exact agreements, 18 detours outside the oracle region, 9 projection differences, 0 to check); E: 2/2 witnesses
<!-- /RESULTS -->

Failing cases are grouped by cause, with examples (OD, time, planner answer, oracle or reference answer, why), in
`results/failures-after.json` (and `failures-before.json`).

## Running it

```bash
PY=/opt/venv/bin/python
# 0. data: one streaming pass over stop_times.txt (about 1 min), dated trips/calls/quays/rules for 3 service days
$PY verify/gtfs_extract.py 20261121 20261122 20261123        # and 20260909 20260910 20260911 for the replay
# private twins (stop by PORT in /proc/<pid>/environ, never pkill -f)
git -C /workspace/rail-twin worktree add --detach /workspace/rail-twin-verify-after <planner commit>
ln -s /workspace/rail-twin/node_modules /workspace/rail-twin-verify-after/node_modules
verify/twin.sh start 8805 /workspace/rail-twin                 # before = main
verify/twin.sh start 8806 /workspace/rail-twin-verify-after    # after  = feat/planner-exact @ commit
verify/twin.sh wait 8806
# A: external differential (reference responses are cached under results/gate_a/ref, <= 1 request/s)
$PY verify/gate_a.py --twin after=http://127.0.0.1:8806 --times 09:37,12:04,16:58,19:33,23:20 --out verify/results/gate_a-after.json
$PY verify/gate_a.py --reclassify verify/results/gate_a-after.json   # + Gate C on every journey + oracle arbitration
# B: oracle vs planner on 4 regional subnetworks (+ Gate C on every journey)
$PY verify/gate_b.py --twin after=http://127.0.0.1:8806 --out verify/results/gate_b-after.json
# D: seeded disruptions + invariants
$PY verify/gate_d.py --twin http://127.0.0.1:8806 --label after --cases 200 --seed 1
# E: Wädenswil replay witnesses (replay twins on 8807/8808)
verify/twin.sh start 8807 /workspace/rail-twin-verify-after RAIL_REPLAY=2026-09-10T05:30 RAIL_REPLAY_SPEED=20 \
    RAIL_REPLAY_SCENARIO=waedenswil-2026-09-10 RAIL_DAYS_DIR=/workspace/sbb/gtfs
$PY verify/gate_e.py --twin after=http://127.0.0.1:8807 --twin before=http://127.0.0.1:8808
# grouping and tables
$PY verify/failures.py --tag after && $PY verify/report.py
# everything "after" in one go (A, B, D, then failures)
PORT=8806 CASES=100 verify/run_after.sh
```

Validate one live answer: `$PY verify/validate.py http://127.0.0.1:8806 8500218 8507492 10:30` (origin and
destination as DiDok, departure HH:MM today).

## What each gate does

**A. External differential** (`gate_a.py`). This is the 08:30 comparator (`scratchpad/plan_vs_sbb.py`) with
Astra's fixes:

- origin eligibility uses the twin's clock: scheduled times for a twin without realtime, prognosis when it has one
  (`--eligibility expected`);
- costs are compared in seconds;
- queried and returned endpoints and modes are recorded, by DiDok and by name (the resolver is checked
  separately);
- every attempted case is in the denominator;
- the reference is paged until it covers the best arrival;
- every raw response is kept;
- the departure times are at least 30 min ahead of the reference fetch (`minRefLeadMin` in the results).

The cases are the 30 frozen ODs plus exact-platform (Spiez IC6 to RE9 with its 120 s trip rule; Renens platform 4
to 2), same-train, EV (Interlaken, Cadenazzo-Locarno), zero-change (`maxTransfers=0`) and midnight cases, at
09:37, 12:04, 16:58, 19:33 and 23:20.

The reference ignores `direct=1`, so its zero-change fixtures keep only its 0-change connections. Every
disagreement goes to the oracle on the national rail/EV network with published footpaths:

- if the oracle agrees with the planner, the difference is explained as MOTIS using a transfer, footpath or access
  point the published rules do not have;
- if the oracle confirms the planner is worse, the case stays unexplained.

Other explained classes: ordinary bus modes the planner does not load, a reference that ends at a different
access point, sub-minute differences.

**B. Independent oracle** (`oracle.py`, `gate_b.py`). A time-expanded event graph on dated trip occurrences.

- Nodes are calls at exact quays with their `stop_sequence`.
- You can ride through a call without stopping. Boarding is allowed unless `pickup_type=1`, alighting unless
  `drop_off_type=1`.
- In-seat continuations (`transfers.txt` type 4, dated by `service_id`) cost no change.
- Transfers follow the most specific `transfers.txt` rule, in GTFS precedence: both trips > trip + route > one trip
  > both routes > one route > stop pair, and an exact quay beats a station-level stop. Type 3 forbids, type 1 is
  timed (0 s), type 2 gives the minimum, and the Swiss 120 s applies inside one station. Moving between stations
  needs a published footpath (its `min_transfer_time` is the walk).
- Access and egress use the station's own quays, or a published footpath to and from nearby stops.

The search runs in rounds by number of rides (at most `maxTransfers+1`). Each event keeps the latest origin
departure that reaches it. Event times are fixed, so this is exact. It returns the lexicographic optimum, the
(arrival, changes) frontier and a witness.

The regions are:

- Olten-Aarau-Zürich;
- Bern-Thun-Spiez-Interlaken (EV1);
- Lugano-Bellinzona-Cadenazzo-Locarno (EV);
- Zürich-Wädenswil-Pfäffikon SZ-Rapperswil.

That gives 40 ODs at 12 departure times, with caps 3, 1 and 0. Departure times already past when queried are
skipped. A live twin rightly treats trains that have left as gone, so a past time is not a timetable question.

**C. Validator** (`validate.py`). It checks each journey from `/api/plan` against our own data:

- the trip occurrence runs that day;
- the boarding and alighting calls exist at those stations and times, with pickup/drop-off allowed, in call
  order;
- times are monotonic;
- every change meets the published minimum, and changing stations needs a published footpath;
- the change count is right (in-seat continuations excluded);
- the endpoints are the requested stations, or a published footpath to or from them;
- the journey leaves no earlier than the query time.

Under measures it uses our projection: a ride never crosses a closed edge during the closure, never uses a call
after a short turn, and a held train counts at its release. It runs on every journey of Gates A, B and D.

**D. Seeded disruptions** (`gate_d.py`, `measures.py`). Each case draws a section in one of the regions, a start
(−40 to +60 min), a duration, a duration type (UNTIL, UNTIL_AT_LEAST, UNKNOWN), with or without a short turn
(both, A or B), and optionally an added replacement bus. Then:

1. Ask the planner before the disruption.
2. Create the disruption and ask again.
3. If a bus was drawn, add it and ask again.
4. Ask with caps 1, 2 and 3.

The oracle recomputes from our own projection of the record (documented contract, `TWIN_API_NOTES.md`):

- A ride occupies the closure when the physical path of its station pair shares an interior closed edge, or the
  closed edges at both boundaries. Station-throat edges shared with other lines (Spiez junction to Spiez) do not
  count.
- A train that has left its entry station before the decision continues.
- A train due in [start, end) is held at its entry until the end. It is cut there instead under an active short
  turn when it would wait more than 20 min or the end is unknown.
- Buses follow the documented timing model, calibrated on the twin: first bus = ceil(measure time +
  firstInMin), then every `everyMin`; hop = max(60 s, ceil₃₀(1.3 × great-circle km / 50 km/h)); +60 s at each
  intermediate stop.
- The **confirmed** class never crosses after a lower-bound or unknown reopening. The **conditional** class may.

The planner's best confirmed journey is compared with the confirmed optimum. When they disagree, each train of
the oracle's witness is probed on the twin directly (`maxTransfers=0` between its own stations):

- every witness train runs at our times: a **planner miss**;
- the twin cancels or retimes one: a **projection difference**, which is reported but not counted against the
  planner.

Invariants are checked on the planner's own answers:

- a closure never improves its optimum;
- adding a bus never worsens it;
- raising `maxTransfers` never worsens it.

**E. Wädenswil replay** (`gate_e.py`). Private replay twins on the virtual clock reveal each decision at its real
time. Snapshots are taken after the 05:43 closure, the 06:54 to 06:58 decisions, the 07:13 buses, the 08:32 buses,
10:53/10:55 and the 11:00 partial reopening. Two witnesses from the Ist-Daten (`sbb/history/months/2026-09.parquet`):

- **W1**: S8 18823-001 reached Wädenswil at 07:08:02 (REAL) and its Pfäffikon SZ call was cancelled. No journey may
  ride it beyond Wädenswil, and no certain journey may cross Wädenswil-Pfäffikon SZ before 11:00 (checked on the
  physical paths).
- **W2**: S8 18839-001 actually ran Wädenswil 11:07:46 to Pfäffikon SZ 11:20:35. The planner must offer it after
  the partial reopening. The report gives its arrival error against the observation.

## Limits

- The oracle covers four regional boxes. A planner journey that leaves the box is "unjudged", never counted as a
  failure.
- The national oracle (Gate A arbitration) is rail + EV + published footpaths. Ordinary buses are a separate,
  explained class.
- Measure semantics are reconstructed from the documented contract. Some rules are undocumented, for example
  `tripsStartingAfter` and trains that start inside a section. Those disagreements are attributed as projection
  differences with probe evidence.
- The September replay day file was built from the November feed (20261118), as Astra notes. No
  `route-2026-09-10.json.gz` sidecar exists, so the new planner runs its station-level fallback in the replay.
- Exhaustion certifies individual finite cases (including "no route") on the stated snapshot. It is not a proof
  for every input.
