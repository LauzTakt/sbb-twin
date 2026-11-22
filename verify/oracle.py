# Gate B: independent exact journey oracle on a time-expanded event graph, built from the GTFS ZIP only.
#
# Nodes are the calls of dated trip occurrences (arrival/departure events at an exact quay). Edges:
#   onboard   (o,k) -> (o,k+1)                         the passenger stays aboard (passing any call)
#   in-seat   last call of o -> call of o2              transfers.txt type 4 for that service day, zero changes
#   transfer  alight (o,k) [drop_off != 1] -> board (o2,j) [pickup != 1]
#             dep(o2,j) >= arr(o,k) + min transfer, the most specific transfers.txt rule (GTFS precedence:
#             both trips > trip+route > one trip > both routes > one route > stop pair; exact quay before
#             station-level stop), type 3 forbidden, type 1 timed (>= 0 s), type 2 min seconds, otherwise the
#             Swiss default 120 s inside one station; stations with different parents only via a published
#             stop-pair rule (footpath, its min_transfer_time is the walk).
#   access    origin station quays (no minimum) or published footpaths from the origin station.
#   egress    destination station quays, or a published footpath into the destination station.
# Search: rounds by number of rides (<= maxTransfers+1); in each round every event keeps the latest origin
# departure that reaches it (event times are fixed, so this is exact). The answer is the lexicographic optimum
# (arrival, changes, -departure) and the (arrival, changes) frontier with latest departure, with a witness.
import bisect, math, os, pickle, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from regions import REGIONS, in_region  # noqa: E402
from common import service_midnight  # noqa: E402

NEG = -math.inf
SWISS_DEFAULT = 120
PKL = os.path.join(HERE, ".cache", "gtfs-20261121-20261122-20261123.pkl")
_DATA = {}


def data(path=PKL):
    if path not in _DATA:
        with open(path, "rb") as f:
            _DATA[path] = pickle.load(f)
    return _DATA[path]


def is_rail(t):
    return t["rtype"] == 2 or 100 <= t["rtype"] <= 117


def is_ev(t):
    return t["desc"] == "EV"


MODES = {
    "railev": lambda t: is_rail(t) or is_ev(t),
    "rail": is_rail,
    "all": lambda t: t["rtype"] not in (715, 1500) and not t.get("freq"),  # no on-demand/taxi, no headway estimates
}


