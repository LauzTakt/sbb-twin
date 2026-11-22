# Independent projection of twin measures onto the oracle's timetable, from the disruption record only
# (GET /api/disruptions/{id}) and the documented contract (lauzhack-org/TWIN_API_NOTES.md), never the twin's
# scenario or planner code.
#
#   closure: section stations S = a + inside + b (DiDok). A ride over consecutive calls x -> y with x, y in S
#            (x != y) uses the section. Interval [start, end); end = until (UNTIL), a lower bound (UNTIL_AT_LEAST:
#            conditional crossings after it), or none (UNKNOWN).
#   entry:   the first call in S whose next call is also in S. A train that left its entry before `start` is
#            already past and continues. A train due to leave its entry in [start, end):
#              short_turn (side matches, active) and wait > 20 min (or no known end) -> cut: it ends at the entry.
#              otherwise                                                           -> hold: leaves the entry at
#              `end`, every later time shifts by the same amount.
#   buses:   replacement_bus -> EV trips both ways over busRoute, first at ceil(at+firstInMin) then every everyMin (or
#            minutesA/minutesB past the hour) until the expected end (2 h rolling when unknown); hop time
#            = max(60 s, 1.3 x straight-line km / 50 km/h), +60 s at each intermediate stop.
#   classes: "confirmed" never crosses at/after a lower-bound/unknown reopening; "conditional" may.
import gzip, json, math, os

WAIT_SHORT_TURN = 20 * 60
BIG = 4e9
# Physical paths (Astra gate B input): the twin's published BAV station-pair paths and track edges. Data only.
TWIN_DATA = os.environ.get("TWIN_DATA", "/workspace/rail-twin/data")
_PHYS = {}


def physical():
    if not _PHYS:
        net = json.load(gzip.open(os.path.join(TWIN_DATA, "network.json.gz")))
        paths = json.load(gzip.open(os.path.join(TWIN_DATA, "paths.json.gz")))
        idx = {}
        for i, e in enumerate(net["edges"]):
            c = e[5]
            a, b = (round(c[0], 5), round(c[1], 5)), (round(c[-2], 5), round(c[-1], 5))
            idx.setdefault((a, b), set()).add(i)
            idx.setdefault((b, a), set()).add(i)
        _PHYS.update(idx=idx, paths={k: {abs(x) - 1 for x in v[2]} for k, v in paths.items()},
                     ends={i: (net["nodes"][e[1]][0], net["nodes"][e[2]][0]) for i, e in enumerate(net["edges"])})
    return _PHYS


def closed_edges(rec):
    """Track edges of the record's geometry (MultiLineString) -> BAV edge indices."""
    ph = physical()
    out, miss = set(), 0
    g = rec.get("geometry") or {}
    lines = g.get("coordinates") or []
    if g.get("type") == "LineString":
        lines = [lines]
    for line in lines:
        k = ((round(line[0][0], 5), round(line[0][1], 5)), (round(line[-1][0], 5), round(line[-1][1], 5)))
        hit = ph["idx"].get(k)
        if hit:
            out |= hit
        else:
            miss += 1
    return out, miss


def hav_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def section_of(rec):
    s = rec["section"]
    ids = [s["a"]["id"]] + [x["id"] for x in s.get("inside", [])] + [s["b"]["id"]]
    return [str(x) for x in ids]


def interval(rec, klass="confirmed"):
    start = (rec.get("start") or rec.get("startedAt")) / 1000
    until = rec.get("until") or rec.get("expectedEnd")
    dt = rec.get("durationType")
    if rec.get("endedAt"):
        end = rec["endedAt"] / 1000
    elif dt == "UNKNOWN" or until is None:
        end = BIG
    elif dt == "UNTIL_AT_LEAST" and klass == "confirmed":
        end = BIG  # a lower bound supplies no confirmed crossing
    else:
        end = until / 1000
    return start, end


def active_measures(rec, typ):
    out = []
    for m in rec.get("measures", []):
        if m.get("type") != typ:
            continue
        if (m.get("status") or m.get("state")) == "withdrawn" and not m.get("withdrawAt"):
            continue
        out.append(m)
    return out


def hop_crosser(rec):
    """f(x_didok, y_didok) -> True when the physical path x>y occupies the record's closed track (same rule as
    project(): an interior closed edge, or the closed edges at both boundaries)."""
    S = section_of(rec)
    a_id, b_id = S[0], S[-1]
    closed, _ = closed_edges(rec)
    ph = physical()
    interior = {e for e in closed if a_id not in ph["ends"].get(e, ()) and b_id not in ph["ends"].get(e, ())}
    inc_a = {e for e in closed if a_id in ph["ends"].get(e, ())}
    inc_b = {e for e in closed if b_id in ph["ends"].get(e, ())}
    Sset = set(S)

    def f(x, y):
        e = ph["paths"].get(f"{x}>{y}") or ph["paths"].get(f"{y}>{x}")
        if e is None or not closed:
            return x in Sset and y in Sset and x != y
        return bool(e & interior) or (bool(e & inc_a) and bool(e & inc_b))
    return f


