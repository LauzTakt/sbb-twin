# Parity harness: TypeScript twin vs Kotlin twin

Starts BOTH twins as private instances (blank keys, `MQTT_URL=`, own `RAIL_STATE_FILE`, same `RAIL_REPLAY` virtual clock),
queries them at the same virtual instant and diffs the JSON. Python 3 stdlib only.

    /opt/venv/bin/python parity/run_all.py                         # everything, writes parity/REPORT.md
    /opt/venv/bin/python parity/run_all.py --only plan,boards      # groups: static stations boards trains plan journeys geometry brief scenario night replay
    /opt/venv/bin/python parity/run_all.py --kt ts                 # self-test of the harness: TS against a second TS instance
    options: --jar <path> --ts-dir /workspace/rail-twin --ts-port 88xx --kt-port 89xx --replay-times 05:50,07:20,11:05,15:30

Ports: TypeScript 8800-8899, Kotlin 8900-8999 (random free ones); 8787 and 8080 are never touched. Instances are
stopped via their process group and, as a fallback, by scanning `/proc/<pid>/environ` for the PORT (never `pkill -f`).
Logs and state files: `$PARITY_SCRATCH` (default under the session scratchpad). The Kotlin twin is started with
`java -jar kotlin/build/libs/sbb-twin-kotlin-all.jar` from the worktree root (it finds `data/` there); build it first
(`cd kotlin && ./gradlew --offline --max-workers=3 shadowJar`).

## How the clocks are aligned
`RAIL_REPLAY` starts each process's virtual clock at ITS start, so the two clocks differ by a few hundred ms (JVM
vs node start-up). The harness calibrates a linear clock model per instance (`/api/status` `ts` vs local time,
min-RTT sample) and fires each request pair at the same virtual instant (per-instance threads sleeping until the target).
Requests go out in slots 250/750 ms into a virtual second, so both twins answer from the same tick. State changes
(POSTs) carry absolute epoch-ms `start`/`at`/`announcedAt`/`until`, so no server-side "now" has to agree.

## Classification
* exact: identical JSON (random ids `d-/m-/i-xxxx` and `EV-<d>-<m>-` bus ids are replaced by order of appearance first).
* within tolerance: epoch-ms values within 1.5 s (6 s for scenario flows, 4 s for the 20x replay), positions within
  3 m + 1 s of travel, bearing 3 deg, speed 1 km/h.
* differs: anything else, including different HTTP status, keys, list lengths.
Rows present on one side only are accepted just at documented edges (12-row board cut, activation of a standing train) and noted.
Automatic incidents (`source: auto`) are compared by count only in scenario flows: they depend on exact train timing.

## Checks
static endpoints, /api/status structure, error responses, station search (15 queries), boards (20 stations), arrivals,
neighbours, /api/trains + 14 train details/info, plan (15 pairs + via/maxTransfers/includeWait), journeys/{id},
geometry (section/train/journey), brief, situation, three scenario flows (EG_008 Zürich HB - Winterthur with short_turn +
replacement_bus + prognosis + scheduled resume; EG_006 Bern - Thun with hold + partial_resumption + end; EG_052 Lausanne -
Vevey with one_track_open + replacement_bus + resume via /state) comparing disruptions, bulletins and versions, incidents,
boards, affected trains' info and plans with includeWait; night plan (instances at 23:30, `after` 23:35, next-morning
services); Wädenswil replay (20x, `RAIL_DAYS_DIR=/workspace/sbb/gtfs`, `RAIL_REPLAY_SCENARIO=waedenswil-2026-09-10`) at chosen virtual times.

## Known TS-vs-TS nondeterminism (found by self-test)
* Trains in sim mode (held, slowed) advance with the real tick spacing, so two TS processes drift by 2-4 s in expected times.
* Automatic incidents (late, stopped, held) differ between two TS runs; so do the incident warnings in plans.
* `impact.tripsHeld` can differ by 1 right after a measure (timing of the recompute).
