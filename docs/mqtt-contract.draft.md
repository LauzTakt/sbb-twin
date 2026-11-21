# rail-twin MQTT contract (DRAFT v1 for review)

rail-twin is the source of truth for the hackathon team: a live digital twin of every Swiss train.
Positions are computed every second from the official timetable (GTFS) + the official real-time feed
(GTFS-RT delays/cancellations) on the real track geometry (BAV rail network). Our team can deliberately
provoke disruptions in it (trains then diverge from reality), mark/unmark incidents, and "sync" trains
back to reality. Other teams consume it: one builds incident detection from positions only, others build UIs.

Broker: embedded (Aedes) in the rail-twin process. Access: MQTT/TCP 1883 (public via a TCP tunnel) and
MQTT over WebSocket at wss://<public-host>/mqtt. Anonymous read; only rail-twin publishes under rail/v1/
except the namespaces reserved for other teams (below).

## Topics
| Topic | Retain | QoS | Rate | Content |
|---|---|---|---|---|
| rail/v1/status | yes | 1 | 10 s + on change | heartbeat: mode, trains active, RT feed age, version |
| rail/v1/trains/{trainId}/position | yes | 0 | 1 Hz while in service | precise position + motion + delay (below) |
| rail/v1/trains/{trainId}/info | yes | 1 | on start + on change | static/slow data: line, category, number, operator, headsign, calls (planned/expected times, platforms) |
| rail/v1/trains/{trainId} (empty, retained) | — | 1 | on end | clears retained position/info when the train leaves service (consumers delete) |
| rail/v1/snapshot/trains | no | 0 | 1 Hz | compact array of all positions in one message (for map UIs) |
| rail/v1/incidents/{incidentId} | yes | 1 | on change | MARKED incidents (manual flags by staff), public; empty retained payload = unmarked |
| rail/v1/truth/disruptions/{disruptionId} | yes | 1 | on change | PROVOKED disruptions = ground truth of what we injected (for evaluation; detectors must not read it) |
| rail/v1/events/{kind} | no | 1 | on occurrence | kind = disruption | incident | train | sync | system |
| rail/v1/detections/{detectorId}/{incidentId} | yes | 1 | — | RESERVED: written by the detection team |
| rail/v1/ext/{team}/# | any | any | — | RESERVED: free namespace for other teams |

trainId = "{serviceDate YYYYMMDD}_{GTFS trip_id without leading dot}", e.g. 20261121_ojp-91-8-C.1.TA.141.j26 (stable for the day; matches GTFS/GTFS-RT).

## position payload (JSON, UTF-8)
{ "v":1, "trainId":"…", "ts":1795283973000,          // epoch ms the position is valid for (all trains share the tick)
  "lat":47.229304, "lon":8.675219,                  // WGS84, 6 decimals, on the BAV track centreline
  "bearing":112.4, "speedKmh":74.2,
  "state":"running",                                // running | dwelling | held | stopped | cancelled
  "delaySec":120,                                   // vs timetable, at the next stop
  "line":"S8", "category":"S", "headsign":"Effretikon",
  "prevStop":{"id":"8503206","name":"Wädenswil"},
  "nextStop":{"id":"8503207","name":"Richterswil","plannedArr":…, "expectedArr":…},
  "edgeId":"ch14uvag00088260", "track":"bav",       // BAV segment id; track = bav | approx (straight line, unmatched)
  "source":"realtime" }                             // realtime (GTFS+GTFS-RT) | timetable (no RT for it) | simulated (diverged after a provoked disruption)

## Control (HTTP, staff only, documented in the README)
POST /api/disruptions {type, scope, durationMin?, params}  -> provoke (types: section_closure, train_breakdown,
  speed_restriction, station_closure, train_delay, cancellation, signal_failure, …) ; DELETE /api/disruptions/{id} ends it
POST /api/incidents {…} / DELETE /api/incidents/{id}       -> mark / unmark
POST /api/sync {trainIds?}                                   -> trains back to real data (all if omitted)
GET /api/trains, /api/trains/{id}, /api/stations, /api/network.geojson, /api/disruption-types
