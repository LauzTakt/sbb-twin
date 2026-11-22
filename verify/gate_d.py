# Gate D: seeded disruptions on a private twin. For every case: the planner before the disruption, then a
# closure (random section, start, duration, duration type, short turn / hold) and its answer, then (when drawn) a
# replacement bus added to the same disruption and the answer again, then caps 1 and 2. The oracle recomputes on
# its own projection of the record (measures.py), in the confirmed class (no crossing on a lower-bound/unknown
# reopening) and the conditional class. Checks:
#   oracle:     planner best confirmed journey == oracle confirmed optimum (arrival, changes, departure)
#   validity:   every planner journey valid under our projection (Gate C); a journey not marked uncertain never
#               crosses the section after a lower-bound/unknown reopening
#   invariants: removing rides never improves the planner's optimum; adding a legal bus never worsens it;
#               raising maxTransfers never worsens it (each on the planner's own answers)
#
#   python verify/gate_d.py --twin http://127.0.0.1:8805 --label before --cases 200 --seed 1
import argparse, json, os, random, sys, time, urllib.parse
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, Z, dump, get_json, hms  # noqa: E402
from oracle import Network, data, summary  # noqa: E402
from measures import bus_trips, project  # noqa: E402
from validate import validate, national  # noqa: E402
from gate_b import OD, didok_by_name, twin_cost  # noqa: E402

SECTIONS = {
    "olten-aarau-zurich": [("Olten", "Aarau"), ("Aarau", "Lenzburg"), ("Lenzburg", "Othmarsingen"), ("Zürich Altstetten", "Zürich HB"),
                           ("Brugg AG", "Baden"), ("Aarau", "Rupperswil")],
    "interlaken-spiez": [("Spiez", "Interlaken West"), ("Thun", "Spiez"), ("Bern", "Münsingen"), ("Interlaken West", "Interlaken Ost")],
    "ticino": [("Bellinzona", "Giubiasco"), ("Giubiasco", "Cadenazzo"), ("Lugano", "Taverne-Torricella")],
    "waedenswil-pfaeffikon": [("Wädenswil", "Pfäffikon SZ"), ("Thalwil", "Horgen"), ("Horgen", "Wädenswil"), ("Pfäffikon SZ", "Rapperswil SG")],
}


def plan(base, o, d, T, mt=None, extra=None):
    q = {"from": o, "to": d, "after": int(T * 1000), "limit": 6}
    if mt is not None:
        q["maxTransfers"] = mt
    q.update(extra or {})
    st, body = get_json(f"{base}/api/plan?{urllib.parse.urlencode(q)}", timeout=60)
    return (body or {}).get("journeys", []) if st == 200 else [], body or {}


def ecost(j):
    """Cost at forecast times (a held train counts at its forecast departure); sub-minute engine jitter ignored."""
    pd, pa = (j.get("plannedDeparture") or j["departure"]) // 1000, (j.get("plannedArrival") or j["arrival"]) // 1000
    ed, ea = j["departure"] // 1000, j["arrival"] // 1000
    d = ed if abs(ed - pd) >= 60 else pd
    a = ea if abs(ea - pa) >= 60 else pa
    return (a, j["transfers"], -d)


def best(js, confirmed_only=False):
    js = [j for j in js if not (confirmed_only and j.get("uncertain"))]
    return min(js, key=ecost) if js else None


def tup(j):
    return ecost(j) if j else None


def fmt_t(t):
    return "none" if not t else f"{hms(-t[2], False)}->{hms(t[0], False)} {t[1]}ch"


