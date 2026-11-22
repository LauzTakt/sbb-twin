# Independent GTFS extraction for the verification oracle (Gate B/C/D/E).
# Reads the national GTFS ZIP directly (never the twin's day files or code) and writes, per service date,
# the dated trips with their original calls (quay, stop_sequence, arrival/departure seconds, pickup/drop-off),
# the stops (quay -> parent, DiDok), and the transfers.txt rules that touch the kept stops/trips.
#
# Kept: every rail trip (route_type 2, 100-117) and every EV trip (route_desc "EV") nationwide, plus all other
# modes for calls inside the regional boxes (regions.py). One streaming pass over stop_times.txt.
#
#   /opt/venv/bin/python verify/gtfs_extract.py 20261121 20261122 20261123
import io, os, pickle, subprocess, sys, time
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from regions import REGIONS, in_any_region  # noqa: E402

ZIP = os.environ.get("GTFS_ZIP", "/workspace/sbb/gtfs/gtfs_fp2026_20261118.zip")
OUT = os.path.join(HERE, ".cache")


def lines(member):
    p = subprocess.Popen(["unzip", "-p", ZIP, member], stdout=subprocess.PIPE, bufsize=1 << 20)
    f = io.TextIOWrapper(p.stdout, encoding="utf-8-sig", newline="")
    header = next(f).rstrip("\r\n")
    yield [h.strip('"') for h in header.split(",")]
    for ln in f:
        ln = ln.rstrip("\r\n")
        if not ln:
            continue
        # every field is quoted in this feed; '","' never occurs inside a field
        yield ln[1:-1].split('","') if ln[0] == '"' else ln.split(",")
    p.wait()


def secs(t):
    if not t:
        return None
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def is_rail_or_ev(rtype, rdesc):
    return rtype == 2 or 100 <= rtype <= 117 or rdesc == "EV"


def main(dates):
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    ds = [date(int(d[:4]), int(d[4:6]), int(d[6:])) for d in dates]
    # calendar
    it = lines("calendar.txt"); h = next(it)
    cal = {}
    for r in it:
        cal[r[0]] = r
    active = {d: set() for d in dates}
    for sid, r in cal.items():
        for d, dd in zip(dates, ds):
            if r[8] <= d <= r[9] and r[1 + dd.weekday()] == "1":
                active[d].add(sid)
    it = lines("calendar_dates.txt"); h = next(it)
    want = set(dates)
    for r in it:
        if r[1] in want:
            if r[2] == "1":
                active[r[1]].add(r[0])
            elif r[2] == "2":
                active[r[1]].discard(r[0])
    print({d: len(v) for d, v in active.items()}, f"{time.time()-t0:.0f}s", flush=True)
    # routes
    it = lines("routes.txt"); h = next(it)
    routes = {}
    for r in it:
        routes[r[0]] = dict(agency=r[1], short=r[2], long=r[3], desc=r[4], type=int(r[5] or 0))
    agencies = {}
    it = lines("agency.txt"); next(it)
    for r in it:
        agencies[r[0]] = r[1]
    # trips
    it = lines("trips.txt"); h = next(it)
    trips = {}
    for r in it:
        sid = r[1]
        days = [d for d in dates if sid in active[d]]
        if not days:
            continue
        ro = routes.get(r[0])
        if not ro:
            continue
        trips[r[2]] = dict(route=r[0], service=sid, headsign=r[3], short=r[4], direction=r[5], block=r[6],
                           original=r[7], hints=r[8] if len(r) > 8 else "", days=days,
                           rtype=ro["type"], line=ro["short"], desc=ro["desc"], agency=agencies.get(ro["agency"], ro["agency"]),
                           railev=is_rail_or_ev(ro["type"], ro["desc"]))
    print("trips active", len(trips), "rail/EV", sum(t["railev"] for t in trips.values()), f"{time.time()-t0:.0f}s", flush=True)
    # stops
    it = lines("stops.txt"); h = next(it)
    stops = {}
    for r in it:
        stops[r[0]] = dict(name=r[1], lat=float(r[2] or 0), lon=float(r[3] or 0), lt=r[4], parent=r[5], platform=r[6], didok=r[8] if len(r) > 8 else "")
    region_stop = {s for s, v in stops.items() if in_any_region(v["lat"], v["lon"])}
    print("stops", len(stops), "in regions", len(region_stop), flush=True)
    # frequencies (headway-based trips: all exact_times=0 in this feed -> estimates only, excluded from exact routing)
    it = lines("frequencies.txt"); next(it)
    freq = {}
    for r in it:
        if r[0] in trips:
            freq.setdefault(r[0], []).append((secs(r[1]), secs(r[2]), int(r[3]), r[4]))
    # stop_times: one pass
    calls = {}
    n = 0
    it = lines("stop_times.txt"); h = next(it)
    for r in it:
        n += 1
        t = trips.get(r[0])
        if t is None:
            continue
        if not t["railev"] and r[3] not in region_stop:
            continue
        lst = calls.get(r[0])
        if lst is None:
            lst = calls[r[0]] = []
        lst.append((int(r[4]), r[3], secs(r[1]), secs(r[2]), int(r[5] or 0), int(r[6] or 0)))
        if n % 10_000_000 == 0:
            print(f"  stop_times {n/1e6:.0f}M rows, kept trips {len(calls)}  {time.time()-t0:.0f}s", flush=True)
    for v in calls.values():
        v.sort()
    print("stop_times rows", n, "kept trips", len(calls), f"{time.time()-t0:.0f}s", flush=True)
    used = set()
    for v in calls.values():
        for c in v:
            used.add(c[1])
    keep_stops = {}
    for s in used:
        keep_stops[s] = stops[s]
        p = stops[s]["parent"]
        if p and p in stops:
            keep_stops[p] = stops[p]
    # all children of used parents too (transfer rules and footpaths name them)
    parents = {v["parent"] for v in keep_stops.values() if v["parent"]}
    for s, v in stops.items():
        if v["parent"] in parents:
            keep_stops[s] = v
    # transfers
    it = lines("transfers.txt"); h = next(it)
    tr = []
    all_active = set().union(*active.values())
    for r in it:
        fs, ts, fr, tor, ft, tt, ty, mt = r[:8]
        sid = r[8] if len(r) > 8 else ""
        if sid and sid not in all_active:
            continue
        if ft and ft not in calls:
            continue
        if tt and tt not in calls:
            continue
        if fs and fs not in keep_stops:
            continue
        if ts and ts not in keep_stops:
            continue
        tr.append((fs, ts, fr, tor, ft, tt, int(ty or 0), int(mt) if mt else None, sid))
    print("transfers kept", len(tr), f"{time.time()-t0:.0f}s", flush=True)
    kept_trips = {k: v for k, v in trips.items() if k in calls}
    feed = {}
    it = lines("feed_info.txt"); fh = next(it)
    for r in it:
        feed = dict(zip(fh, r))
    out = dict(dates=dates, active={d: sorted(v) for d, v in active.items()}, trips=kept_trips, calls=calls, stops=keep_stops,
               transfers=tr, freq=freq, feed=feed, regions=REGIONS, zip=ZIP)
    fn = os.path.join(OUT, f"gtfs-{'-'.join(dates)}.pkl")
    with open(fn, "wb") as f:
        pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
    print("wrote", fn, os.path.getsize(fn) // 1_000_000, "MB", f"{time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or ["20261121", "20261122", "20261123"])
