# sbb-twin

A live digital twin of every Swiss train, published on MQTT.

- **Trains**: every train in service (≈ 900–1,900 depending on the hour), one precise position per second. Positions are
  computed from the official timetable (GTFS) and the official real-time predictions (GTFS-RT delays, cancellations,
  skipped stops), along the **real track geometry** of the federal rail network (BAV), with realistic acceleration and braking.
- **Control** lets staff register a disruption at a station or on a section of track, publish a bulletin and apply
  measures such as a replacement bus or a short turn. Staff can also simulate a breakdown or cancellation on a
  train in service and see the effect on departures and journey plans.

Other teams consume the MQTT feed (e.g. incident detection from positions, passenger or station UIs).
The control page at `/` is the twin's own console: it reads the twin directly (WebSocket `/live`, the whole state
again after every change), so it always shows exactly what the twin holds. MQTT is the twin's output for everybody else.

Apps built on this data follow one look: **[docs/sbb-style.md](docs/sbb-style.md)** (SBB type, colours, train and
disruption colours, map conventions, components).

## Connect

sbb-twin publishes to the **team broker** (`MQTT_URL`); its address and credentials are shared in the team channel,
not in this public repository. Without `MQTT_URL` it runs its own broker (local and Docker).

| | Address | Credentials |
|---|---|---|
| Team broker, MQTT over TCP | `mqtt://<team-broker>:1883` | team user and password |
| Team broker through sbb-twin, MQTT over WebSocket | `wss://<public-host>/mqtt` | none: a **read-only** proxy limited to `sbb-twin/v1/#` |
| Own broker (no `MQTT_URL`) | `ws://127.0.0.1:8787/mqtt` (no TCP port is opened) | none (anonymous, read-only) |

MQTT 3.1.1 or 5. Publish only under `sbb-twin/v1/detections/{team}/…` and `sbb-twin/v1/ext/{team}/…` (the own broker
enforces it; on the team broker it is the rule). Use a unique client id and a clean session. Retained messages survive
restarts on the team broker: sbb-twin republishes its state when it starts and removes its stale ones within a minute.

```python
# pip install paho-mqtt==2.1.0
import json, os, paho.mqtt.client as mqtt
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
c.username_pw_set(os.environ["MQTT_USERNAME"], os.environ["MQTT_PASSWORD"])
c.on_connect = lambda c, u, f, rc, p: c.subscribe("sbb-twin/v1/fleet")
c.on_message = lambda c, u, m: print(len(json.loads(m.payload)["trains"]), "trains")
c.connect(os.environ["MQTT_HOST"], 1883)
c.loop_forever()
```

```js
// npm i mqtt   (browsers: <script src="https://unpkg.com/mqtt@5.10.4/dist/mqtt.min.js"></script>)
const mqtt = require("mqtt");
const c = mqtt.connect("wss://<public-host>/mqtt");     // read-only, no credentials
c.on("connect", () => c.subscribe(["sbb-twin/v1/fleet", "sbb-twin/v1/trains/+/info"]));
c.on("message", (topic, bytes) => {
  if (!bytes.length) return;                  // empty payload = retained message deleted
  const msg = JSON.parse(bytes.toString());
  if (topic === "sbb-twin/v1/fleet") console.log(msg.trains.length, "trains at", new Date(msg.ts));
});
```

## Topics

All topics are under `sbb-twin/v1/`. Payloads are UTF-8 JSON with a schema version `v`. Times are **epoch milliseconds
(UTC)**; Swiss local time is `Europe/Zurich`. Coordinates are WGS84 degrees. An **empty retained payload is a
tombstone**: the entity was removed.

