# Gate A: external differential against transport.opendata.ch (no twin measures, private no-RT twins).
# Fixes over scratchpad/plan_vs_sbb.py: origin eligibility on the same clock as the twin (scheduled when the
# twin has no realtime, prognosis when it has), second-level costs (arrival, changes, -departure), queried and
# returned endpoints and modes recorded, missing answers counted in the denominator, departure times checked
# to be >= 30 min in the future when the batch finishes, reference paged until it covers the best arrival,
# raw responses kept.
#
#   python verify/gate_a.py --twin before=http://127.0.0.1:8805 --twin after=http://127.0.0.1:8806 \
#        --day 2026-11-22 --times 09:37,12:04,16:58,19:33,23:20 --out verify/results/gate_a.json
import argparse, json, os, sys, time, urllib.parse
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RESULTS, Z, get_json, hms, local_epoch, ref_get, save_raw, dump  # noqa: E402

REF = "https://transport.opendata.ch/v1/connections"
RAIL = {"IC", "ICE", "IR", "IRE", "RE", "R", "S", "SN", "EC", "EN", "NJ", "TGV", "RJX", "PE", "EXT", "ICN", "FV", "RJ",
        "TER", "D", "CC", "GEX", "RB", "ZUG", "TE2", "EXB_RAIL"}
EV = {"EV"}
# the 30 frozen ODs of 22 Nov 08:30 (scratchpad/plan_vs_sbb.py), queried by name and by the reference's resolved id
PAIRS30 = [("Bern", "Zürich HB"), ("Zürich HB", "Lausanne"), ("Genève", "Basel SBB"), ("Luzern", "Lugano"), ("St. Gallen", "Chur"),
           ("Olten", "Aarau"), ("Biel/Bienne", "Fribourg/Freiburg"), ("Neuchâtel", "Bern"), ("Sion", "Brig"), ("Interlaken Ost", "Zürich HB"),
           ("Winterthur", "Zug"), ("Thun", "Luzern"), ("Schaffhausen", "Zürich Flughafen"), ("Bellinzona", "Arth-Goldau"),
           ("Montreux", "Fribourg/Freiburg"), ("Yverdon-les-Bains", "Genève"), ("Renens VD", "Zürich HB"), ("Wädenswil", "Rapperswil SG"),
           ("Visp", "Bern"), ("Basel SBB", "Chur"), ("Lausanne", "Brig"), ("Zug", "Lugano"), ("Aarau", "Winterthur"),
           ("Fribourg/Freiburg", "Genève"), ("Chur", "Zürich Flughafen"), ("Luzern", "Bern"), ("St. Gallen", "Lausanne"),
           ("Olten", "Interlaken Ost"), ("Solothurn", "Zürich HB"), ("Lugano", "Locarno")]
# Astra's extra fixtures: exact-platform transfers, same train, EV, zero-change (maxTransfers=0); midnight via late times
EXTRA = [
    ("Spiez", "Interlaken Ost", "exact-platform: Spiez IC6 -> RE9 published 120 s quay rule"),
    ("Renens VD", "Genève", "exact-platform: Renens pl.4 -> pl.2, published 240 s"),
    ("Olten", "Bern", "same-train"),
    ("Zürich HB", "Chur", "same-train"),
    ("Interlaken Ost", "Spiez", "EV: EV1 Interlaken Ost, Bahnhof -> Rugenpark"),
    ("Interlaken West", "Interlaken Ost", "EV"),
    ("Cadenazzo", "Locarno", "EV: TILO replacement Cadenazzo - Locarno"),
    ("Locarno", "Lugano", "EV (reverse)"),
    ("Wädenswil", "Pfäffikon SZ", "regional"),
]
ZERO = [("Zürich HB", "Chur"), ("Bern", "Zürich HB"), ("Olten", "Aarau"), ("Lugano", "Bellinzona"), ("Interlaken Ost", "Zürich HB"),
        ("St. Gallen", "Lausanne")]
MIDNIGHT = [("Zürich HB", "Bern", "23:50"), ("Bern", "Zürich HB", "23:50"), ("Lausanne", "Genève", "23:55"), ("Zürich HB", "Winterthur", "23:58")]


def mode_of(section):
    j = section.get("journey")
    if not j:
        return "walk"
    return (j.get("category") or "?").upper()


