# sbb-twin

A live digital twin of every Swiss train, published on MQTT.

- **Trains**: every train in service (≈ 900–1,900 depending on the hour), one precise position per second. Positions are
  computed from the official timetable (GTFS) and the official real-time predictions (GTFS-RT delays, cancellations,
  skipped stops), along the **real track geometry** of the federal rail network (BAV), with realistic acceleration and braking.
- **Weather**: live MeteoSwiss measurements at ~470 stations (temperature, precipitation, wind speed and direction,
  gusts, humidity, dew point, pressure, sunshine, radiation, foehn, snow), a **temperature map** of Switzerland corrected
  for altitude and a **precipitation map** (rain or snow).
- **Control** (our team): change the world and watch it react. Provoke network disruptions (closures, speed
  restrictions, signal failures, station closures), drive or stop any single train (target speed, service or emergency
  braking, obstacles and collisions), change the weather over an area (heatwaves, cold snaps, storms, heavy rain: the
  railway reacts with speed restrictions and closures), switch train protection off (rear-end collisions become
  possible), mark/unmark incidents, and **sync** trains back to the real data.

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
| Team broker through sbb-twin, MQTT over WebSocket | `wss://<public-host>/mqtt` (the page's *Connect* tab shows it) | none: a **read-only** proxy limited to `sbb-twin/v1/#` |
| Own broker (no `MQTT_URL`) | `mqtt://127.0.0.1:1883` and `ws://127.0.0.1:8787/mqtt` | none (anonymous, read-only) |

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
| `status` | yes | 1 | every 10 s | heartbeat: `streamId`, `tick`, trains active, age of the real-time data, weather age. No update for 30 s = offline |
| `fleet` | no | 0 | every second | **all trains in one message** (compact rows, see below). Best for maps and detectors |
| `trains/{trainId}/position` | no | 0 | every second | one train: position, speed, motion, delay, stops |
| `trains/{trainId}/info` | yes | 1 | on start, on change, tombstone at the end | line, number, operator, origin/destination, every stop with planned/expected/actual times, status (`active` / `cancelled`) |
| `incidents/{incidentId}` | yes | 1 | on mark, tombstone on unmark | incidents marked by staff (public flags), with geometry |
| `alerts/{alertId}` | yes | 1 | every 3 min when changed, tombstone when withdrawn | **real SBB service alerts that touch the railway** (opentransportdata.swiss GTFS-RT service alerts): title, description, cause, `severity` (`major` = interrupted, `minor` = limited, `info`), active periods, stations, affected `trainIds`, track geometry |
| `events/incident`, `events/train`, `events/system` | no | 0 | on occurrence | `incident.marked` / `incident.unmarked`, `train.cancelled`, `system.started` / `system.timetable` |
| `weather/stations/{stationId}` | yes | 1 | every 10 min | one MeteoSwiss station |
| `weather/snapshot` | yes | 1 | every 10 min | all stations in one message |
| `weather/temperature-grid` | yes | 1 | every 10 min | **temperature map** (grid, see below) |
| `truth/disruptions/{id}` | yes | 1 | on change | **ground truth**: disruptions we provoked, the trains they affected, geometry |
| `truth/trains/{trainId}` | yes | 1 | while simulated | ground truth: this train is following a provoked behaviour, not the real data |
| `weather/precipitation-grid` | yes | 1 | every 10 min | **precipitation map** (mm per 10 min, same grid as the temperature map); snow where the temperature map is ≤ 1 °C, rain above |
| `truth/weather/{id}` | yes | 1 | on change | ground truth: weather changed from Control (area, values, `phase` rain/snow, consequences) |
| `truth/settings` | yes | 1 | on change | ground truth: Control switches (`protection`) |
| `truth/events` | no | 0 | on occurrence | `disruption.started` / `disruption.ended`, `train.collision` (with `impactKmh`), `weather.override`, `train.released`, `release.all`, `protection.on` / `protection.off`, `sync.trains` / `sync.all` |
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
| weather at a train or a station | `weather/temperature-grid` and `weather/precipitation-grid` (lookup below), `weather/stations/{id}` |
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

### Weather and the temperature map

`weather/temperature-grid`:

```json
{ "v": 1, "ts": 1795285800000, "measuredAt": 1795285200000, "unit": "°C",
  "method": "inverse-distance weighting of MeteoSwiss stations (plus Open-Meteo model values outside Switzerland), corrected for altitude (6.5 °C/km, terrain model)",
  "bbox": [5.4, 45.55, 11.0, 48.05], "step": 0.0125, "cols": 449, "rows": 201,
  "order": "row-major from north-west",
  "values": [7.1, 7.0, 6.9, …] }
```

Cell `(row, col)` is centred on `lon = bbox[0] + col·step`, `lat = bbox[3] − row·step` (≈ 0.95 km × 1.4 km).
Each value is the expected air temperature **at the ground height of that cell**: valleys warm, mountains cold.
It covers Switzerland and its surroundings (the viewer's map bounds); outside Switzerland it relies on Open-Meteo model values.

**Temperature at a train's position** (bilinear interpolation):

```python
def temperature_at(grid, lon, lat):
    w, s, e, n = grid["bbox"]; step, cols = grid["step"], grid["cols"]
    x, y = (lon - w) / step, (n - lat) / step
    c0, r0 = int(x), int(y)
    if not (0 <= c0 < cols - 1 and 0 <= r0 < grid["rows"] - 1): return None
    v = lambda c, r: grid["values"][r * cols + c]
    q = [v(c0, r0), v(c0 + 1, r0), v(c0, r0 + 1), v(c0 + 1, r0 + 1)]
    if None in q: return next((t for t in q if t is not None), None)
    fx, fy = x - c0, y - r0
    return (q[0] * (1 - fx) + q[1] * fx) * (1 - fy) + (q[2] * (1 - fx) + q[3] * fx) * fy
```

```js
function temperatureAt(g, lon, lat) {
  const x = (lon - g.bbox[0]) / g.step, y = (g.bbox[3] - lat) / g.step;
  const c0 = Math.floor(x), r0 = Math.floor(y);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= g.cols || r0 + 1 >= g.rows) return null;
  const v = (c, r) => g.values[r * g.cols + c];
  const q = [v(c0, r0), v(c0 + 1, r0), v(c0, r0 + 1), v(c0 + 1, r0 + 1)];
  if (q.includes(null)) return q.find((t) => t !== null) ?? null;
  const fx = x - c0, fy = y - r0;
  return (q[0] * (1 - fx) + q[1] * fx) * (1 - fy) + (q[2] * (1 - fx) + q[3] * fx) * fy;
}
```

`weather/snapshot` (also `weather/stations/{id}` one by one): `fields` = `id, name, lat, lon, altitudeM, tempC, precipMm,
windKmh, gustKmh, humidityPct, dewPointC, pressureHpa, sunshineMin, radiationWm2, foehn, snowCm, newSnowCm, windDirDeg,
measuredAt`; `windDirDeg` is where the wind comes from, in degrees clockwise from north (meteorological convention);
`units` gives each unit as MeteoSwiss publishes it. 10-minute values (precipitation and sunshine per 10 minutes), snow
daily. `null` = not measured at that station. Weather changed from Control is published here like real weather.

Rain and snow are real: precipitation measured every 10 minutes at ~290 stations, interpolated into
`weather/precipitation-grid` (25 km reach). A cell is snow when the temperature map's cell is ≤ 1 °C, so one storm rains in
the valleys and snows higher up. To read it at a train, use the same lookup as for the temperature.

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
| `GET /disruption-types` | the provokable types (below) |
| `POST /disruptions` `{type, scope, minutes?, params?, mark?}` | provoke; `mark: true` also marks a public incident |
| `POST /disruptions/{id}/end`, `DELETE /disruptions/{id}` | end it (trains resume, still late) / end and forget |
| `POST /incidents` `{title, severity?, description?, scope?}` · `DELETE /incidents/{id}` | mark / unmark |
| `POST /sync` `{trainIds?}` | trains read the real data again (all trains if omitted) |
| `POST /trains/{trainId}/release` | end every change on that train (it moves on, still late until synced) |
| `POST /weather/overrides` `{lat, lon, radiusKm, minutes?, preset? \| tempC? \| tempDeltaC?, minTempC?, precipMm?, windKmh?, gustKmh?}` · `POST /weather/overrides/{id}/end` | change the weather over an area (presets: `heatwave`, `cold`, `storm`, `rain`, `snow`, `blizzard`; `minTempC` keeps the area at least that warm) |
| `POST /control/protection` `{on}` · `GET /control` | train protection switch; current Control state (switches, weather presets, weather changes) |
| `GET /control/state` | everything provoked, marked or switched, in one answer (the same state the control page receives on `/live`) |
| `GET /alerts` | the real SBB alerts on the railway right now (as on `alerts/+`) |
| `POST /control/reset` | **Sync all**: back to reality. Deletes every disruption, weather change and marked incident, switches train protection back on, and snaps every train back to the real data |
| `GET /stations/{id}/board` · `GET /stations/{id}/neighbours` · `GET /stations.geojson` | a station's next departures in the twin (live delays); stations connected by track, nearest first; every station served today |
| `GET /trains`, `GET /trains/{trainId}`, `GET /stations?q=`, `GET /weather`, `GET /status` | read helpers |

| Type | SBB reason | Scope | What trains do |
|---|---|---|---|
| `overhead_line_fault`, `power_failure`, `person_accident`, `obstacle_on_track` | EG_008, EG_011, EG_047, EG_100 | section `{kind:"section",from,to}` | section closed both ways: trains wait at the station before it; a train already inside brakes and stops on the line |
| `track_damage` | EG_006 | section, `params.maxKmh` | speed restriction on the section |
| `signal_box_failure` | EG_010 | station, `params.maxKmh`, `params.holdMinutes` | slow running around the station and a hold at it |
| `station_fire` | EG_110 | station | station closed: trains pass without stopping |
| `rolling_stock_failure` | EG_014 | train `{kind:"train",trainId}` | the train brakes (0.7 m/s²) and stays; followers stop behind it |
| `emergency_brake` | EG_014 | train | the same with emergency braking (1.2 m/s²) |
| `obstacle_collision` | EG_100 | train, `params.distanceM` | an obstacle that far ahead: emergency braking; without enough distance the train hits it at the remaining speed and is immobilised |
| `target_speed` | — | train, `params.kmh` | the train accelerates/brakes to that speed and cruises (still stops at its stations, never leaves early; capped by category) |
| `technical_delay` | EG_014 | train, `params.holdMinutes` | waits that long at its next stop |
| `train_speed_limit` | — | train, `params.maxKmh` | the train runs at most at that speed |
| `skip_next_stop` | — | train | passes its next stop |
| `cancellation` | EG_063 | train | ends its run at the next stop and leaves service |

A provoked train keeps its own behaviour (it stays late) after the disruption ends, until it is **synced**.

**Weather consequences** (automatic, inside the changed area, official SBB reason codes): ≥ 35 °C → *Heat: track
buckling risk* (80 km/h, EG_006); ≤ −15 °C → *Frost: icing* (60 km/h, EG_016); gusts ≥ 100 km/h → *Storm: lines closed*
(EG_101); gusts ≥ 75 km/h → 60 km/h; snow (precipitation where ≤ 1 °C) → *Snow on the tracks* (60 km/h, EG_023), heavy
snow → 40 km/h and *Avalanche risk: mountain lines closed* for track above 1,100 m (EG_022); heavy rain (≥ 4 mm/10 min,
i.e. 24 mm/h, above 1 °C) → *Landslide risk* (40 km/h, EG_018). Storms and heavy rain also cool the air (cold front) but keep it above
3 °C, so they rain even on a cold night; the snowfall presets set sub-zero temperatures. Rain or snow is decided once,
when the change is placed (`phase`). The consequences end with the weather change, and the trains they held go back to
their real timetable on their own.

**Train protection** is part of the real Swiss railway (ETCS, ZUB/Integra-Signum) and is on by default: like ETCS, a
train's movement authority ends behind the train ahead on its track, and it brakes on its service curve (0.7 m/s²) to
stay behind it, so delays spread to the trains behind. Switched off, a
driver only sees a stopped train 500 m ahead and emergency-brakes; without enough distance it is a **rear-end
collision** at the remaining speed (a `train.collision` event, both trains immobilised until released).

## Run it

```sh
npm install
npm run dev                      # page + API on :8787 (Vite dev); MQTT on the team broker if MQTT_URL is set,
                                 # else its own broker on tcp :1883 and ws :8787/mqtt
```

| Variable | Default | |
|---|---|---|
| `OTD_GTFS_RT_KEY` | — | opentransportdata.swiss API key for GTFS-RT (without it trains follow the planned timetable) |
| `OTD_GTFS_SA_KEY` | — | opentransportdata.swiss API key for the GTFS-RT service alerts (real SBB alerts on `alerts/+`) |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | — | publish to this broker (e.g. `mqtt://<team-broker>:1883`) instead of the own one |
| `TOPIC_ROOT` | `sbb-twin/v1` | change it for a test instance so it never overwrites the live twin's topics |
| `PORT`, `MQTT_PORT`, `HOST` | `8787`, `1883`, `127.0.0.1` | use `HOST=0.0.0.0` in a container |
| `RAIL_STATE_FILE` | `data/state.json` | where provoked changes are saved across restarts |
| `RAIL_DATA_DIR`, `RAIL_DAYS_DIR` | `data/`, `data/days/` | prepared geometry and one timetable file per service day |

Docker: `docker compose up --build` (see `compose.yaml`; set `OTD_GTFS_RT_KEY` in `.env`).

Data preparation (only to regenerate `data/`): `tools/prepare_network.py` (BAV track graph and the track path of every
station pair), `tools/extract_abroad_rails.mjs` (railways outside Switzerland for the map) and the day timetables
(`day-YYYY-MM-DD.json.gz`) from the official GTFS.

## Data sources

Timetable GTFS, GTFS-RT and GTFS-RT service alerts: [opentransportdata.swiss](https://opentransportdata.swiss) · Rail network: BAV
[Schienennetz](https://data.geo.admin.ch/browser/index.html#/collections/ch.bav.schienennetz) · Weather: MeteoSwiss
SwissMetNet open data via data.geo.admin.ch, Open-Meteo outside Switzerland · Terrain: Terrarium elevation tiles (AWS Open Data) · Base maps:
© swisstopo · Railways outside Switzerland: © OpenStreetMap contributors (ODbL), via OpenFreeMap tiles. Formation
details and occupancy are not modelled.
