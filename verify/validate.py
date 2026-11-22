# Gate C: validate any /api/plan journey against our own GTFS reading (and, optionally, our own projection of
# twin measures). Checks: endpoints (or a published footpath to/from them), the leg's trip runs that day,
# boarding/alighting calls exist at those stations at those times with pickup/drop-off allowed, the served
# call order, monotonic times, the transfer rule between consecutive rides (published minimum, footpath or
# Swiss 120 s default; forbidden/no footpath = invalid), the change count (in-seat continuations excluded),
# departure >= query time, and with measures: no ride over a closed edge during its closure, no boarding of a
# held train before its release, no call after a short turn.
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import hms  # noqa: E402

_NET = {}


def national():
    """Lookup-only network over every rail/EV occurrence (and regional other modes) of the extracted dates."""
    from oracle import Network
    if "nat" not in _NET:
        _NET["nat"] = Network(None, ["20261121", "20261122", "20261123"], modes="all")
    return _NET["nat"]


def trip_candidates(train_id, leg=None):
    """twin trainId '20261122_ojp-91-24-F.1.TA.536.j26' -> GTFS ('.ojp-91-24-F.1.TA.536.j26', '20261122')."""
    out = []
    if leg and leg.get("tripId"):
        out.append((leg["tripId"], leg.get("serviceDate") or (train_id or "")[:8]))
    if train_id and "_" in train_id:
        d, rest = train_id.split("_", 1)
        out += [("." + rest, d), (rest, d)]
    return out


def find_call(net, o, didok, t, kind, tol=0):
    """Index of the call of occurrence o at station didok (or a quay with that DiDok) at time t (arr|dep)."""
    best = None
    for k, q in enumerate(net.quay[o]):
        if net.didok.get(q) != str(didok):
            continue
        tt = net.dep[o][k] if kind == "dep" else net.arr[o][k]
        if abs(tt - t) <= tol:
            return k, None
        if best is None or abs(tt - t) < abs(best[1]):
            best = (k, tt - t)
    return (None, best)


def leg_time(x, planned_key, expected_key, use_expected):
    p, e = x.get(planned_key), x.get(expected_key)
    if use_expected and e is not None and (p is None or abs(e - p) >= 60_000):
        return e // 1000  # a held/shifted train counts at its forecast time (sub-minute engine jitter ignored)
    return (p if p is not None else e) // 1000


def find_bus(net, l, dep, arr, tol=30):
    """A twin bus leg (no GTFS id) matched by station and times (+-30 s: one rounding step of the documented
    model) against the projected bus trips."""
    f, t = l.get("from") or {}, l.get("to") or {}
    for o, (tid, d) in enumerate(net.occ):
        if not str(tid).startswith("EV-"):
            continue
        kd = ka = None
        for k, q in enumerate(net.quay[o]):
            if kd is None and net.didok.get(q) == str(f.get("id")) and abs(net.dep[o][k] - dep) <= tol:
                kd = k
            elif kd is not None and net.didok.get(q) == str(t.get("id")) and abs(net.arr[o][k] - arr) <= tol:
                ka = k
                break
        if kd is not None and ka is not None:
            return o
    return None