def ts(iso):
    return int(datetime.fromisoformat(iso).timestamp()) if iso else None


def ref_conn(c, eligibility):
    fr, to = c["from"], c["to"]
    sdep, sarr = fr.get("departureTimestamp"), to.get("arrivalTimestamp")
    pdep = ts((fr.get("prognosis") or {}).get("departure")) or sdep
    parr = ts((to.get("prognosis") or {}).get("arrival")) or sarr
    secs = c.get("sections") or []
    modes = [mode_of(s) for s in secs]
    walk_between = [(s["departure"]["station"]["name"], s["arrival"]["station"]["name"], (s.get("walk") or {}).get("duration"))
                    for s in secs if not s.get("journey")]
    legs = []
    for s in secs:
        j = s.get("journey")
        if not j:
            continue
        legs.append(dict(cat=mode_of(s), number=j.get("number"), name=j.get("name"), operator=j.get("operator"),
                         fromId=s["departure"]["station"]["id"], fromName=s["departure"]["station"]["name"],
                         dep=s["departure"].get("departureTimestamp"), depPrognosis=ts((s["departure"].get("prognosis") or {}).get("departure")),
                         toId=s["arrival"]["station"]["id"], toName=s["arrival"]["station"]["name"],
                         arr=s["arrival"].get("arrivalTimestamp"), arrPrognosis=ts((s["arrival"].get("prognosis") or {}).get("arrival")),
                         platformDep=s["departure"].get("platform"), platformArr=s["arrival"].get("platform")))
    first_dep_station = secs[0]["departure"]["station"] if secs else fr["station"]
    last_arr_station = secs[-1]["arrival"]["station"] if secs else to["station"]
    forecast = any((l["depPrognosis"] and l["depPrognosis"] != l["dep"]) or (l["arrPrognosis"] and l["arrPrognosis"] != l["arr"]) for l in legs)
    dep, arr = (sdep, sarr) if eligibility == "scheduled" else (pdep, parr)
    return dict(dep=dep, arr=arr, schedDep=sdep, schedArr=sarr, progDep=pdep, progArr=parr, transfers=c.get("transfers"),
                modes=modes, walks=walk_between, legs=legs, forecastAffected=forecast,
                fromStation=dict(id=first_dep_station.get("id"), name=first_dep_station.get("name")),
                toStation=dict(id=last_arr_station.get("id"), name=last_arr_station.get("name")))


def loaded(c, allow_walk):
    for m in c["modes"]:
        if m == "walk":
            if not allow_walk:
                return False
        elif m not in RAIL and m not in EV:
            return False
    return True


def cost(x):
    return (x["arr"], x["transfers"], -x["dep"])


def fetch_ref(frm, to, day, hhmm, direct, cache):
    """Page the reference until the latest returned departure is past the best arrival (or 4 pages)."""
    pages, conns = [], []
    for page in range(4):
        q = dict(**{"from": frm, "to": to}, date=day, time=hhmm, limit=6, page=page)
        if direct:
            q["direct"] = 1
        rec = ref_get(f"{REF}?{urllib.parse.urlencode(q)}", cache)
        pages.append(dict(url=rec["url"], fetchedAt=rec.get("fetchedAt"), status=rec.get("status")))
        body = rec.get("body") or {}
        cs = body.get("connections") or []
        conns.extend(cs)
        if not cs:
            break
        deps = [c["from"].get("departureTimestamp") or 0 for c in cs]
        arrs = [c["to"].get("arrivalTimestamp") or 1e12 for c in conns]
        if max(deps) >= min(arrs):
            break
    return pages, conns, body if pages else {}


def twin_journey(j):
    legs = []
    for l in j.get("legs") or []:
        f, t = l.get("from") or {}, l.get("to") or {}
        legs.append(dict(trainId=l.get("trainId"), line=l.get("line"), cat=l.get("category") or l.get("mode") or ("walk" if not l.get("trainId") else "?"),
                         fromId=f.get("id"), fromName=f.get("name"), dep=(f.get("plannedDep") or f.get("expectedDep") or 0) // 1000,
                         expDep=(f.get("expectedDep") or 0) // 1000, toId=t.get("id"), toName=t.get("name"),
                         arr=(t.get("plannedArr") or t.get("expectedArr") or 0) // 1000, expArr=(t.get("expectedArr") or 0) // 1000,
                         quayDep=f.get("quay") or f.get("platform"), quayArr=t.get("quay") or t.get("platform")))
    dep = (j.get("plannedDeparture") or j.get("departure")) // 1000
    arr = (j.get("plannedArrival") or j.get("arrival")) // 1000
    return dict(id=j.get("id"), dep=dep, arr=arr, expDep=j.get("departure", 0) // 1000, expArr=j.get("arrival", 0) // 1000,
                transfers=j.get("transfers"), kind=j.get("kind"), uncertain=j.get("uncertain", False), fastest=j.get("fastest", False),
                legs=legs, modes=[l["cat"] for l in legs])