| Topic | Retained | QoS | When | Content |
|---|---|---|---|---|
| `status` | yes | 1 | every 10 s | heartbeat: `streamId`, `tick`, trains active, age of the real-time train and alert feeds. No update for 30 s = offline |
| `fleet` | no | 0 | every second | **all trains in one message** (compact rows, see below). Best for maps and detectors |
| `trains/{trainId}/position` | no | 0 | every second | one train: position, speed, motion, delay, stops |
| `trains/{trainId}/info` | yes | 1 | on start, on change, tombstone at the end | line, number, operator, origin/destination, every stop with planned/expected/actual times, status (`active` / `cancelled`) |
| `incidents/{incidentId}` | yes | 1 | on mark, tombstone on unmark | public incidents: marked by staff, or opened and closed by the twin itself (`source: "auto"`): a collision (critical), a train stopped on the open line for 2 min (major), a train 10 min late or more, or 4 min late and losing time (2 min lost within 3 min) (minor, until under 4 min), a cancelled train (minor) |
| `alerts/{alertId}` | yes | 1 | every 3 min when changed, tombstone when withdrawn | **real SBB service alerts that touch the railway** (opentransportdata.swiss GTFS-RT service alerts): title, description, cause, `severity` (`major` = interrupted, `minor` = limited, `info`), active periods, stations, affected `trainIds`, track geometry |
| `bulletins/{id}` | yes | 1 | on revision | latest control-centre bulletin for a scenario, including its version, title and description |
| `forecasts/disruptions` | yes | 1 | when a forecast changes (checked every 5 s) | **live duration forecasts** for every active disruption (real SBB alerts and twin disruptions): `horizons` (P still disrupted at +60/+120/+240 min), the end to show (`median`: announced end + 27.5 min while ahead, else the model median) with its 80 % `band`, the `announced` end, `optimistic` (P still on at the announced end > 0.6), `planned`, `say` (a sentence for the assistant), the model versions and whether each is `real` or `placeholder`. Advice only. Models: [research/duration](research/duration/README.md) |
| `forecasts/post-resumption/{disruptionId}` | yes | 1 | when a disruption resumes (a twin disruption, or a real SBB alert withdrawn), on an official status change, tombstone after the last train | **trains to check after "Service resumed"**: the regular trains due at the section's stations in the next hour, each with its historical risk of still losing a stop (`risk`, `band`: `check first` ≥ 25%, `check` 12-25%, `low` < 12%) and its `officialStatus` (`cancelled` / `skipped` in the effective timetable, else `scheduled`). Advice only: it never changes the timetable or the planner. Model and tests: [research/post_resumption](research/post_resumption/README.md) |
| `events/incident`, `events/train`, `events/system` | no | 0 | on occurrence | `incident.marked` / `incident.unmarked`, `train.cancelled`, `system.started` / `system.timetable` |
| `truth/disruptions/{id}` | yes | 1 | on change | **ground truth**: disruptions we provoked, the trains they affected, geometry |
| `truth/trains/{trainId}` | yes | 1 | while simulated | ground truth: this train is following a provoked behaviour, not the real data |
| `truth/events` | no | 0 | on occurrence | `disruption.started` / `disruption.ended`, `train.collision` (with `impactKmh`), `train.released`, `release.all`, `sync.trains` / `sync.all` |
| `detections/{team}/{id}` | yes (yours) | 1 | yours | **reserved for the detection team**; tombstone when withdrawn |
| `ext/{team}/…` | yours | yours | yours | free namespace for other teams |

> **`truth/` is for evaluation and staff only.** A detector must infer incidents from `fleet`/`position`/`info`;
> reading `truth/` would be cheating. Positions never reveal whether a train is simulated.

**Which topic for what**

| You build | Subscribe to |
|---|---|
| a map of every train, an incident detector | `fleet` (one message per second with every train); `trains/+/info` for timetables |
| a passenger app following one train | `trains/{trainId}/position` and `trains/{trainId}/info` |
| a station screen | `trains/+/info`, keeping the calls with your `stopId` (or `GET /api/stations/{id}/board`) |
| passenger information about incidents | `alerts/+` (real SBB alerts) and `incidents/+` (what staff marked as public) |
| an evaluation of a detector | `truth/disruptions/+`, `truth/trains/+`, `truth/events` against your `detections/{team}/+` |

### `fleet` (every second)

```json
{ "v": 1, "streamId": "0b14f694249a4190", "tick": 188, "ts": 1795286212000,
  "fields": ["trainId","lat","lon","bearing","speedKmh","motion","delaySec","line","category","atStopId","continuity"],
  "trains": [["20261121_ojp-91-8-E.1.TA.716.j26", 47.383806, 8.023723, 60, 128.6, "moving", 0, "IC8", "IC", null, 1], …] }
```

A row's position is valid at `ts`. A train missing from a newer `fleet` message has left service.

### `trains/{trainId}/position` (every second)

