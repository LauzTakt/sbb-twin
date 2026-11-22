# sbb-twin in Kotlin

A Kotlin (JDK 21, Ktor/Netty) port of the sbb-twin simulator in `../src`: same `/api`, the same `/live` WebSocket,
the same MQTT topics (external broker) and the same replay clock. The TypeScript twin is the specification and the
parity oracle (`parity/`). The viewer UI stays TypeScript: the server serves its build from `../viewer/dist`.

## Build, run, test

    export JAVA_HOME=/home/agent/.local/jdk-21 PATH=$JAVA_HOME/bin:$PATH
    cd kotlin
    ./gradlew --offline --max-workers=3 shadowJar          # build/libs/sbb-twin-kotlin-all.jar
    ./gradlew --offline --max-workers=3 test               # JUnit tests of the pure logic
    java -jar build/libs/sbb-twin-kotlin-all.jar           # http://127.0.0.1:8787/ (PORT, HOST)

The jar finds `data/` by walking up from the working directory (or `RAIL_ROOT`). Viewer: `npx vite build viewer` in the
repo root writes `viewer/dist` (gitignored).

Environment variables are the same as the TypeScript twin: `PORT`, `HOST`, `MQTT_URL`, `MQTT_USERNAME`,
`MQTT_PASSWORD`, `TOPIC_ROOT`, `RAIL_DATA_DIR`, `RAIL_DAYS_DIR`, `RAIL_STATE_FILE`, `OTD_GTFS_RT_KEY`/`_URL`, `RT_INTERVAL_MS`,
`OTD_GTFS_SA_KEY`/`_URL`, `SA_INTERVAL_MS`, `ANTHROPIC_API_KEY`, `BULLETIN_MODEL`, `BULLETIN_TIMEOUT_MS`,
`BULLETIN_BACKGROUND_MS`, `RAIL_REPLAY`, `RAIL_REPLAY_SPEED`, `RAIL_REPLAY_SCENARIO`, `RAIL_ENV_FILE`
(default `~/.config/lauzhack/.env`), plus `RAIL_ROOT` and `RAIL_VIEWER_DIR`.

## Parity

`parity/run_all.py` starts both twins as private instances (blank keys, same virtual clock) and diffs their JSON; see
`parity/README.md` and the last `parity/REPORT.md`. Results are summarised there.

## Ported

Timetable and stations, engine (positions, effective timetable, boards, arrivals), disruptions, scenarios with all
measures, catalogue, bulletins (template and Claude Haiku wording with the same validator), brief, planner (/plan,
/journeys, /situation, /geometry/*), GTFS-RT TripUpdates polling, GTFS-SA alerts with abroad routing, the automatic
incident detector, the Wädenswil replay, `/live`, MQTT publishing with retained cache and stale sweep, the read-only
`/mqtt` WebSocket proxy, persistence.

## Not ported / differences

- Without `MQTT_URL` there is no embedded broker: nothing is published and `/mqtt` closes at once.
- The `/mqtt` proxy handles MQTT 3.1.1 (protocol level 3 and 4) only.
- Weather, train protection UI, 3D: removed on purpose (the engine keeps the protection switch default on).
- Natural line ordering approximates JS `localeCompare(numeric)`.