def project(net, rec, klass="confirmed", decided=None):
    """-> dict(cuts={occ: k}, holds={occ: (k, new_dep)}, closures=[...], info).
    A ride hop x -> y occupies the closure when the physical path x>y shares a track edge with the record's
    geometry (non-stop expresses included); a pair without a physical path counts when x or y is a section
    station (conservative). decided: when the measure was decided (trains that entered before continue)."""
    S = section_of(rec)
    Sset = set(S)
    a_id, b_id = S[0], S[-1]
    start, end = interval(rec, klass)
    decided = decided if decided is not None else (rec.get("startedAt") or 0) / 1000
    closed, miss = closed_edges(rec)
    ph = physical()
    # station-throat edges at a boundary station are shared with other lines (Spiez junction -> Spiez carries the
    # Simmental line too): a hop occupies the closure through an interior edge, or through the whole closed set
    # when every closed edge touches a boundary station
    interior = {e for e in closed if a_id not in ph["ends"].get(e, ()) and b_id not in ph["ends"].get(e, ())}
    inc_a = {e for e in closed if a_id in ph["ends"].get(e, ())}
    inc_b = {e for e in closed if b_id in ph["ends"].get(e, ())}
    st = active_measures(rec, "short_turn")
    cuts, holds, info = {}, {}, {}
    cache = {}
    unresolved = set()

    def hop_crosses(x, y):
        k = (x, y)
        r = cache.get(k)
        if r is None:
            e = ph["paths"].get(f"{x}>{y}")
            if e is None:
                e2 = ph["paths"].get(f"{y}>{x}")
                e = e2
            if e is None:
                r = (x in Sset or y in Sset) and x != y
                if r:
                    unresolved.add(k)
            elif not closed:
                r = x in Sset and y in Sset and x != y
            else:
                # through an interior closed edge, or through the closed edges at both boundaries (end to end)
                r = bool(e & interior) or (bool(e & inc_a) and bool(e & inc_b))
            cache[k] = r
        return r

    for o, (tid, d) in enumerate(net.occ):
        q = net.quay[o]
        ids = [net.didok.get(x) for x in q]
        n = len(q)
        k_in = None
        for k in range(n - 1):
            if ids[k] != ids[k + 1] and hop_crosses(ids[k], ids[k + 1]):
                k_in = k
                break
        if k_in is None:
            continue
        k_out = k_in + 1
        while k_out < n - 1 and ids[k_out] != ids[k_out + 1] and hop_crosses(ids[k_out], ids[k_out + 1]):
            k_out += 1
        t_in, t_out = net.dep[o][k_in], net.arr[o][k_out]
        if t_in < decided or t_in >= end or t_out <= start:
            continue  # already past when decided, after the reopening, or clear before the closure
        wait = end - t_in
        x = ids[k_in]
        if x == a_id:
            side = "A"
        elif x == b_id:
            side = "B"
        else:
            la, lb = net.stops.get(next((s_ for s_ in net.stops if net.didok.get(s_) == a_id), ""), {}), None
            side = "A"
        turn = False
        for m in st:
            at = (m.get("effectiveAt") or m.get("at") or 0) / 1000
            sides = (m.get("params") or {}).get("at", "both")
            if at <= max(t_in, decided) and (sides == "both" or sides == side) and (wait > WAIT_SHORT_TURN or end >= BIG):
                turn = True
        if turn or end >= BIG:
            cuts[(tid, d)] = k_in
            info[(tid, d)] = ("cut", x, t_in)
        else:
            holds[(tid, d)] = (k_in, end)
            info[(tid, d)] = ("hold", x, t_in, end)
    label = f"{rec['section']['a']['name']} - {rec['section']['b']['name']}"
    return dict(cuts=cuts, holds=holds, info=info, closures=[(closed, start, end, label)], start=start, end=end, klass=klass,
                closedEdges=len(closed), geometryUnmatched=miss, unresolvedPairs=sorted(unresolved))


def bus_trips(rec, coords, generic_stop, date, horizon_end=None):
    """Replacement buses from the record (busRoute, measure params/times) and the documented timing model.
    coords: didok -> (lat, lon) as published by the twin (/api/stations.geojson); generic_stop: didok -> stop id."""
    route = [str(x["id"]) for x in rec.get("busRoute") or []]
    if len(route) < 2:
        return []
    start, end = interval(rec, "conditional")
    out = []
    for m in active_measures(rec, "replacement_bus"):
        p = m.get("params") or {}
        if p.get("blocked") or p.get("sought"):
            continue
        at = (m.get("at") or rec["startedAt"]) / 1000  # calibrated: first = ceil(measure time + firstInMin)
        stop_at = end if end < BIG else at + 2 * 3600
        if m.get("withdrawAt"):
            stop_at = min(stop_at, m["withdrawAt"] / 1000)
        for side, seq in (("A", route), ("B", list(reversed(route)))):
            if p.get("minutesA") or p.get("minutesB"):
                mins = p.get("minutesA" if side == "A" else "minutesB") or []
                deps = []
                h0 = int(at // 3600) * 3600
                for h in range(0, 30):
                    for mm in mins:
                        t = h0 + h * 3600 + int(mm) * 60
                        if at <= t < stop_at:
                            deps.append(t)
            else:
                first = at + float(p.get("firstInMin", 15)) * 60
                first = math.ceil(first / 60) * 60
                every = float(p.get("everyMin", 15)) * 60
                deps, t = [], first
                while t < stop_at:
                    deps.append(int(t))
                    t += every
            for t0 in deps:
                calls, t = [], t0
                for i, sid in enumerate(seq):
                    if i > 0:
                        hop = hav_km(coords[seq[i - 1]], coords[sid]) * 1.3 / 50 * 3600
                        t += max(60, math.ceil(hop / 30) * 30)
                    arr = t
                    dep = t + (60 if 0 < i < len(seq) - 1 else 0)
                    calls.append((i + 1, generic_stop.get(sid), arr, dep, 0, 0))
                    t = dep
                if all(c[1] for c in calls):
                    out.append(dict(id=f"EV-{rec['id']}-{m['id']}-{side}{t0}", date=date, calls=calls))
    return out