```json
{ "v": 1, "streamId": "0b14f694249a4190", "tick": 188, "ts": 1795286212000,
  "trainId": "20261121_ojp-91-8-E.1.TA.716.j26",
  "lat": 47.383806, "lon": 8.023723, "bearing": 60, "speedKmh": 128.6,
  "motion": "moving", "delaySec": 0,
  "line": "IC8", "category": "IC", "headsign": "Romanshorn",
  "atStop": null,
  "prevStop": { "id": "8507000", "name": "Bern" },
  "nextStop": { "id": "8503000", "name": "Zürich HB", "plannedArr": 1795287480000, "expectedArr": 1795287480000 },
  "edgeId": "ch14uvag00087839", "track": "bav", "continuity": 1 }
```

| Field | Meaning |
|---|---|
| `trainId` | `{service date YYYYMMDD}_{GTFS trip_id without its leading dot}`: stable for the whole run, matches GTFS/GTFS-RT |
| `lat`, `lon`, `bearing` | on the track centreline; bearing in degrees clockwise from north |
| `speedKmh` | current speed |
| `motion` | `moving` or `stopped` (observable facts only) |
| `atStop` | the station the train stands at, else `null`. `stopped` with `atStop: null` = stopped on the open line |
| `delaySec` | delay in seconds (+ late) at the next stop: departure delay at intermediate stops, arrival delay at the terminus |
| `edgeId`, `track` | BAV track segment id; `track: "approx"` = no BAV match (mostly abroad or replacement buses): straight line between stops |
| `continuity` | increases when the train jumps (e.g. synced back to the real data): **do not interpolate across a change** |
| `streamId`, `tick` | `streamId` changes when sbb-twin restarts; `tick` increases by one per second within a stream |

**Smooth maps**: render about one second behind and interpolate each train between its last two positions; snap
when `continuity` or `streamId` changes. Speed and bearing allow extrapolating up to one second.

### `trains/{trainId}/info` (retained)

```json
{ "v": 1, "trainId": "20261121_ojp-91-8-E.1.TA.716.j26", "tripId": ".ojp-91-8-E.1.TA.716.j26", "serviceDate": "20261121",
  "line": "IC8", "category": "IC", "number": "10831", "operator": "Schweizerische Bundesbahnen SBB",
  "headsign": "Romanshorn", "status": "active",
  "origin": { "id": "8501609", "name": "Brig" }, "destination": { "id": "8506121", "name": "Romanshorn" },
  "calls": [ { "stopId": "8506109", "name": "Amriswil", "lat": 47.55045, "lon": 9.302225,
               "plannedArr": 1795291560000, "plannedDep": 1795291560000,
               "expectedArr": 1795291540000, "expectedDep": 1795291560000,
               "actualArr": null, "actualDep": null, "skipped": false }, … ],
  "updatedAt": 1795286212390 }
```

`expected*` is set for stops still ahead, `actual*` once the twin has seen the train arrive/leave (from the moment it
started tracking it). `skipped: true` = the train passes without stopping.

### Incidents (`incidents/{id}`)

```json
{ "v": 1, "id": "i-3f2a1b9c", "title": "Overhead line fault: Wädenswil – Pfäffikon SZ", "description": "",
  "severity": "critical", "type": "overhead_line_fault", "reasonCode": "EG_008",
  "scope": { "kind": "section", "from": "8503206", "to": "8503209" }, "where": "Wädenswil – Pfäffikon SZ",
  "geometry": { "type": "MultiLineString", "coordinates": [[[8.675219, 47.229304], …]] },
  "createdAt": 1795286212390, "updatedAt": 1795286212390, "status": "active" }
```

`severity` ∈ `info, minor, major, critical`. `scope.kind` ∈ `section, station, train, line, network`.

## Control (staff, HTTP)

The viewer drives these; scripts can too. Base `http(s)://<host>/api`.

