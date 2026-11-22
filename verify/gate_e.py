# Gate E: the Wädenswil replay (10 Sep 2026) on private replay instances, with the two observed witnesses
# from the Ist-Daten (sbb/history/months/2026-09.parquet):
#   W1  S8 18823-001 reached Wädenswil 07:08:02 REAL, its Pfäffikon SZ call cancelled: no journey may ride it (or any
#       certain journey cross Wädenswil - Pfäffikon SZ) before the 11:00 partial reopening.
#   W2  S8 18839-001 actually ran Wädenswil 11:07:46 -> Pfäffikon SZ 11:20:35 (REAL) after the partial reopening: the
#       planner must admit it; arrival error against the observation is reported.
# Each snapshot reveals only the decisions announced by then (the replay applies them at their real times).
#
#   python verify/gate_e.py --twin after=http://127.0.0.1:8807 --twin before=http://127.0.0.1:8808
import argparse, json, os, sys, time, urllib.parse
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, Z, dump, get_json, hms, local_epoch  # noqa: E402

PKL_SEP = os.path.join(HERE, ".cache", "gtfs-20260909-20260910-20260911.pkl")
W, P, ZH, TH = "8503206", "8503209", "8503000", "8503202"
ODS = [(ZH, P), (W, P), (TH, P), (P, W), (P, ZH)]
SNAPSHOTS = [("06:10", "after the 05:43 closure (UNKNOWN)"), ("06:57", "after 06:54 buses sought, 06:56 short turn"),
             ("07:03", "after 06:58 S2/S8/S25 cancelled; S8 18823 due at Wädenswil 07:07"),
             ("07:15", "after 07:13 first bus announcement"), ("08:35", "after 08:32 revised buses"),
             ("10:57", "after 10:53/10:55: limited from 11:00, S8/IR35 run"), ("11:02", "after the 11:00 partial reopening")]
WITNESS = {"18823": dict(day="2026-09-10", wadenswil_arr_real="07:08:02", pfaeffikon="cancelled"),
           "18839": dict(day="2026-09-10", dep_real="11:07:46", arr_real="11:20:35", dep_planned="11:07", arr_planned="11:19")}


_SEP = {}


def sep():
    import pickle
    if not _SEP:
        _SEP["D"] = pickle.load(open(PKL_SEP, "rb"))
    return _SEP["D"]


def trip_numbers():
    D = sep()
    return {tid: (t["short"], t["original"], t["line"]) for tid, t in D["trips"].items()}


def leg_crosses(leg, crosser):
    """Every hop of the leg's GTFS calls between boarding and alighting, tested on the physical paths."""
    D = sep()
    tid = leg["trainId"]
    trip = "." + tid.split("_", 1)[1] if "_" in tid else tid
    cl = D["calls"].get(trip)
    if not cl or crosser is None:
        return None
    did = [D["stops"].get(c[1], {}).get("didok") for c in cl]
    try:
        i = next(k for k, x in enumerate(did) if x == leg["fromId"])
        j = next(k for k in range(len(did) - 1, i, -1) if did[k] == leg["toId"])
    except StopIteration:
        return None
    return any(crosser(did[k], did[k + 1]) for k in range(i, j) if did[k] != did[k + 1])


def clock(base):
    st, s = get_json(f"{base}/api/status")
    return (s or {}).get("ts", 0) / 1000