def probe(base, leg):
    """Does the twin itself run this oracle witness leg at these times? Direct query between its stations."""
    from validate import trip_candidates
    q_from, q_to = leg.get("fromDidok"), leg.get("toDidok")
    js, _ = plan(base, q_from, q_to, leg["dep"] - 60, 0)
    seen = []
    for j in js:
        for l in j.get("legs", []):
            tid = l.get("trainId") or ""
            f, t = l.get("from") or {}, l.get("to") or {}
            dep, arr = (f.get("expectedDep") or f.get("plannedDep") or 0) // 1000, (t.get("expectedArr") or t.get("plannedArr") or 0) // 1000
            same = any(c[0] == leg["trip"] for c in trip_candidates(tid)) or (str(leg["trip"]).startswith("EV-") and "EV-" in tid and abs(dep - leg["dep"]) <= 30)
            if same:
                return dict(found=True, dep=hms(dep, False), arr=hms(arr, False), shiftedSec=dep - leg["dep"], twinLine=l.get("line"))
            seen.append(f"{l.get('line')} {hms(dep, False)}")
    return dict(found=False, offered=seen[:6])


def attribute(base, orc):
    """fail-later/fail-empty: planner miss (every witness train runs in the twin at our times) or projection
    difference (the twin cancels/holds/retimes a witness train, or runs a different bus)."""
    legs = [l for l in (orc.get("witness") or []) if "trip" in l]
    pr = [dict(line=l["line"] or l["desc"], at=f"{l['fromName']} {hms(l['dep'], False)}", **probe(base, l)) for l in legs]
    diff = [p for p in pr if not p["found"] or abs(p.get("shiftedSec", 0)) >= 60]
    return ("projection-diff" if diff else "planner-miss"), pr


