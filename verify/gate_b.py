# Gate B: the independent oracle (oracle.py, reads the GTFS ZIP only) against the planner's /api/plan on the
# same static timetable, regional subnetworks, several departure times and transfer caps. Every planner journey
# is also validated (Gate C, validate.py).
#
#   python verify/gate_b.py --twin before=http://127.0.0.1:8805 --out verify/results/gate_b-before.json
import argparse, json, os, sys, time, urllib.parse
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, Z, dump, get_json, hms, local_epoch  # noqa: E402
from oracle import Network, data, summary  # noqa: E402
from validate import validate, national  # noqa: E402

OD = {
    "olten-aarau-zurich": [("Olten", "Aarau"), ("Aarau", "Olten"), ("Olten", "Zürich HB"), ("Zürich HB", "Olten"), ("Aarau", "Zürich HB"),
                           ("Zürich HB", "Aarau"), ("Lenzburg", "Olten"), ("Brugg AG", "Aarau"), ("Baden", "Olten"), ("Aarau", "Baden"),
                           ("Dietikon", "Lenzburg"), ("Schönenwerd SO", "Zürich HB")],
    "interlaken-spiez": [("Spiez", "Interlaken Ost"), ("Interlaken Ost", "Spiez"), ("Bern", "Interlaken Ost"), ("Interlaken Ost", "Bern"),
                         ("Thun", "Interlaken West"), ("Interlaken West", "Interlaken Ost"), ("Interlaken Ost", "Interlaken West"),
                         ("Spiez", "Bern"), ("Bern", "Spiez"), ("Thun", "Interlaken Ost")],
    "ticino": [("Lugano", "Locarno"), ("Locarno", "Lugano"), ("Bellinzona", "Locarno"), ("Locarno", "Bellinzona"), ("Cadenazzo", "Locarno"),
               ("Locarno", "Cadenazzo"), ("Lugano", "Bellinzona"), ("Bellinzona", "Lugano"), ("Giubiasco", "Locarno")],
    "waedenswil-pfaeffikon": [("Wädenswil", "Pfäffikon SZ"), ("Pfäffikon SZ", "Wädenswil"), ("Zürich HB", "Pfäffikon SZ"),
                              ("Pfäffikon SZ", "Zürich HB"), ("Wädenswil", "Rapperswil SG"), ("Thalwil", "Pfäffikon SZ"),
                              ("Richterswil", "Zürich HB"), ("Zürich HB", "Wädenswil"), ("Horgen", "Rapperswil SG")],
}
TIMES = ["05:47", "07:12", "08:53", "10:29", "12:04", "13:41", "15:16", "16:58", "18:23", "20:44", "22:31", "23:47"]
# A live twin (even without realtime) treats trains that already left in its live state as gone: a query for a past
# departure time is not a static-timetable question. Times earlier than now + 5 min are skipped (and listed).
MIN_LEAD = 300


def didok_by_name():
    D = data()
    out = {}
    for s, v in D["stops"].items():
        if v["lt"] == "1" and v["didok"]:
            out.setdefault(v["name"], v["didok"])
    return out