def fmt(x):
    if not x:
        return "none"
    return f"{hms(x['dep'], False)}->{hms(x['arr'], False)} {x['transfers']}ch [{' > '.join(m for m in x['modes'])}]"


def classify(twin, ref_all, twin_label, allow_walk, rec=None, validator=None):
    """Compare the twin's lexicographic best with the reference's; classify every difference with evidence.
    Walking is never 'a mode we do not load': a reference journey that needs a published footpath is a legal
    journey the twin must find. Only vehicle categories outside rail/EV are modes we do not load."""
    tb = min(twin, key=cost) if twin else None
    rb = min(ref_all, key=cost) if ref_all else None
    rl = [c for c in ref_all if loaded(c, True)]
    rbl = min(rl, key=cost) if rl else None
    ev = dict(twinBest=tb, refBest=rb, refBestLoadedModes=rbl)
    resolved_to = str(((rec or {}).get("ref") or {}).get("resolvedTo", {}).get("id"))
    resolved_from = str(((rec or {}).get("ref") or {}).get("resolvedFrom", {}).get("id"))
    if not tb and not rb:
        return "identical", "no route in either", ev
    if not tb:
        if not rbl:
            return "explained", f"reference only via modes we do not load ({','.join(sorted(set(rb['modes'])))})", ev
        return "unexplained", f"empty answer; reference {fmt(rbl)}", ev
    if not rb:
        return "check", "reference coverage: no reference connection (twin journey to validate)", ev
    target = rbl or rb
    dt = tb["arr"] - rb["arr"]
    ev["deltaArrSec"] = dt
    if 0 < abs(dt) < 60:
        return "explained", f"sub-minute difference {dt:+d}s (reference has minute resolution)", ev
    if dt == 0:
        if cost(tb) == cost(rb):
            return "identical", "same arrival, changes and departure", ev
        if cost(tb) < cost(rb):
            return "explained", f"same arrival; twin tuple better ({tb['transfers']}ch dep {hms(tb['dep'], False)} vs reference {rb['transfers']}ch dep {hms(rb['dep'], False)})", ev
        why = []
        if tb["transfers"] > rb["transfers"]:
            why.append(f"more changes ({tb['transfers']} vs {rb['transfers']})")
        elif tb["dep"] < rb["dep"]:
            why.append(f"earlier departure for the same arrival ({hms(tb['dep'], False)} vs {hms(rb['dep'], False)})")
        return "unexplained", "suboptimal ranking: " + ", ".join(why) + f"; twin {fmt(tb)} vs reference {fmt(rb)}", ev
    if dt > 0:  # twin later
        if rbl is not rb:
            mods = sorted(set(m for m in rb["modes"] if m not in RAIL and m not in EV and m != "walk"))
            if rbl is None or tb["arr"] <= rbl["arr"]:
                same = rbl is not None and cost(tb) == cost(rbl)
                return "explained", f"reference best uses modes we do not load ({','.join(mods)}); best rail/EV reference {fmt(rbl)}" + (" identical" if same else ""), ev
            rb = rbl
            dt = tb["arr"] - rb["arr"]
            ev["deltaArrSec"] = dt
            if dt == 0:
                return ("identical" if cost(tb) == cost(rb) else ("explained" if cost(tb) < cost(rb) else "unexplained")), \
                    f"vs best rail/EV reference (best overall uses {','.join(mods)}): twin {fmt(tb)} vs {fmt(rb)}", ev
        if str(rb["toStation"]["id"]) != resolved_to and rb["toStation"]["id"]:
            return "explained", f"different access point: reference ends at {rb['toStation']['name']} ({rb['toStation']['id']}), not the queried station; twin {fmt(tb)} vs reference {fmt(rb)}", ev
        if rb["forecastAffected"] and rb["schedArr"] is not None and tb["arr"] <= rb["schedArr"]:
            return "explained", "forecast difference (reference prognosis)", ev
        hint = ""
        if "walk" in rb["modes"]:
            hint = "; needs published footpaths " + "; ".join(f"{a}->{b} {d or '?'}s" for a, b, d in rb["walks"])
        return "unexplained", f"missed connection: twin {fmt(tb)} vs reference {fmt(rb)} ({dt:+d}s){hint}", ev
    return "check", f"twin earlier by {-dt}s: {fmt(tb)} vs reference {fmt(rb)}", ev