def legs_of(j, nums):
    out = []
    for l in j.get("legs", []):
        tid = l.get("trainId") or ""
        trip = "." + tid.split("_", 1)[1] if "_" in tid else tid
        n = nums.get(trip, (None, None, None))
        f, t = l.get("from") or {}, l.get("to") or {}
        out.append(dict(line=l.get("line"), number=n[0], journey=n[1], trainId=tid, fromId=str(f.get("id")), from_=f.get("name"),
                        dep=(f.get("expectedDep") or f.get("plannedDep") or 0) // 1000, plannedDep=(f.get("plannedDep") or 0) // 1000,
                        toId=str(t.get("id")), to=t.get("name"), arr=(t.get("expectedArr") or t.get("plannedArr") or 0) // 1000,
                        plannedArr=(t.get("plannedArr") or 0) // 1000, category=l.get("category")))
    return out


def crosses_by_station(leg):
    """A rail leg between Wädenswil and Pfäffikon SZ (either way) or from/to a station beyond, through the section."""
    if (leg["category"] or "").upper() in ("EV", "WALK", "BUS", "B"):
        return False
    a, b = leg["fromId"], leg["toId"]
    west = {W, ZH, TH, "8503204", "8503203", "8503205", "8503201", "8503001", "8503011"}  # Zürich side (Thalwil, Horgen, Au, Oberrieden...)
    east = {P, "8503283", "8503208", "8503210", "8503211", "8509002", "8503212", "8503213", "8503281"}  # Pfäffikon side
    inside = {"8503207", "8503228", "8503229"}  # Richterswil, Bäch, Freienbach SBB
    return (a in west and (b in east or b in inside)) or (b in west and (a in east or a in inside)) or (a in inside and b in east) or (b in inside and a in east)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", action="append", default=[])
    ap.add_argument("--out", default=os.path.join(RESULTS, "gate_e.json"))
    a = ap.parse_args()
    twins = dict(t.split("=", 1) for t in a.twin)
    nums = trip_numbers()
    res = {lb: dict(snapshots=[], W1=dict(pass_=True, violations=[]), W2=dict(pass_=False, offered=[])) for lb in twins}
    for hhmm, note in SNAPSHOTS:
        target = local_epoch("2026-09-10", hhmm)
        while True:
            ts = [clock(b) for b in twins.values()]
            if min(ts) >= target:
                break
            time.sleep(max(0.5, min(5, (target - min(ts)) / 20 / 2)))
        for lb, base in twins.items():
            now = clock(base)
            from measures import hop_crosser
            _, ds = get_json(f"{base}/api/disruptions")
            recs = [x for x in (ds or []) if x.get("section")]
            crosser = hop_crosser(recs[0]) if recs else None
            _, rep = get_json(f"{base}/api/replays")
            snap = dict(at=hhmm, virtualNow=hms(now, False), note=note, stepsDone=(rep or {}).get("done") or ((rep or {}).get("active") if isinstance((rep or {}).get("active"), str) else None), queries=[])
            for (o, d) in ODS:
                afters = [now]
                if hhmm in ("06:10", "06:57", "07:03"):
                    afters.append(local_epoch("2026-09-10", "06:50"))  # S8 18823 is a candidate from Zürich side
                if hhmm in ("10:57", "11:02"):
                    afters.append(local_epoch("2026-09-10", "11:00"))
                for after in afters:
                    q = {"from": o, "to": d, "after": int(after * 1000), "limit": 6, "includeWait": "true"}
                    st, body = get_json(f"{base}/api/plan?{urllib.parse.urlencode(q)}", timeout=60)
                    js = (body or {}).get("journeys", []) if st == 200 else []
                    qrec = dict(frm=o, to=d, after=hms(after, False), status=st, snapshotId=(body or {}).get("snapshotId"),
                                error=(body or {}).get("error") if st != 200 else None, journeys=[])
                    for j in js:
                        ls = legs_of(j, nums)
                        jrec = dict(dep=hms(j["departure"] // 1000, False), arr=hms(j["arrival"] // 1000, False), changes=j["transfers"],
                                    uncertain=j.get("uncertain", False), kind=j.get("kind"),
                                    legs=[f"{x['line']} {x['number'] or ''} {x['from_']} {hms(x['dep'], False)} -> {x['to']} {hms(x['arr'], False)}" for x in ls])
                        qrec["journeys"].append(jrec)
                        for x in ls:
                            # W1: S8 18823 beyond Wädenswil, or any certain crossing before the 11:00 partial reopening
                            cx = leg_crosses(x, crosser) if (x["category"] or "").upper() not in ("EV", "WALK", "B", "BUS") else False
                            if x["number"] == "18823" and x["toId"] != W and x["fromId"] != P:
                                if x["toId"] == P or cx:
                                    res[lb]["W1"]["violations"].append(dict(snapshot=hhmm, od=f"{o}>{d}", leg=jrec["legs"], uncertain=jrec["uncertain"], why="rides S8 18823 beyond Wädenswil"))
                            if cx and x["dep"] < local_epoch("2026-09-10", "11:00") and now < local_epoch("2026-09-10", "11:00") and not j.get("uncertain"):
                                res[lb]["W1"]["violations"].append(dict(snapshot=hhmm, od=f"{o}>{d}", leg=jrec["legs"], why="certain crossing of Wädenswil - Pfäffikon SZ before the reopening"))
                            if x["number"] == "18839" and now >= local_epoch("2026-09-10", "10:53"):
                                obs_arr = local_epoch("2026-09-10", "11:20") + 35
                                obs_dep = local_epoch("2026-09-10", "11:07") + 46
                                res[lb]["W2"]["offered"].append(dict(snapshot=hhmm, od=f"{o}>{d}", leg=f"{x['from_']} {hms(x['dep'], False)} -> {x['to']} {hms(x['arr'], False)}",
                                                                     planned=f"{hms(x['plannedDep'], False)} -> {hms(x['plannedArr'], False)}", uncertain=j.get("uncertain", False),
                                                                     depErrorSec=x["dep"] - obs_dep if x["fromId"] == W else None,
                                                                     arrErrorSec=x["arr"] - obs_arr if x["toId"] == P else None))
                    snap["queries"].append(qrec)
            res[lb]["snapshots"].append(snap)
            print(f"{lb} {hhmm} (virtual {snap['virtualNow']}): " + "; ".join(f"{q['frm']}>{q['to']}@{q['after']}: " + (", ".join(f"{j['dep']}-{j['arr']}{'?' if j['uncertain'] else ''}" for j in q['journeys'][:3]) or (q.get('error') or 'none')) for q in snap["queries"]), flush=True)
    for lb in twins:
        res[lb]["W1"]["pass_"] = not res[lb]["W1"]["violations"]
        res[lb]["W2"]["pass_"] = any(x["od"].startswith(W) and x["leg"].startswith("Wädenswil") for x in res[lb]["W2"]["offered"])
    summ = {lb: dict(W1=res[lb]["W1"]["pass_"], W1violations=len(res[lb]["W1"]["violations"]), W2=res[lb]["W2"]["pass_"],
                     W2offered=res[lb]["W2"]["offered"][:3]) for lb in twins}
    dump(a.out, dict(summary=summ, witnesses=WITNESS, results=res, generatedAt=datetime.now(Z).isoformat()))
    print(json.dumps(summ, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