def twin_cost(j):
    return ((j.get("plannedArrival") or j["arrival"]) // 1000, j["transfers"], -((j.get("plannedDeparture") or j["departure"]) // 1000))


def compare(orc, js, vals, cap=3):
    """Verdict on optimal tuple and the (arrival, changes) frontier. js: twin journeys; vals: validation of each."""
    over = [j for j in js if j["transfers"] > cap]
    if over:
        jb = min(js, key=twin_cost)
        if jb["transfers"] > cap:
            return "fail-cap", f"maxTransfers={cap} but the best journey has {jb['transfers']} changes ({hms(-twin_cost(jb)[2], False)}->{hms(twin_cost(jb)[0], False)}); {len(over)} journeys over the cap"
    valid_js = [(j, v) for j, v in zip(js, vals) if v["valid"]]
    if not orc["found"]:
        if not js:
            return "agree", "no route in either"
        if valid_js:
            return "oracle-miss", "twin journey validates but the regional oracle found none (journey leaves the region?)"
        return "fail-invalid", "twin offers only invalid journeys where the oracle finds none"
    o = (orc["arr"], orc["changes"], -orc["dep"])
    if not js:
        return "fail-empty", f"twin empty; oracle {hms(orc['arr'], False)} {orc['changes']}ch dep {hms(orc['dep'], False)}"
    tb = min(js, key=twin_cost)
    t = twin_cost(tb)
    vb = vals[js.index(tb)]
    if t == o:
        return "agree", "same (arrival, changes, departure)"
    if t < o:
        if not vb["valid"]:
            return "fail-invalid", f"twin best {hms(t[0], False)} {t[1]}ch is better than the oracle but invalid: {'; '.join(vb['errors'])}"
        return "oracle-miss", f"twin best {hms(t[0], False)} {t[1]}ch dep {hms(-t[2], False)} validates and beats the oracle {hms(o[0], False)} {o[1]}ch dep {hms(-o[2], False)}"
    if t[0] > o[0]:
        return "fail-later", f"twin arrives {t[0]-o[0]}s later: twin {hms(-t[2], False)}->{hms(t[0], False)} {t[1]}ch vs oracle {hms(-o[2], False)}->{hms(o[0], False)} {o[1]}ch"
    if t[1] > o[1]:
        return "fail-changes", f"same arrival {hms(t[0], False)}, twin {t[1]} changes vs oracle {o[1]}"
    return "fail-departure", f"same arrival and changes, twin leaves {hms(-t[2], False)} vs oracle {hms(-o[2], False)} (later departure possible)"


def plan(base, o, d, T, mt=None, limit=6):
    q = {"from": o, "to": d, "after": T * 1000, "limit": limit}
    if mt is not None:
        q["maxTransfers"] = mt
    url = f"{base}/api/plan?{urllib.parse.urlencode(q)}"
    t0 = time.time()
    st, body = get_json(url, timeout=60)
    return url, st, body or {}, int((time.time() - t0) * 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", action="append", default=[])
    ap.add_argument("--day", default="2026-11-22")
    ap.add_argument("--times", default=",".join(TIMES))
    ap.add_argument("--caps", default="3,0,1")
    ap.add_argument("--modes", default="railev")
    ap.add_argument("--walk", default="1", help="1 = published footpaths are legal (the correct target)")
    ap.add_argument("--regions", default=",".join(OD))
    ap.add_argument("--out", default=os.path.join(RESULTS, "gate_b.json"))
    a = ap.parse_args()
    twins = dict(t.split("=", 1) for t in a.twin)
    names = didok_by_name()
    nat = national()
    dates = ["20261121", "20261122", "20261123"]
    out, counts = [], {}
    caps = [int(x) for x in a.caps.split(",")]
    times_all = a.times.split(",")
    times = [h for h in times_all if local_epoch(a.day, h) >= time.time() + MIN_LEAD]
    skipped = [h for h in times_all if h not in times]
    print("times", times, "skipped (past)", skipped, flush=True)
    for reg in a.regions.split(","):
        t0 = time.time()
        net = Network(reg, dates, modes=a.modes)
        print(f"{reg}: {len(net.occ)} occurrences ({time.time()-t0:.1f}s)", flush=True)
        for (fn, tn) in OD[reg]:
            o, d = names[fn], names[tn]
            for hhmm in times:
                T = local_epoch(a.day, hhmm)
                for mt in caps:
                    if mt != 3 and hhmm not in ("07:12", "12:04", "16:58", "22:31"):
                        continue
                    t1 = time.time()
                    orc = net.query(o, d, T, max_transfers=mt, allow_walk=a.walk == "1")
                    oms = int((time.time() - t1) * 1000)
                    rec = dict(region=reg, frm=fn, to=tn, fromId=o, toId=d, time=hhmm, T=T, maxTransfers=mt,
                               oracle=dict(found=orc["found"], arr=orc.get("arr"), changes=orc.get("changes"), dep=orc.get("dep"),
                                           frontier=orc.get("frontier"), witness=orc.get("witness"), summary=summary(orc), ms=oms), twins={})
                    for label, base in twins.items():
                        url, st, body, ms = plan(base, o, d, T, None if mt == 3 else mt)
                        js = body.get("journeys", []) if st == 200 else []
                        vals = [validate(j, o, d, T, net=nat) for j in js]
                        v, why = compare(orc, js, vals, mt)
                        # frontier coverage: each oracle (arrival, changes) point offered by the twin?
                        offered = {(twin_cost(j)[0], twin_cost(j)[1]) for j in js}
                        cover = [dict(f, offered=any(a_ <= f["arr"] and c_ <= f["changes"] for a_, c_ in offered)) for f in (orc.get("frontier") or [])]
                        impossible = [dict(dep=hms(-twin_cost(j)[2], False), arr=hms(twin_cost(j)[0], False), ch=j["transfers"])
                                      for j in js if orc["found"] and any(twin_cost(j)[0] < f["arr"] and j["transfers"] <= f["changes"] for f in orc["frontier"])]
                        rec["twins"][label] = dict(url=url, status=st, ms=ms, snapshotId=body.get("snapshotId"), verdict=v, why=why,
                                                   journeys=[dict(dep=hms(-twin_cost(j)[2], False), arr=hms(twin_cost(j)[0], False), changes=j["transfers"],
                                                                  lines=[l.get("line") or l.get("category") for l in j.get("legs", [])], valid=vv["valid"], errors=vv["errors"])
                                                             for j, vv in zip(js, vals)],
                                                   invalid=sum(not vv["valid"] for vv in vals), frontierCoverage=cover, beatsFrontier=impossible,
                                                   error=body.get("error") if st != 200 else None)
                        counts.setdefault(label, {}).setdefault(v, 0)
                        counts[label][v] += 1
                    out.append(rec)
                    line = " | ".join(f"{lb}: {r['verdict']}" for lb, r in rec["twins"].items())
                    print(f"  {hhmm} cap{mt} {fn} > {tn}: oracle {rec['oracle']['summary'][:90]} | {line}", flush=True)
    summ = dict(day=a.day, modes=a.modes, walk=a.walk == "1", cases=len(out), counts=counts, times=times, skippedPastTimes=skipped,
                invalid={lb: sum(r["twins"][lb]["invalid"] for r in out) for lb in twins},
                journeys={lb: sum(len(r["twins"][lb]["journeys"]) for r in out) for lb in twins},
                generatedAt=datetime.now(Z).isoformat())
    dump(a.out, dict(summary=summ, results=out))
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