def judge(rec, label, walkers, validator, oracle=None):
    t = rec["twins"][label]
    js = t["byId"]["journeys"]
    conns = rec["ref"]["connections"]
    if rec["case"].get("maxTransfers") == 0:
        conns = [c_ for c_ in conns if c_["transfers"] == 0]  # transport.opendata.ch ignores direct=1
    v, why, ev = classify(js, conns, label, label in walkers, rec)
    if v == "check" and validator:
        raw = t["byId"].get("rawBest")
        tb = ev["twinBest"]
        res = validator(rec, label, tb)
        ev["validation"] = res
        if res and res.get("valid"):
            v, why = "explained", why + "; reference coverage: the twin witness validates against the published GTFS"
        else:
            v, why = "unexplained", why + "; impossible earlier route: " + "; ".join((res or {}).get("errors", ["not validated"]))
    # the independent oracle on the published GTFS (national rail/EV + footpaths) arbitrates every disagreement
    if oracle is not None:
        o = oracle(rec)
        ev["oracle"] = o
        tb = ev.get("twinBest")
        tt = (tb["arr"], tb["transfers"], -tb["dep"]) if tb else None
        ot = (o["arr"], o["changes"], -o["dep"]) if o and o.get("found") else None
        t["oracleAgrees"] = tt == ot
        if v in ("unexplained", "check") and tt == ot:
            v, why = "explained", "oracle (published GTFS) agrees with the twin: " + (o.get("summary") or "no route") + "; reference differs (MOTIS transfer times/footpaths/access, not the published rules) | " + why
        elif v == "check" and ot is not None and tt is not None and tt > ot:
            v, why = "unexplained", "oracle finds better: " + o.get("summary", "") + " | " + why
        elif v in ("unexplained",) and ot is not None and tt is not None and tt > ot:
            why = "oracle confirms the twin is suboptimal: " + o.get("summary", "") + " | " + why
        elif v in ("unexplained",) and ot is None and tt is None:
            v, why = "explained", "oracle (published GTFS, rail/EV + footpaths) finds no route either | " + why
    t["verdict"], t["why"], t["evidence"] = v, why, ev
    return v


def raw_journeys(rec, label, rawdir):
    i = rec.get("index")
    import gzip
    fn = os.path.join(rawdir, label, f"{i:03d}-byId.json.gz")
    if not os.path.exists(fn):
        return []
    with gzip.open(fn, "rt") as f:
        return (json.load(f).get("body") or {}).get("journeys", [])