def validate(journey, origin, dest, T, net=None, measures=None, reported_changes=None, use_expected=False, fallback=None):
    """journey: dict with legs [{trainId, from:{id, plannedDep}, to:{id, plannedArr}, ...}] as /api/plan returns."""
    net = net or national()
    errs, notes = [], []
    unjudged = []
    rides = []
    legs = journey.get("legs") or []
    for i, l in enumerate(legs):
        f, t = l.get("from") or {}, l.get("to") or {}
        tid = l.get("trainId")
        mode = (l.get("mode") or l.get("category") or "").lower()
        if not tid or mode in ("walk", "foot", "footpath", "transfer"):
            continue  # walk legs are judged through the transfer/access rule below
        dep = leg_time(f, "plannedDep", "expectedDep", use_expected)
        arr = leg_time(t, "plannedArr", "expectedArr", use_expected)
        o = None
        for trip, d in trip_candidates(tid, l):
            o = net.occ_index.get((trip, d))
            if o is not None:
                break
        if o is None and ("EV-" in str(tid) or (l.get("category") == "EV" and use_expected)):
            o = find_bus(net, l, dep, arr)
            if o is not None:
                bk = [k for k, q in enumerate(net.quay[o]) if net.didok.get(q) == str(f.get("id"))]
                ak = [k for k, q in enumerate(net.quay[o]) if net.didok.get(q) == str(t.get("id"))]
                if bk:
                    dep = net.dep[o][bk[0]]
                if ak:
                    arr = net.arr[o][ak[-1]]
            if o is None:
                errs.append(f"leg {i+1} bus {tid} {f.get('name')} {hms(dep, False)} -> {t.get('name')} {hms(arr, False)}: not a bus of the projected measure (timing model or route differs)")
                continue
        if o is None:
            if fallback is not None and any(fallback.occ_index.get(c) is not None for c in trip_candidates(tid, l)):
                unjudged.append(f"leg {i+1} {l.get('line')} leaves the oracle region")
                continue
            errs.append(f"leg {i+1} {l.get('line')} {tid}: trip occurrence not in the published timetable (or not running that day, or cut by a measure)")
            continue
        tol = 59 if use_expected else 0  # engine jitter on forecast times
        if net.region and (str(f.get("id")) not in net.region_didoks() or str(t.get("id")) not in net.region_didoks()):
            unjudged.append(f"leg {i+1} {l.get('line')} leaves the oracle region")
            continue
        kd, near_d = find_call(net, o, f.get("id"), dep, "dep", tol)
        ka, near_a = find_call(net, o, t.get("id"), arr, "arr", tol)
        if kd is not None:
            dep = net.dep[o][kd]
        if ka is not None:
            arr = net.arr[o][ka]
        if kd is None:
            errs.append(f"leg {i+1} {l.get('line')}: no call at {f.get('name')} ({f.get('id')}) departing {hms(dep, False)}" + (f" (nearest {int(near_d[1]):+d}s)" if near_d else " (trip does not call there)"))
            continue
        if ka is None:
            errs.append(f"leg {i+1} {l.get('line')}: no call at {t.get('name')} ({t.get('id')}) arriving {hms(arr, False)}" + (f" (nearest {int(near_a[1]):+d}s)" if near_a else " (trip does not call there)"))
            continue
        if ka <= kd:
            errs.append(f"leg {i+1} {l.get('line')}: alights at or before boarding call (seq {net.seq[o][ka]} <= {net.seq[o][kd]})")
            continue
        if net.pick[o][kd] == 1:
            errs.append(f"leg {i+1} {l.get('line')}: boarding not allowed at {f.get('name')} (pickup_type=1)")
        if net.drop_[o][ka] == 1:
            errs.append(f"leg {i+1} {l.get('line')}: alighting not allowed at {t.get('name')} (drop_off_type=1)")
        if net.pick[o][kd] in (2, 3):
            notes.append(f"leg {i+1}: boarding needs arrangement (pickup_type={net.pick[o][kd]})")
        if measures:
            errs += measures_check(measures, net, o, kd, ka, i, l)
        rides.append(dict(i=i, o=o, kd=kd, ka=ka, dep=dep, arr=arr, line=l.get("line"), qd=net.quay[o][kd], qa=net.quay[o][ka]))
    if unjudged and not errs:
        return dict(valid=True, unjudged=True, errors=[], notes=notes + unjudged)
    if errs:  # a leg that cannot be matched makes the derived checks meaningless
        return dict(valid=False, errors=errs, notes=notes)
    if not rides:
        if not errs:
            errs.append("no ride in the journey")
        return dict(valid=False, errors=errs, notes=notes)
    # monotonic times
    for a, b in zip(rides, rides[1:]):
        if b["dep"] < a["arr"]:
            errs.append(f"leg {b['i']+1} departs {hms(b['dep'], False)} before leg {a['i']+1} arrives {hms(a['arr'], False)}")
    # transfers and in-seat continuations
    changes = 0
    for a, b in zip(rides, rides[1:]):
        if inseat(net, a, b):
            notes.append(f"in-seat continuation {a['line']} -> {b['line']}")
            continue
        changes += 1
        m = net.min_transfer(a["qa"], b["qd"], a["o"], b["o"])
        gap = b["dep"] - a["arr"]
        if m is None:
            errs.append(f"change {a['line']} -> {b['line']} at {net.stops[a['qa']]['name']} -> {net.stops[b['qd']]['name']}: no published footpath or transfer forbidden")
        elif gap < m:
            errs.append(f"change {a['line']} -> {b['line']} at {net.stops[a['qa']]['name']}: {gap}s < required {m}s (quays {a['qa'].split(':')[-1]} -> {b['qd'].split(':')[-1]})")
    rc = journey.get("transfers") if reported_changes is None else reported_changes
    if rc is not None and rc != changes:
        errs.append(f"reported {rc} changes, the rides need {changes}")
    # endpoints and access/egress
    first, last = rides[0], rides[-1]
    acc = net.access(origin, T)
    egr = net.egress(dest)
    if first["qd"] not in acc:
        errs.append(f"first ride boards at {net.stops[first['qd']]['name']} ({net.didok.get(first['qd'])}), not the origin {origin} nor a published footpath from it")
    else:
        w = acc[first["qd"]]
        if first["dep"] - w < T:
            errs.append(f"leaves the origin at {hms(first['dep'] - w, False)} (walk {w}s) before the query time {hms(T, False)}")
        jd = journey.get("departure") if use_expected else (journey.get("plannedDeparture") or journey.get("departure"))
        if jd is not None and jd // 1000 > first["dep"] - w and w:
            notes.append(f"reported departure {hms(jd // 1000, False)} omits the {w}s access walk")
    if last["qa"] not in egr:
        errs.append(f"last ride alights at {net.stops[last['qa']]['name']} ({net.didok.get(last['qa'])}), not the destination {dest} nor a published footpath to it")
    else:
        w = egr[last["qa"]]
        ja = journey.get("arrival") if use_expected else (journey.get("plannedArrival") or journey.get("arrival"))
        if ja is not None and ja // 1000 + (59 if use_expected else 0) < last["arr"] + w:
            errs.append(f"reported arrival {hms(ja // 1000, False)} is before alighting {hms(last['arr'], False)} + egress walk {w}s")
    return dict(valid=not errs, errors=errs, notes=notes, changes=changes,
                cost=(last["arr"] + egr.get(last["qa"], 0), changes, -(first["dep"] - acc.get(first["qd"], 0))))