def otup(r):
    return (r["arr"], r["changes"], -r["dep"]) if r.get("found") else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", required=True)
    ap.add_argument("--label", default="before")
    ap.add_argument("--cases", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    out_path = a.out or os.path.join(RESULTS, f"gate_d-{a.label}.json")
    rnd = random.Random(a.seed)
    names = didok_by_name()
    nat = national()
    D = data()
    dates = ["20261121", "20261122", "20261123"]
    nets = {reg: Network(reg, dates) for reg in OD}
    st, geo = get_json(f"{a.twin}/api/stations.geojson")
    coords = {str(f["properties"].get("id")): (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in geo["features"]}
    generic = {}
    for s, v in D["stops"].items():  # a bus calls at the station-level stop ('ch:1:sloid:218'), else any quay
        if v["lt"] != "1" and v["didok"]:
            if v["parent"] == "Parent" + s or v["didok"] not in generic:
                generic[v["didok"]] = s
    get_json(f"{a.twin}/api/control/reset", method="POST", body={})
    results, counts = [], {}
    t_start = time.time()
    for i in range(a.cases):
        reg = rnd.choice(list(SECTIONS))
        sa, sb = rnd.choice(SECTIONS[reg])
        if rnd.random() < 0.5:
            sa, sb = sb, sa
        fn, tn = rnd.choice(OD[reg])
        o, d = names[fn], names[tn]
        now = time.time()
        start = int(now + rnd.choice([-40, -20, -5, 0, 10, 30, 60]) * 60)
        minutes = rnd.choice([20, 35, 50, 75, 110, 150])
        while start + minutes * 60 < now + 600:
            minutes += 30
        dtype = rnd.choices(["UNTIL", "UNTIL_AT_LEAST", "UNKNOWN"], [0.6, 0.3, 0.1])[0]
        measures = []
        if rnd.random() < 0.6:
            measures.append({"type": "short_turn", "at": rnd.choice(["both", "both", "A", "B"])})
        add_bus = rnd.random() < 0.5
        bus = {"type": "replacement_bus", "firstInMin": rnd.choice([5, 10, 15]), "everyMin": rnd.choice([10, 15, 20, 30]), "force": True}
        T = start + rnd.choice([-15, 0, 5, 20, 45]) * 60
        T = max(T, now + 60)  # queries from the decision time on (no retroactive past)
        T = int(T // 60 * 60) + rnd.choice([0, 0, 30])
        case = dict(i=i, seed=a.seed, region=reg, section=[sa, sb], od=[fn, tn], T=T, Tlocal=hms(T, False), start=start, minutes=minutes,
                    durationType=dtype, measures=measures, addBus=add_bus, bus=bus if add_bus else None)
        rec = dict(case=case, checks={}, notes=[])
        try:
            js0, _ = plan(a.twin, o, d, T)
            body = dict(cause="EG_008", scope=dict(kind="section", **{"from": names[sa], "to": names[sb]}), effect="interrupted",
                        start=start * 1000, durationType=dtype, measures=measures)
            if dtype != "UNKNOWN":
                body["minutes"] = minutes
            decided = time.time()
            stc, resp = get_json(f"{a.twin}/api/disruptions", method="POST", body=body)
            if stc != 201:
                rec["error"] = f"create {stc}: {resp}"
                results.append(rec)
                continue
            did = resp["disruption"]["id"]
            stages = [("closure", None)]
            if add_bus:
                stages.append(("closure+bus", bus))
            prev_best = None
            for stage, m in stages:
                if m:
                    get_json(f"{a.twin}/api/disruptions/{did}/measures", method="POST", body=m)
                _, r = get_json(f"{a.twin}/api/disruptions/{did}")
                net = nets[reg]
                projc = project(net, r, "confirmed", decided)
                projx = project(net, r, "conditional", decided)
                buses = bus_trips(r, coords, generic, "20261122")
                netc = net.modified(cuts=projc["cuts"], holds=projc["holds"], extra=buses)
                netx = net.modified(cuts=projx["cuts"], holds=projx["holds"], extra=buses)
                oc = netc.query(o, d, T)
                ox = netx.query(o, d, T)
                js, pb = plan(a.twin, o, d, T)
                jb_conf = best(js, True)
                jb_all = best(js)
                # validity under our projection (confirmed class for journeys the planner calls certain)
                extra_ids = {}
                inval = []
                for j in js:
                    M = dict(closures=projc["closures"] if not j.get("uncertain") else projx["closures"], cuts={}, holds={})
                    netv = netc if not j.get("uncertain") else netx
                    v = validate(j, o, d, T, net=netv, use_expected=True, fallback=nat)
                    errs = list(v["errors"])
                    if errs:
                        inval.append(dict(dep=hms(-ecost(j)[2], False), arr=hms(ecost(j)[0], False), uncertain=j.get("uncertain", False),
                                          lines=[l.get("line") for l in j.get("legs", [])], errors=errs))
                st_rec = dict(stage=stage, disruption=dict(id=did, start=r.get("start"), until=r.get("until"), durationType=r.get("durationType"),
                                                          section=[x["id"] for x in [r["section"]["a"]] + r["section"].get("inside", []) + [r["section"]["b"]]],
                                                          measures=[(x["type"], x.get("params")) for x in r.get("measures", [])], impact=r.get("impact")),
                              projection=dict(closedEdges=projc["closedEdges"], geometryUnmatched=projc["geometryUnmatched"], unresolvedPairs=projc["unresolvedPairs"][:10],
                                              cuts=len(projc["cuts"]), holds=len(projc["holds"]), cutsConditional=len(projx["cuts"]),
                                              holdsConditional=len(projx["holds"]), buses=len(buses)),
                              oracleConfirmed=dict(t=otup(oc), s=summary(oc), witness=oc.get("witness")), oracleConditional=dict(t=otup(ox), s=summary(ox)),
                              planner=dict(bestConfirmed=tup(jb_conf), bestAll=tup(jb_all), n=len(js), snapshotId=pb.get("snapshotId"),
                                           journeys=[dict(t=tup(j), uncertain=j.get("uncertain", False), lines=[l.get("line") for l in j.get("legs", [])]) for j in js]),
                              invalid=inval)
                # oracle agreement on the confirmed class
                tc, oc_t = tup(jb_conf), otup(oc)
                if tc == oc_t:
                    v_or = "agree"
                elif oc_t is None:
                    bad = [x for x in inval if not x["uncertain"] and x["dep"] == hms(-tc[2], False) and x["arr"] == hms(tc[0], False)]
                    v_or = "fail-invalid-certain" if bad else "planner-only"  # certain journey where the oracle has none
                elif tc is None:
                    v_or = "fail-empty"
                elif tc < oc_t:
                    bad = [x for x in inval if not x["uncertain"] and x["dep"] == hms(-tc[2], False) and x["arr"] == hms(tc[0], False)]
                    v_or = "fail-invalid-certain" if bad else "planner-better"
                elif tc[0] > oc_t[0]:
                    v_or = "fail-later"
                else:
                    v_or = "fail-tuple"
                if v_or in ("fail-later", "fail-empty", "fail-tuple"):
                    cause, pr = attribute(a.twin, oc)
                    st_rec["attribution"] = dict(cause=cause, probes=pr)
                    v_or = v_or + ":" + cause
                st_rec["oracleVerdict"] = v_or
                st_rec["why"] = f"planner confirmed {fmt_t(tc)} vs oracle confirmed {fmt_t(oc_t)} [{oc.get('found') and summary(oc)}]"
                rec["checks"][stage] = st_rec
                counts.setdefault("oracle:" + v_or, 0)
                counts["oracle:" + v_or] += 1
                counts.setdefault("invalidJourneys", 0)
                counts["invalidJourneys"] += len(inval)
                # invariants on the planner's own answers
                b0 = tup(best(js0))
                if stage == "closure":
                    ok = b0 is None or tup(jb_all) is None or tup(jb_all)[0] >= b0[0]
                    rec["checks"]["inv_remove"] = dict(ok=ok, before=b0, after=tup(jb_all))
                    counts.setdefault("inv_remove_fail", 0)
                    counts["inv_remove_fail"] += 0 if ok else 1
                else:
                    ok = prev_best is None or (tup(jb_all) is not None and tup(jb_all)[0] <= prev_best[0])
                    rec["checks"]["inv_addbus"] = dict(ok=ok, closureOnly=prev_best, withBus=tup(jb_all))
                    counts.setdefault("inv_addbus_fail", 0)
                    counts["inv_addbus_fail"] += 0 if ok else 1
                prev_best = tup(jb_all)
            # raising maxTransfers never worsens
            arrs = []
            for mt in (1, 2, 3):
                jsm, _ = plan(a.twin, o, d, T, mt)
                bm = best([j for j in jsm if j["transfers"] <= mt])
                arrs.append(tup(bm)[0] if bm else None)
            ok = all(x is None or y is not None and y <= x for x, y in zip(arrs, arrs[1:]))
            rec["checks"]["inv_caps"] = dict(ok=ok, bestArrByCap={str(k): (hms(v, False) if v else None) for k, v in zip((1, 2, 3), arrs)})
            counts.setdefault("inv_caps_fail", 0)
            counts["inv_caps_fail"] += 0 if ok else 1
            get_json(f"{a.twin}/api/disruptions/{did}", method="DELETE")
        except Exception as e:
            import traceback
            rec["error"] = f"{type(e).__name__}: {e}"
            rec["trace"] = traceback.format_exc()[-800:]
            get_json(f"{a.twin}/api/control/reset", method="POST", body={})
        results.append(rec)
        ch = rec["checks"]
        line = " ".join(f"{k}={v.get('oracleVerdict') or ('ok' if v.get('ok') else 'FAIL')}" for k, v in ch.items())
        print(f"[{i+1}/{a.cases}] {reg} {sa}-{sb} {dtype} {minutes}m st={[m['type'] for m in measures]} bus={add_bus} {fn}>{tn} T={hms(T, False)}: {line} {rec.get('error','')}", flush=True)
        if (i + 1) % 20 == 0:
            dump(out_path, dict(summary=dict(label=a.label, seed=a.seed, cases=len(results), counts=counts), results=results))
    summ = dict(label=a.label, seed=a.seed, cases=len(results), errors=sum(1 for r in results if r.get("error")), counts=counts,
                seconds=round(time.time() - t_start), generatedAt=datetime.now(Z).isoformat())
    dump(out_path, dict(summary=summ, results=results))
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