| Request | Effect |
|---|---|
| `GET /disruption-types` · `GET /measure-types` | scenario causes and the measures the control centre can apply |
| `GET /train-actions` | supported actions for an individual train in service |
| `POST /disruptions` `{cause, scope, minutes?, measures?}` | register a station or section disruption using a cause code from `/disruption-types` |
| `POST /disruptions` `{type, scope, minutes?, params?, mark?}` | apply a train action. Set `mark` to `true` to create a public incident |
| `POST /disruptions/{id}/measures` | apply a measure to a scenario |
| `GET /bulletins/{id}` | read the latest bulletin and its earlier versions |
| `POST /disruptions/{id}/end`, `DELETE /disruptions/{id}` | end it (trains resume, still late) / end and forget |
| `POST /incidents` `{title, severity?, description?, scope?}` · `DELETE /incidents/{id}` | mark / unmark |
| `POST /sync` `{trainIds?}` | trains read the real data again (all trains if omitted) |
| `POST /trains/{trainId}/release` | end every change on that train (it moves on, still late until synced) |
| `GET /control/state` | disruptions, incidents, bulletins, resumption forecasts, simulated trains and status |
| `GET /alerts` | the real SBB alerts on the railway right now (as on `alerts/+`) |
| `GET /forecasts` · `GET /forecasts/scorecards` · `GET /forecasts/shadow` · `GET /forecasts/section-risk.geojson` | live forecasts (as on `forecasts/disruptions`, plus the trains to check after a resumption) / the three models' out-of-time scorecards / the live shadow test (each disruption's first prediction, scored when it ends) / the section risk map, each section with its `tier` (`top5`, `top10`, `top20`, `rest`). The console shows them in its Forecasts tab and Risk map; `/forecasts` is the evidence page. `GET /brief` gives each disruption's `forecast` (a real model only) |
| `GET /forecasts/post-resumption?disruptionId=` · `GET /forecasts/post-resumption` | the trains to check after a disruption resumed (as on `forecasts/post-resumption/+`) / every forecast still running. `GET /brief` includes the ones at the stations asked about (`trainsToCheck`) |
| `POST /control/reset` | clear disruptions, incidents and timetable changes, then sync trains with the live data |
| `GET /stations/{id}/board` · `GET /stations/{id}/neighbours` · `GET /stations.geojson` | a station's next departures in the twin (live delays); stations connected by track, nearest first; every station served today |
| `GET /trains`, `GET /trains/{trainId}`, `GET /stations?q=`, `GET /status` | read helpers |

For a train action, send `{"kind":"train","trainId":"…"}` as the scope. A `breakdown` (EG_014) stops the
train and registers a section disruption when the twin can identify its track. The aliases `rolling_stock_failure`
and `emergency_brake` also select `breakdown`. A `cancellation` (EG_063) ends the run at its next stop.

## Run it

```sh
npm ci
npm run dev                      # page + API on :8787 (Vite dev); MQTT on the team broker if MQTT_URL is set,
                                 # else its own broker on ws :8787/mqtt
```

Run `npm test` for regression tests, `npm run typecheck` for the server and viewer types, and `npm run build` to build both viewer pages.

| Variable | Default | |
|---|---|---|
| `OTD_GTFS_RT_KEY` | — | opentransportdata.swiss API key for GTFS-RT (without it trains follow the planned timetable) |
| `OTD_GTFS_SA_KEY` | — | opentransportdata.swiss API key for the GTFS-RT service alerts (real SBB alerts on `alerts/+`) |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | — | publish to this broker (e.g. `mqtt://<team-broker>:1883`) instead of the own one |
| `TOPIC_ROOT` | `sbb-twin/v1` | change it for a test instance so it never overwrites the live twin's topics |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | use `HOST=0.0.0.0` in a container |
| `RAIL_STATE_FILE` | `data/state.json` | where provoked changes are saved across restarts |
| `RAIL_DATA_DIR`, `RAIL_DAYS_DIR` | `data/`, `data/days/` | prepared geometry and one timetable file per service day |

Docker: `docker compose up --build` (see `compose.yaml`; set `OTD_GTFS_RT_KEY` in `.env`). It publishes no port on the host: put a reverse proxy (or a tunnel) in front, which reaches the container on `:8787`.

Data preparation (only to regenerate `data/`): `tools/prepare_network.py` (BAV track graph and the track path of every
station pair), `tools/extract_abroad_rails.mjs` (railways outside Switzerland for the map) and the day timetables
(`day-YYYY-MM-DD.json.gz`) from the official GTFS.

## Data sources

Timetable GTFS, GTFS-RT and GTFS-RT service alerts: [opentransportdata.swiss](https://opentransportdata.swiss) · Rail network: BAV
[Schienennetz](https://data.geo.admin.ch/browser/index.html#/collections/ch.bav.schienennetz) · Base maps:
© swisstopo · Railways outside Switzerland: © OpenStreetMap contributors (ODbL), via OpenFreeMap tiles. Formation
details and occupancy are not modelled.