def reclassify(path, walkers, do_validate=True):
    from validate import validate, national
    from oracle import Network, summary as osum
    d = json.load(open(path))
    rawdir = os.path.join(RESULTS, "gate_a", "raw", d["summary"]["runid"])
    net = national() if do_validate else None
    onet = Network(None, ["20261121", "20261122", "20261123"], modes="railev")
    ocache = {}

    def oracle(rec):
        o = str(rec["ref"]["resolvedFrom"]["id"] or rec["case"]["frm"])
        de = str(rec["ref"]["resolvedTo"]["id"] or rec["case"]["to"])
        cap = rec["case"].get("maxTransfers")
        k = (o, de, rec["T"], cap)
        if k not in ocache:
            r = onet.query(o, de, rec["T"], max_transfers=3 if cap is None else cap)
            ocache[k] = dict(found=r["found"], arr=r.get("arr"), changes=r.get("changes"), dep=r.get("dep"), summary=osum(r), frontier=r.get("frontier"))
        return ocache[k]
    invalid = {}
    for i, rec in enumerate(d["results"]):
        rec.setdefault("index", i)
        for label in rec["twins"]:
            raws = raw_journeys(rec, label, rawdir)
            T = rec["T"]
            o = str(rec["ref"]["resolvedFrom"]["id"] or rec["case"]["frm"])
            de = str(rec["ref"]["resolvedTo"]["id"] or rec["case"]["to"])
            vals = []
            for j in raws:
                r = validate(j, o, de, T, net=net) if net else None
                vals.append(dict(dep=(j.get("plannedDeparture") or 0) // 1000, arr=(j.get("plannedArrival") or 0) // 1000, valid=r["valid"] if r else None,
                                 errors=r["errors"] if r else [], lines=[l.get("line") for l in j.get("legs", [])]))
            rec["twins"][label]["validation"] = vals
            def validator(rec_, label_, tb, vals=vals):
                for v in vals:
                    if tb and v["dep"] == tb["dep"] and v["arr"] == tb["arr"]:
                        return v
                return None
            judge(rec, label, walkers, validator if net else None, oracle)
            bad = [v for v in vals if v["valid"] is False]
            invalid[label] = invalid.get(label, 0) + len(bad)
    for label in d["summary"]["twins"]:
        cnt = {}
        for r in d["results"]:
            v = r["twins"][label]["verdict"]
            cnt[v] = cnt.get(v, 0) + 1
        d["summary"]["twins"][label]["counts"] = cnt
        d["summary"]["twins"][label]["invalidJourneys"] = invalid.get(label, 0)
        d["summary"]["twins"][label]["journeysValidated"] = sum(len(r["twins"][label].get("validation", [])) for r in d["results"])
        d["summary"]["twins"][label]["oracleAgrees"] = sum(1 for r in d["results"] if r["twins"][label].get("oracleAgrees"))
    dump(path, d)
    print(json.dumps(d["summary"], indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reclassify", default="")
    ap.add_argument("--twin", action="append", default=[], help="label=baseurl")
    ap.add_argument("--day", default=datetime.now(Z).strftime("%Y-%m-%d"))
    ap.add_argument("--times", default="09:37,12:04,16:58,19:33,23:20")
    ap.add_argument("--eligibility", default="scheduled", choices=["scheduled", "expected"])
    ap.add_argument("--allow-walk", default="", help="labels whose planner models footpaths (comma list)")
    ap.add_argument("--out", default=os.path.join(RESULTS, "gate_a.json"))
    ap.add_argument("--only", default="", help="substring filter on 'from>to' for quick reruns")
    a = ap.parse_args()
    twins = dict(t.split("=", 1) for t in a.twin)
    walkers = set(x for x in a.allow_walk.split(",") if x)
    if a.reclassify:
        return reclassify(a.reclassify, walkers)
    times = [h for h in a.times.split(",") if local_epoch(a.day, h) >= time.time() + 300]  # past times: live state, skipped
    runid = datetime.now(Z).strftime("%Y%m%dT%H%M")
    refcache = os.path.join(RESULTS, "gate_a", "ref")
    rawdir = os.path.join(RESULTS, "gate_a", "raw", runid)
    cases = []
    for t in times:
        for f, to in PAIRS30:
            cases.append(dict(frm=f, to=to, time=t, tag="od30", maxTransfers=None))
        for f, to, why in EXTRA:
            cases.append(dict(frm=f, to=to, time=t, tag=why.split(":")[0], note=why, maxTransfers=None))
    for f, to in ZERO:
        for t in times[:2] + times[-1:]:
            cases.append(dict(frm=f, to=to, time=t, tag="zero-change", maxTransfers=0))
    for f, to, t in MIDNIGHT:
        cases.append(dict(frm=f, to=to, time=t, tag="midnight", maxTransfers=None))
    if a.only:
        cases = [c for c in cases if a.only in f"{c['frm']}>{c['to']}"]
    t_start = time.time()
    out = []
    for i, c in enumerate(cases):
        T = local_epoch(a.day, c["time"])
        pages, conns, body = fetch_ref(c["frm"], c["to"], a.day, c["time"], c["maxTransfers"] == 0, refcache)
        rq = [ref_conn(x, a.eligibility) for x in conns]
        seen, ref_all = set(), []
        for x in rq:  # pages overlap: dedupe by legs
            k = (x["schedDep"], x["schedArr"], tuple((l["number"], l["dep"]) for l in x["legs"]))
            if k in seen:
                continue
            seen.add(k)
            if x["dep"] is not None and x["dep"] >= T:  # origin eligibility on the twin's clock
                ref_all.append(x)
        refFrom = (body.get("from") or {}) if body else {}
        refTo = (body.get("to") or {}) if body else {}
        rec = dict(index=i, case=c, T=T, Tlocal=f"{a.day} {c['time']}", ref=dict(pages=pages, queriedFrom=c["frm"], queriedTo=c["to"],
                   resolvedFrom=dict(id=refFrom.get("id"), name=refFrom.get("name")), resolvedTo=dict(id=refTo.get("id"), name=refTo.get("name")),
                   eligible=len(ref_all), returned=len(rq), connections=ref_all), twins={})
        for label, base in twins.items():
            res = {}
            for how, (qf, qt) in (("byId", (refFrom.get("id") or c["frm"], refTo.get("id") or c["to"])), ("byName", (c["frm"], c["to"]))):
                q = {"from": qf, "to": qt, "after": T * 1000, "limit": 6}
                if c["maxTransfers"] is not None:
                    q["maxTransfers"] = c["maxTransfers"]
                url = f"{base}/api/plan?{urllib.parse.urlencode(q)}"
                t0 = time.time()
                try:
                    status, body_t = get_json(url, timeout=60)
                except Exception as e:
                    status, body_t = 0, {"error": str(e)}
                ms = int((time.time() - t0) * 1000)
                save_raw(os.path.join(rawdir, label, f"{i:03d}-{how}.json.gz"), dict(url=url, status=status, ms=ms, at=datetime.now(Z).isoformat(), body=body_t))
                js = [twin_journey(j) for j in (body_t or {}).get("journeys", [])] if status == 200 else []
                early = [j for j in js if j["dep"] < T]  # a journey leaving before the query time is itself a defect
                js = [j for j in js if j["dep"] >= T]
                res[how] = dict(url=url, status=status, ms=ms, error=(body_t or {}).get("error") if status != 200 else None,
                                resolvedFrom=(body_t or {}).get("from"), resolvedTo=(body_t or {}).get("to"),
                                snapshotId=(body_t or {}).get("snapshotId"), journeys=js, departsBeforeQuery=early)
            nm = res["byName"]
            resolver_ok = nm["resolvedTo"] is not None and str((nm["resolvedTo"] or {}).get("id")) == str(refTo.get("id")) and \
                str((nm["resolvedFrom"] or {}).get("id")) == str(refFrom.get("id"))
            rec["twins"][label] = dict(byId=res["byId"], byName=dict(url=nm["url"], status=nm["status"], resolvedFrom=nm["resolvedFrom"],
                                       resolvedTo=nm["resolvedTo"], best=min(nm["journeys"], key=cost) if nm["journeys"] else None),
                                       resolverAgrees=resolver_ok)
            judge(rec, label, walkers, None)
        out.append(rec)
        line = " | ".join(f"{lb}: {r['verdict']}" for lb, r in rec["twins"].items())
        print(f"[{i+1}/{len(cases)}] {c['time']} {c['frm']} > {c['to']} {c.get('tag')}: ref {fmt(min(ref_all, key=cost) if ref_all else None)} | {line}", flush=True)
    finished = time.time()
    earliest = min(local_epoch(a.day, t) for t in times)
    # lead time is a property of the reference fetch (cached responses are reused for later twins)
    lead = []
    for r in out:
        fs = [datetime.fromisoformat(p_["fetchedAt"]).timestamp() for p_ in r["ref"]["pages"] if p_.get("fetchedAt")]
        if fs:
            lead.append(r["T"] - max(fs))
    summary = dict(runid=runid, day=a.day, times=times, eligibility=a.eligibility, cases=len(out), startedAt=t_start, finishedAt=finished,
                   minLeadMinAtFinish=round((earliest - finished) / 60, 1), minRefLeadMin=round(min(lead) / 60, 1) if lead else None,
                   leadOk=bool(lead) and min(lead) >= 1800, twins={})
    for label in twins:
        cnt = {}
        for r in out:
            v = r["twins"][label]["verdict"]
            cnt[v] = cnt.get(v, 0) + 1
        summary["twins"][label] = dict(counts=cnt, resolverDisagreements=sum(not r["twins"][label]["resolverAgrees"] for r in out))
    dump(a.out, dict(summary=summary, results=out))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
