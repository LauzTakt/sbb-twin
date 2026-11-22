"""Passenger-routing sidecar for the twin's day files (data/days/route-YYYY-MM-DD.json.gz).

The day file (day-YYYY-MM-DD.json.gz, built by sbb-assistant/server/sim/timetable.py) collapses quays to DiDok stations
and packs calls as (station, arrival, departure). Passenger routing needs what it drops, from the same GTFS ZIP:

  quays    every quay a call or a published transfer uses: [stop_id, station id (DiDok), platform code]
  calls    per trip_id, aligned with the day file's calls (same order, same stations): [quay, pickup*4+drop_off, stop_sequence]
  pairs    published stop-to-stop minimum transfer times (transfers.txt rows without trips or routes): [from quay, to quay, s]
           between two stations these are the walking links (rail station <-> bus stop, e.g. Interlaken Ost <-> Interlaken
           Ost, Bahnhof); the Swiss default within one stop (no row) is 120 s, applied by the planner
  rules    trip-to-trip rows between trips of this day file: [from trip_id, to trip_id, from quay, to quay, type, s, dates]
           type 1 timed (waits), 2 minimum time, 3 forbidden, 4 stay seated (dated: `dates` lists the service days of the
           from trip on which the row's service_id is active), 5 re-board

Usage: python3 tools/prepare_routing.py [--zip GTFS.zip] [--days data/days] [YYYY-MM-DD ...]   (default: every day file)
"""
import argparse
import csv
import datetime as dt
import gzip
import io
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def rows(z, name):
    return csv.DictReader(io.TextIOWrapper(z.open(name + ".txt"), encoding="utf-8-sig", newline=""))


def selected(z, name, ids, column=0):
    """Rows whose first field is one of `ids` (byte test before decoding: stop_times has ~60M rows)."""
    keys = {('"' + k + '"').encode() for k in ids}
    with z.open(name + ".txt") as stream:
        next(stream)
        for line in stream:
            if line.split(b",", 1)[0] in keys:
                yield next(csv.reader([line.decode("utf-8")]))


def main():
    cli = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cli.add_argument("--zip", default="/workspace/sbb/gtfs/gtfs_fp2026_20261118.zip")
    cli.add_argument("--days", default=str(HERE.parent / "data" / "days"))
    cli.add_argument("dates", nargs="*")
    a = cli.parse_args()
    days_dir = Path(a.days)
    dates = a.dates or sorted(p.name[4:14] for p in days_dir.glob("day-*.json.gz"))
    days = {}
    for d in dates:
        days[d] = json.loads(gzip.open(days_dir / f"day-{d}.json.gz").read())
        print(f"day {d}: {len(days[d]['trips'])} trips", flush=True)
    trip_ids = set()
    for day in days.values():
        for key, *_ in day["trips"]:
            trip_ids.add(key.split("/")[1])

    with zipfile.ZipFile(a.zip) as z:
        feed = next(rows(z, "feed_info"))
        stop = {}
        for r in rows(z, "stops"):
            stop[r["stop_id"]] = (r["didok"] or r["parent_station"] or r["stop_id"], r["platform_code"])
        print(f"stops: {len(stop)}", flush=True)
        calls = {}
        for trip, _arr, _dep, sid, seq, pick, drop in selected(z, "stop_times", trip_ids):
            calls.setdefault(trip, []).append((int(seq), sid, int(pick or 0), int(drop or 0)))
        print(f"stop_times: {len(calls)} trips", flush=True)
        pairs = []
        trip_rules = []
        for r in rows(z, "transfers"):
            if r["from_trip_id"] or r["to_trip_id"]:
                if r["from_trip_id"] in trip_ids and r["to_trip_id"] in trip_ids:
                    trip_rules.append(r)
            elif not r["from_route_id"] and not r["to_route_id"]:
                pairs.append((r["from_stop_id"], r["to_stop_id"], r["transfer_type"], r["min_transfer_time"]))
            else:
                print("route-level transfer rows are not handled:", dict(r), file=sys.stderr)
        print(f"transfers: {len(pairs)} stop pairs, {len(trip_rules)} trip pairs among the day files' trips", flush=True)
        # calendars of the dated rules (type 4 rows carry a service_id)
        services = {r["service_id"] for r in trip_rules if r["service_id"]}
        weekly = {r["service_id"]: r for r in rows(z, "calendar") if r["service_id"] in services}
        exceptions = {}
        for svc, day, kind in selected(z, "calendar_dates", services):
            exceptions[(svc, day)] = kind == "1"

    week = "monday tuesday wednesday thursday friday saturday sunday".split()

    def active(svc, ymd):
        if (svc, ymd) in exceptions:
            return exceptions[(svc, ymd)]
        c = weekly.get(svc)
        if not c or not c["start_date"] <= ymd <= c["end_date"]:
            return False
        return c[week[dt.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:])).weekday()]] == "1"

    for d, day in days.items():
        station_ids = [s[0] for s in day["stops"]]
        known = set(station_ids)
        quays, qidx = [], {}

        def quay(sid):
            k = qidx.get(sid)
            if k is None:
                st, pf = stop.get(sid, (sid, ""))
                k = qidx[sid] = len(quays)
                quays.append([sid, st, pf])
            return k

        out_calls = {}
        bad = 0
        pd_counts = {}
        for key, _cat, _line, _head, flat in day["trips"]:
            tid = key.split("/")[1]
            if tid in out_calls:
                continue
            got = sorted(calls.get(tid, []))
            want = [station_ids[flat[i]] for i in range(0, len(flat), 3)]
            if len(got) != len(want) or any(stop.get(sid, (sid,))[0] != w for (_s, sid, _p, _d), w in zip(got, want)):
                bad += 1
                continue
            packed = []
            for seq, sid, p, dd in got:
                packed += [quay(sid), p * 4 + dd, seq]
                pd_counts[(p, dd)] = pd_counts.get((p, dd), 0) + 1
            out_calls[tid] = packed
        out_pairs = []
        for f, t, typ, sec in pairs:
            sf, st = stop.get(f, (None,))[0], stop.get(t, (None,))[0]
            if sf in known and st in known and typ == "2" and sec:
                out_pairs += [quay(f), quay(t), int(sec)]
            elif sf in known and st in known and typ != "2":
                print("stop-pair row of type", typ, "kept as", f, t, file=sys.stderr)
        day_trips = {key.split("/")[1] for key, *_ in day["trips"]}
        service_days = sorted({key.split("/")[0] for key, *_ in day["trips"]})
        out_rules = []
        for r in trip_rules:
            if r["from_trip_id"] not in day_trips or r["to_trip_id"] not in day_trips:
                continue
            dates = [x for x in service_days if active(r["service_id"], x)] if r["service_id"] else None
            if dates == []:
                continue
            rule = [r["from_trip_id"], r["to_trip_id"], quay(r["from_stop_id"]), quay(r["to_stop_id"]), int(r["transfer_type"]), int(r["min_transfer_time"] or 0)]
            if dates is not None:
                rule.append(dates)
            out_rules.append(rule)
        doc = {"v": 1, "feed": feed["feed_version"], "date": d, "quays": quays, "calls": out_calls, "pairs": out_pairs, "rules": out_rules}
        path = days_dir / f"route-{d}.json.gz"
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", compresslevel=9) as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        tmp.replace(path)
        types = {}
        for r in out_rules:
            types[r[4]] = types.get(r[4], 0) + 1
        print(f"{path.name}: {len(out_calls)} trips ({bad} not aligned), {len(quays)} quays, {len(out_pairs) // 3} stop pairs, rules by type {types}, pickup/drop-off {pd_counts}, {path.stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