class Network:
    """Dated, regional, mode-filtered timetable with its own transfer-rule matcher."""

    def __init__(self, region, dates, modes="railev", D=None, extra_trips=None, drop=None):
        D = D or data()
        self.D, self.region, self.dates, self.modes = D, region, list(dates), modes
        stops = D["stops"]
        self.stops = stops
        keep_mode = MODES[modes]
        inreg = (lambda s: in_region(region, stops[s]["lat"], stops[s]["lon"])) if region else (lambda s: True)
        self.parent = {s: (v["parent"] or s) for s, v in stops.items()}
        self.didok = {s: v["didok"] for s, v in stops.items()}
        # generic station-level stop ('ch:1:sloid:7483' for quay 'ch:1:sloid:7483:0:341164')
        self.generic = {}
        for s, v in stops.items():
            p = v["parent"]
            if p.startswith("Parent"):
                self.generic[s] = p[len("Parent"):]
        self.by_parent = defaultdict(list)
        for s, v in stops.items():
            if v["lt"] != "1":
                self.by_parent[self.parent[s]].append(s)
        # trip occurrences
        self.occ = []  # (tripId, date)
        self.trip_of = []
        self.quay, self.arr, self.dep, self.pick, self.drop_, self.seq = [], [], [], [], [], []
        drop = drop or set()
        freq = D.get("freq", {})
        for tid, t in D["trips"].items():
            if tid in freq:
                continue  # headway-based (exact_times=0): estimates only, never exact routing
            if not keep_mode(t):
                continue
            cl = D["calls"].get(tid)
            if not cl:
                continue
            for d in self.dates:
                if d not in t["days"] or (tid, d) in drop:
                    continue
                base = service_midnight(d)
                cs = [c for c in cl if c[1] in stops and inreg(c[1])]
                if len(cs) < 2:
                    continue
                self._add(tid, d, [(c[0], c[1], base + (c[2] if c[2] is not None else c[3]), base + (c[3] if c[3] is not None else c[2]), c[4], c[5]) for c in cs])
        for x in extra_trips or []:  # added trips (twin buses): dict(id, date, calls=[(seq, stop, arr_epoch, dep_epoch, pickup, drop)])
            cs = [c for c in x["calls"] if c[1] in stops and (not region or inreg(c[1]))]
            if len(cs) >= 2:
                self._add(x["id"], x.get("date", self.dates[0]), cs)
        self._index()
        self._rules()

    def modified(self, cuts=None, holds=None, extra=None, remove=None):
        """A copy with measures applied: cuts {occ: k_last_served}, holds {occ: (k, new_dep)} (that call departs at
        new_dep and every later time shifts by the same amount), extra trips (dicts as in __init__), removed occs."""
        import copy
        net = copy.copy(self)
        cuts, holds, remove = cuts or {}, holds or {}, set(remove or ())
        net.occ, net.trip_of, net.quay, net.arr, net.dep, net.pick, net.drop_, net.seq = [], [], [], [], [], [], [], []
        net.mod = dict(cuts={}, holds={})
        net._rd = self.region_didoks()
        for o, (tid, d) in enumerate(self.occ):
            if (tid, d) in remove:
                continue
            q, a, de, pu, do, sq = self.quay[o], list(self.arr[o]), list(self.dep[o]), list(self.pick[o]), list(self.drop_[o]), self.seq[o]
            n = len(q)
            if (tid, d) in holds:
                k, nd = holds[(tid, d)]
                delta = nd - de[k]
                if delta > 0:
                    de[k] = nd
                    for j in range(k + 1, n):
                        a[j] += delta
                        de[j] += delta
                    net.mod["holds"][(tid, d)] = (k, nd, delta)
            if (tid, d) in cuts:
                k = cuts[(tid, d)]
                if k < 1:
                    continue
                q, a, de, pu, do, sq = q[:k + 1], a[:k + 1], de[:k + 1], pu[:k + 1], do[:k + 1], sq[:k + 1]
                net.mod["cuts"][(tid, d)] = k
            net._add(tid, d, list(zip(sq, q, a, de, pu, do)))
        for x in extra or []:
            cs = [c for c in x["calls"] if c[1] in self.stops]
            if len(cs) >= 2:
                net._add(x["id"], x.get("date", self.dates[0]), cs)
        net._index()
        return net

    def region_didoks(self):
        if getattr(self, "_rd", None) is None:
            self._rd = {self.didok.get(q) for qs in self.quay for q in qs}
        return self._rd

    def _add(self, tid, d, cs):
        self.occ.append((tid, d))
        self.trip_of.append(tid)
        self.seq.append([c[0] for c in cs])
        self.quay.append([c[1] for c in cs])
        self.arr.append([c[2] for c in cs])
        self.dep.append([c[3] for c in cs])
        self.pick.append([c[4] for c in cs])
        self.drop_.append([c[5] for c in cs])

    def _index(self):
        self.deps_at = defaultdict(list)  # quay -> sorted [(dep, o, k)] boardable
        for o in range(len(self.occ)):
            n = len(self.quay[o])
            for k in range(n - 1):
                if self.pick[o][k] != 1:
                    self.deps_at[self.quay[o][k]].append((self.dep[o][k], o, k))
        for v in self.deps_at.values():
            v.sort()
        self.dep_times = {q: [x[0] for x in v] for q, v in self.deps_at.items()}
        self.occ_index = {oc: i for i, oc in enumerate(self.occ)}

    def _rules(self):
        D = self.D
        trips = D["trips"]
        self.rules = defaultdict(list)  # (from_stop, to_stop) -> rules
        self.inseat = defaultdict(list)  # from_trip -> [(from_stop, to_stop, to_trip, service)]
        self.foot = defaultdict(dict)  # from station parent -> {to station parent: [(from_stop, to_stop, secs)]}
        for (fs, ts, fr, tor, ft, tt, ty, mt, sid) in D["transfers"]:
            if ty == 4:
                self.inseat[ft].append((fs, ts, tt, sid))
                continue
            self.rules[(fs, ts)].append((fr, tor, ft, tt, ty, mt, sid))
            pf, pt = self.parent.get(fs, fs), self.parent.get(ts, ts)
            if pf != pt and ty == 2 and not (fr or tor or ft or tt) and mt is not None:
                self.foot[pf].setdefault(pt, []).append((fs, ts, mt))
        self.route_of = {tid: t["route"] for tid, t in trips.items()}
        self.mod = dict(cuts={}, holds={})
        self._mcache = {}
        self._split = {}
        # per alighting stop: trips/routes named as from_trip/from_route, and service-dated rules (no pruning there)
        self.from_named = defaultdict(set)
        for (fs, ts), lst in self.rules.items():
            for (fr, tor, ft, tt, ty, mt, sid) in lst:
                if ft:
                    self.from_named[fs].add(ft)
                if fr:
                    self.from_named[fs].add("route:" + fr)
                if sid:
                    self.from_named[fs].add("*")
        self.active = {d: set(v) for d, v in D["active"].items()}

    # ---- transfer rule matcher (independent of the planner) ----
    def stop_keys(self, q):
        ks = [(q, 3)]
        g = self.generic.get(q)
        if g and g != q:
            ks.append((g, 2))
        p = self.parent.get(q)
        if p and p != q:
            ks.append((p, 1))
        return ks

    def candidate_rules(self, qa, qd):
        key = (qa, qd)
        r = self._mcache.get(key)
        if r is None:
            r = []
            for fs, sf in self.stop_keys(qa):
                for ts, st in self.stop_keys(qd):
                    for rule in self.rules.get((fs, ts), ()):
                        r.append((sf + st, rule))
            self._mcache[key] = r
        return r

    def min_transfer(self, qa, qd, o_from, o_to):
        """Seconds required (None = forbidden/impossible) to alight o_from at qa and board o_to at qd."""
        key = (qa, qd)
        sp = self._split.get(key)
        if sp is None:
            cands = self.candidate_rules(qa, qd)
            specific = [c for c in cands if any(c[1][:4]) or c[1][6]]
            sp = self._split[key] = (bool(specific), None if specific else self._resolve(qa, qd, cands, o_from, o_to))
        if not sp[0]:
            return sp[1]
        return self._resolve(qa, qd, self.candidate_rules(qa, qd), o_from, o_to)

    def _resolve(self, qa, qd, cands, o_from, o_to):
        tf, tt = self.trip_of[o_from], (self.trip_of[o_to] if o_to is not None else None)
        df = self.occ[o_from][1]
        rf, rt = self.route_of.get(tf), self.route_of.get(tt) if tt else None
        best, best_rank = None, None
        for stop_rank, (fr, tor, ft, ttr, ty, mt, sid) in cands:
            if sid and sid not in self.active.get(df, ()):
                continue
            if ft and ft != tf:
                continue
            if ttr and ttr != tt:
                continue
            if fr and fr != rf:
                continue
            if tor and tor != rt:
                continue
            if ft and ttr:
                spec = 6
            elif (ft and tor) or (fr and ttr):
                spec = 5
            elif ft or ttr:
                spec = 4
            elif fr and tor:
                spec = 3
            elif fr or tor:
                spec = 2
            else:
                spec = 1
            rank = (spec, stop_rank)
            if best_rank is None or rank > best_rank:
                best_rank, best = rank, (ty, mt)
        same_station = self.parent.get(qa) == self.parent.get(qd)
        if best is None:
            return SWISS_DEFAULT if same_station else None
        ty, mt = best
        if ty == 3:
            return None
        if ty == 1:
            return 0
        if ty == 2 and mt is not None:
            return mt
        # type 0/5 (or 2 without seconds): the stop-level time, else the Swiss default
        if same_station:
            return SWISS_DEFAULT
        return None

    def default_min(self, qa, qd):
        """Rule for a plain arrival (no trip/route-specific rule): used for pruning only."""
        best, best_rank = None, None
        for stop_rank, (fr, tor, ft, ttr, ty, mt, sid) in self.candidate_rules(qa, qd):
            if fr or tor or ft or ttr or sid:
                continue
            rank = stop_rank
            if best_rank is None or rank > best_rank:
                best_rank, best = rank, (ty, mt)
        return best

    def has_specific(self, qa, qd):
        for _, (fr, tor, ft, ttr, ty, mt, sid) in self.candidate_rules(qa, qd):
            if fr or tor or ft or ttr or sid:
                return True
        return False

    def targets(self, qa):
        """Quays reachable from quay qa by changing: same station quays and published footpath targets."""
        p = self.parent.get(qa, qa)
        out = list(self.by_parent.get(p, [qa]))
        for p2, lst in self.foot.get(p, {}).items():
            out.extend(self.by_parent.get(p2, []))
        return out

    # ---- endpoints ----
    def station_quays(self, didok):
        return [s for s, v in self.stops.items() if v["didok"] == str(didok) and v["lt"] != "1"]

    def access(self, didok, T):
        """[(quay, walk_secs)]: the origin station's quays (0 s) and quays of footpath-linked stations."""
        qs = self.station_quays(didok)
        out = {q: 0 for q in qs}
        ps = {self.parent[q] for q in qs}
        for p in ps:
            for p2, lst in self.foot.get(p, {}).items():
                w = min(x[2] for x in lst)
                for q2 in self.by_parent.get(p2, []):
                    if q2 not in out or out[q2] > w:
                        out[q2] = w
        return out

    def egress(self, didok):
        """{quay: walk_secs} into the destination station (0 at its own quays)."""
        qs = self.station_quays(didok)
        out = {q: 0 for q in qs}
        ps = {self.parent[q] for q in qs}
        for p_from, dct in self.foot.items():
            for p_to, lst in dct.items():
                if p_to in ps and p_from not in ps:
                    w = min(x[2] for x in lst)
                    for q in self.by_parent.get(p_from, []):
                        if q not in out or out[q] > w:
                            out[q] = w
        return out

    # ---- search ----
    def query(self, origin, dest, T, max_transfers=3, horizon=6 * 3600, allow_walk=True, exclude_occ=None):
        K = max_transfers + 1
        H = T + horizon
        acc = self.access(origin, T) if allow_walk else {q: 0 for q in self.station_quays(origin)}
        egr = self.egress(dest) if allow_walk else {q: 0 for q in self.station_quays(dest)}
        dest_quays = set(egr)
        n_occ = len(self.occ)
        exclude_occ = exclude_occ or set()
        # per round: boarded[o][k] = (label, parent) ; aboard[o][k] = (label, board_k)
        best_arr = math.inf
        frontier = []  # per rides r: (arr, -dep, witness)
        prev_aboard = None
        results = []
        aboard_rounds = []
        for r in range(1, K + 1):
            boarded = {}  # (o,k) -> (label, parent)

            def offer(o, k, lab, par):
                cur = boarded.get((o, k))
                if cur is None or lab > cur[0]:
                    boarded[(o, k)] = (lab, par)

            if r == 1:
                for q, w in acc.items():
                    lst = self.deps_at.get(q)
                    if not lst:
                        continue
                    i = bisect.bisect_left(self.dep_times[q], T + w)
                    for j in range(i, len(lst)):
                        d, o, k = lst[j]
                        if d > H or d > best_arr:
                            break
                        if o in exclude_occ:
                            continue
                        offer(o, k, d - w, ("origin", q, w))
            else:
                # transfers from every event aboard in round r-1 (pruned: plain dominated arrivals)
                arrivals = defaultdict(list)
                for (o, k) in improved:
                    lab = prev_aboard[(o, k)][0]
                    if self.drop_[o][k] == 1:
                        continue
                    arrivals[self.quay[o][k]].append((self.arr[o][k], -lab, o, k, lab))
                for qa, lst in arrivals.items():
                    lst.sort()
                    tg = self.targets(qa)
                    named = set()
                    for key_stop, _ in self.stop_keys(qa):
                        named |= self.from_named.get(key_stop, set())
                    run_max = NEG
                    for a, _, o, k, lab in lst:
                        if a > best_arr or a > H:
                            break
                        tid = self.trip_of[o]
                        plain = "*" not in named and tid not in named and ("route:" + str(self.route_of.get(tid))) not in named
                        if plain and lab <= run_max:
                            continue
                        if plain:
                            run_max = max(run_max, lab)
                        for qd in tg:
                            lstd = self.deps_at.get(qd)
                            if not lstd:
                                continue
                            i = bisect.bisect_left(self.dep_times[qd], a)
                            for j in range(i, len(lstd)):
                                d, o2, k2 = lstd[j]
                                if d > H or d > best_arr:
                                    break
                                if o2 == o or o2 in exclude_occ:
                                    continue
                                m = self.min_transfer(qa, qd, o, o2)
                                if m is None or d < a + m:
                                    continue
                                cur = boarded.get((o2, k2))
                                if cur is None or lab > cur[0]:
                                    boarded[(o2, k2)] = (lab, ("transfer", r - 1, o, k, qa, qd, m))
            # onboard propagation + in-seat continuations (zero changes) to a fixed point
            aboard = dict(prev_aboard) if prev_aboard else {}
            aboard_par = {}
            pending = defaultdict(list)
            for (o, k), (lab, par) in boarded.items():
                pending[o].append((k, lab, par))
            seen_inseat = set()
            while pending:
                o, items = pending.popitem()
                items.sort()
                n = len(self.quay[o])
                run, rk, rpar = NEG, None, None
                starts = {k: (lab, par) for k, lab, par in items}
                for k in range(n):
                    if k in starts and starts[k][0] > run:
                        run, rk, rpar = starts[k][0], k, starts[k][1]
                    if run == NEG or k == rk:
                        continue
                    cur = aboard.get((o, k))
                    if cur is None or run > cur[0]:
                        aboard[(o, k)] = (run, rk)
                        aboard_par[(o, k)] = (r, rk, rpar)
                # in-seat continuation from the last call of o
                tid, d = self.occ[o]
                k_last = n - 1
                if run > NEG and self.inseat.get(tid):
                    for (fs, ts, tt, sid) in self.inseat[tid]:
                        if sid and sid not in self.active.get(d, ()):
                            continue
                        if self.parent.get(self.quay[o][k_last]) != self.parent.get(fs):
                            continue  # the occurrence is cut (region or measure) before the in-seat point
                        o2 = self.occ_index.get((tt, d))
                        if o2 is None or o2 in exclude_occ:
                            continue
                        lab_last = aboard.get((o, k_last), (NEG,))[0]
                        if lab_last == NEG:
                            continue
                        for k2, q2 in enumerate(self.quay[o2]):
                            if q2 == ts or self.parent.get(q2) == self.parent.get(ts):
                                if self.dep[o2][k2] >= self.arr[o][k_last] and (o2, k2, lab_last) not in seen_inseat:
                                    seen_inseat.add((o2, k2, lab_last))
                                    pending[o2].append((k2, lab_last, ("inseat", r, o, k_last)))
                                break
            # destination (events improved in this round; earlier ones were recorded with fewer rides)
            for (o, k) in aboard_par:
                lab = aboard[(o, k)][0]
                q = self.quay[o][k]
                if q in dest_quays and self.drop_[o][k] != 1:
                    a = self.arr[o][k] + egr[q]
                    results.append((a, r, lab, o, k, egr[q]))
                    if a < best_arr:
                        best_arr = a
            prev_aboard = aboard
            improved = set(aboard_par)
            aboard_rounds.append(aboard_par)
        if not results:
            return dict(found=False, frontier=[])
        # lexicographic optimum (arrival, changes, -departure); rides r -> changes r-1 minus in-seat (in-seat adds no ride)
        def key(x):
            return (x[0], x[1], -x[2])
        best = min(results, key=key)
        frontier = {}
        for x in results:
            r = x[1]
            if r not in frontier or key(x) < key(frontier[r]):
                frontier[r] = x
        fr, last = [], math.inf
        for r in sorted(frontier):
            x = frontier[r]
            if x[0] < last:
                fr.append(dict(arr=x[0], changes=r - 1, dep=x[2]))
                last = x[0]
        wit = self.witness(best, aboard_rounds)
        return dict(found=True, arr=best[0], changes=best[1] - 1, dep=best[2], frontier=fr, witness=wit)

    def witness(self, best, aboard_rounds):
        a, r, lab, o, k, w_egr = best
        legs = []
        cur = (r, o, k)
        guard = 0
        while cur and guard < 50:
            guard += 1
            rr, o, k = cur
            par = aboard_rounds[rr - 1].get((o, k))
            if par is None:
                # aboard from an earlier round (monotone labels): search earlier rounds
                found = False
                for r2 in range(rr - 1, 0, -1):
                    p2 = aboard_rounds[r2 - 1].get((o, k))
                    if p2:
                        par, rr, found = p2, r2, True
                        break
                if not found:
                    break
            _, bk, bpar = par
            legs.append(self.leg(o, bk, k))
            if bpar[0] == "origin":
                if bpar[2]:
                    legs.append(dict(walk=True, secs=bpar[2], to=bpar[1]))
                cur = None
            elif bpar[0] == "transfer":
                _, r_prev, o_prev, k_prev, qa, qd, m = bpar
                legs.append(dict(transfer=True, at=qa, to=qd, minSecs=m))
                cur = (r_prev, o_prev, k_prev)
            elif bpar[0] == "inseat":
                _, r_same, o_prev, k_prev = bpar
                legs.append(dict(inseat=True))
                cur = (r_same, o_prev, k_prev)
            else:
                cur = None
        legs.reverse()
        if w_egr:
            legs.append(dict(walk=True, secs=w_egr, egress=True))
        return legs

    def leg(self, o, k1, k2):
        tid, d = self.occ[o]
        t = self.D["trips"].get(tid) or dict(line="EV", short=tid, desc="EV", headsign="")
        return dict(trip=tid, date=d, line=t["line"], short=t["short"], desc=t["desc"], headsign=t["headsign"],
                    fromQuay=self.quay[o][k1], fromName=self.stops[self.quay[o][k1]]["name"], fromDidok=self.didok.get(self.quay[o][k1]),
                    dep=self.dep[o][k1], toQuay=self.quay[o][k2], toName=self.stops[self.quay[o][k2]]["name"],
                    toDidok=self.didok.get(self.quay[o][k2]), arr=self.arr[o][k2])


def summary(res):
    from common import hms
    if not res.get("found"):
        return "no route"
    legs = [l for l in res["witness"] if "trip" in l]
    return f"{hms(res['dep'], False)}->{hms(res['arr'], False)} {res['changes']}ch [" + " > ".join(f"{l['line'] or l['desc']} {l['fromName']} {hms(l['dep'], False)}" for l in legs) + "]"


if __name__ == "__main__":
    import time
    from common import local_epoch
    reg = sys.argv[1] if len(sys.argv) > 1 else "interlaken-spiez"
    t0 = time.time()
    net = Network(reg, ["20261121", "20261122", "20261123"])
    print(reg, "occurrences", len(net.occ), f"{time.time()-t0:.1f}s")
    for o, dd, hhmm in [("8507483", "8507492", "09:37"), ("8507492", "8507483", "09:37"), ("8507000", "8507492", "09:00")]:
        t0 = time.time()
        r = net.query(o, dd, local_epoch("2026-11-22", hhmm))
        print(o, dd, hhmm, summary(r), r.get("frontier"), f"{time.time()-t0:.2f}s")