def inseat(net, a, b):
    tid, d = net.occ[a["o"]]
    tt, d2 = net.occ[b["o"]]
    if a["ka"] != len(net.quay[a["o"]]) - 1:
        return False
    for (fs, ts, to_trip, sid) in net.inseat.get(tid, ()):
        if to_trip == tt and (not sid or sid in net.active.get(d, ())):
            return True
    return False


def measures_check(M, net, o, kd, ka, i, l):
    """M: our projection of twin measures (see measures.py): closures [(edgeset, start, end)], holds, cuts."""
    errs = []
    occ = net.occ[o]
    cut = M.get("cuts", {}).get(occ)
    if cut is not None and ka > cut:
        errs.append(f"leg {i+1} {l.get('line')}: rides past its short-turn terminus ({net.stops[net.quay[o][cut]]['name']})")
    hold = M.get("holds", {}).get(occ)
    if hold is not None:
        k_hold, release = hold
        if kd <= k_hold and ka > k_hold and (l.get("from") or {}).get("expectedDep", 0) // 1000 < release and kd == k_hold:
            errs.append(f"leg {i+1} {l.get('line')}: boards a held train before its release {hms(release, False)}")
    for (stations, start, end, label) in M.get("closures", []):
        for k in range(kd, ka):
            a, b = net.parent.get(net.quay[o][k]), net.parent.get(net.quay[o][k + 1])
            if (a, b) in stations or (b, a) in stations:
                t0, t1 = net.dep[o][k], net.arr[o][k + 1]
                if t0 < end and t1 > start:
                    errs.append(f"leg {i+1} {l.get('line')}: crosses closed {label} {hms(t0, False)}-{hms(t1, False)} (closed {hms(start, False)}-{hms(end, False) if end < 4e9 else 'open end'})")
    return errs


if __name__ == "__main__":
    import json, urllib.parse
    from common import get_json, local_epoch
    base, frm, to, hhmm = sys.argv[1:5]
    T = local_epoch("2026-11-22", hhmm)
    st, body = get_json(f"{base}/api/plan?" + urllib.parse.urlencode({"from": frm, "to": to, "after": T * 1000, "limit": 6}))
    for j in body.get("journeys", []):
        r = validate(j, body["from"]["id"], body["to"]["id"], T)
        print(hms(j["plannedDeparture"] // 1000, False), hms(j["plannedArrival"] // 1000, False), j["transfers"], [l.get("line") for l in j["legs"]], r["valid"], r["errors"], r["notes"])
