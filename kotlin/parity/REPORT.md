| check | status | details |
|---|---|---|
| trains list | exact | 732 trains ts, 732 kt, 732 common |
| train detail + info (14 trains) | differs | 21 values within tolerance (max bearing=0.3, delaySec=1, expectedArr=1e+03, expectedDep=1e+03, metres=9.69); position.speedKmh: ts=35.6 kt=34 |
| geometry/section (5) | exact |  |
| geometry/train (4) | exact |  |
| scenario POST /disruptions (3) | exact |  |
| scenario GET /disruptions | differs | 5 values within tolerance (max announcedAt=790); $[0].impact.tripsCut: ts=62 kt=60; $[0].impact.tripsCut: ts=19 kt=17; $[0].impact.tripsCut: ts=19 kt=17 |
| scenario GET /bulletins | exact |  |
| scenario auto incidents (count) | exact | auto incidents ts=0 kt=0 (not compared one by one); auto incidents ts=0 kt=0 (not compared one by one) |
| scenario GET /incidents (staff + control) | exact |  |
| scenario GET /bulletins/{id} (versions) | exact |  |
| scenario GET /disruptions/{id} | differs | 5 values within tolerance (max announcedAt=790); $.impact.tripsCut: ts=62 kt=60; $.impact.tripsCut: ts=19 kt=17; $.impact.tripsCut: ts=19 kt=17 |
| scenario boards (effective timetable) | differs | 15 values within tolerance (max expected=5e+03); 20261122_ojp-91-1-D.1.TA.867.j26.expected: ts=1795331288000 kt=1795331297000; 20261122_ojp-91-1-E.1.TA.1534.j26.expected: ts=1795331710000 kt=1795331721000; 20261122_ojp-91-90.1.TA.1280.j26.expected: ts=1795330988000 kt=1795330995000; 20261122_ojp-91-1-D.1.TA.867.j26.expected: ts=1795331315000 kt=1795331347000; ... 21 more differences; (edge row .TA.1582.j26 only in kt, accepted) |
| scenario GET /situation | differs | 16 values within tolerance (max expected=2e+03, since=1e+03); $.departures[4].expected: ts=1795331711000 kt=1795331725000; $.to.departures[5].expected: ts=1795331288000 kt=1795331303000; $.onTheWay[len]: ts=3 kt=6; $.to.departures[5].line: ts="IC1" kt="S11"; ... 32 more differences |
| scenario GET /brief | differs | 1 values within tolerance (max expected=2e+03); $.departures[4].expected: ts=1795331710000 kt=1795331727000; $.disruptions[0].trainsCut: ts=83 kt=81; $.disruptions[0].trainsCut: ts=20 kt=18; $.disruptions[0].trainsCut: ts=20 kt=18 |
| scenario train info (affected trains) | exact |  |
| scenario POST measure/state/end (replacement_bus) | exact |  |
| scenario POST measure/state/end (hold) | exact |  |
| scenario POST measure/state/end (one_track_open) | exact |  |
| scenario plan (includeWait) | exact |  |
| scenario POST measure/state/end (partial_resumption) | exact |  |
| scenario POST measure/state/end (prognosis) | exact |  |
| scenario POST measure/state/end (/end) | differs | 2 values within tolerance (max announcedAt=790); $.disruption.impact.tripsCut: ts=19 kt=17 |
| scenario POST measure/state/end (/state) | within tolerance | 1 values within tolerance (max announcedAt=778) |
| scenario control/reset | differs | $.synced: ts=20 kt=19 |
| night plan (15 pairs) | differs | 16 values within tolerance (max arrival=1e+03, departure=1e+03, expectedArr=1e+03, expectedDep=1e+03); $.journeys[0].legs[0].delaySec: ts=1 kt=0; $.journeys[0].legs[0].delaySec: ts=0 kt=1; $.alternativesConsidered: ts=8 kt=9; $.journeys[0].legs[len]: ts=2 kt=3; ... 152 more differences |
| night brief | differs | 4 values within tolerance (max arrival=1e+03, departure=1e+03, expectedArr=1e+03, expectedDep=1e+03); $.journeys[0].legs[0].delaySec: ts=0 kt=1 |

## Wädenswil replay (20x, run separately)
exact: /replays, /disruptions, /bulletins, /incidents (control), auto incident counts.
differs (explained): /situation, /brief, /replays/outcome. The JVM starts ~1.4 s after node, i.e. a 28 s virtual offset at 20x,
so expected times and train actuals are shifted by up to ~50 s; one cancelled flag differs for a train at the edge of that offset.
