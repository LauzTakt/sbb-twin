# Failing cases of the "after" runs grouped by cause, with concrete examples (OD, time, planner answer,
# oracle/reference answer, why) -> verify/results/failures-<tag>.json, plus a one-line count summary.
#   python verify/failures.py [--tag after]
import argparse, json, os, re, subprocess, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, Z, dump, hms  # noqa: E402

LATE = ("19:33", "20:44", "22:31", "23:20", "23:47", "23:50", "23:55", "23:58")


def load(name):
    p = os.path.join(RESULTS, name)
    return json.load(open(p)) if os.path.exists(p) else None


def err_cause(e):
    if re.search(r"change .* < required", e):
        return "transfer rule (shorter than the published minimum)"
    if "no published footpath" in e:
        return "transfer rule (change between stations without a published footpath)"
    if "drop_off_type" in e or "pickup_type" in e:
        return "boarding/alighting not allowed (pickup/drop-off)"
    if e.startswith("reported") and "changes" in e:
        return "ranking (change count reported wrong, e.g. in-seat continuation counted)"
    if "not a bus of the projected measure" in e:
        return "measure projection difference (bus timing)"
    if "rides past its short-turn" in e or "crosses closed" in e:
        return "closure crossing"
    if "before the query time" in e:
        return "invalid witness (leaves before the query time)"
    if "not the origin" in e or "not the destination" in e or "egress" in e:
        return "endpoint (witness does not start/end at the requested station)"
    return "invalid witness (call/time not in the published timetable)"


def witness_cause(wit, T_local):
    """Why did the planner miss the oracle's witness? walks / short transfers / horizon / plain miss."""
    wit = wit or []
    if any(x.get("walk") for x in wit):
        return "missed walk link (published footpath to/from a bus stop or station)"
    tr = [x for x in wit if x.get("transfer")]
    if any(x.get("at") and x.get("to") and x["at"].split(":")[3:4] != x["to"].split(":")[3:4] for x in tr):
        return "missed walk link (change between stations)"
    # a published short minimum used with little slack (e.g. Spiez 120 s): the planner likely applies a longer one
    rides = [x for x in wit if "trip" in x]
    for i, x in enumerate(wit):
        if x.get("transfer") and 0 < i < len(wit) - 1:
            prev = next((w for w in reversed(wit[:i]) if "trip" in w), None)
            nxt = next((w for w in wit[i + 1:] if "trip" in w), None)
            if prev and nxt and (x.get("minSecs") or 999) < 240 and nxt["dep"] - prev["arr"] < 240:
                return "transfer rule (published short transfer rejected)"
    if T_local in LATE:
        return "horizon (late evening / overnight)"
    return "missed connection"


def posthoc_ok(k, v, r):
    """Earlier runs judged the invariants on any class; recompute on the confirmed class (holds retime rides)."""
    if k == "inv_caps" and "detail" in v and "bestConfirmedArrByCap" not in v:
        conf = [x for x in v["detail"] if not x["uncertain"]]
        return all(a["best"] is None or b["best"] is not None for a, b in zip(conf, conf[1:])) and any(x["uncertain"] for x in v["detail"])
    if k == "inv_remove" and "applicable" not in v:
        st = r["checks"].get("closure") or {}
        holds = (st.get("projection") or {}).get("holds", 0)
        pc = (st.get("planner") or {}).get("bestConfirmed")
        return holds > 0 or pc is None or v.get("before") is None or pc[0] >= v["before"][0]
    return False


def add(groups, cause, ex):
    g = groups.setdefault(cause, dict(count=0, examples=[]))
    g["count"] += 1
    if len(g["examples"]) < 3:
        g["examples"].append(ex)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="after")
    a = ap.parse_args()
    tag = a.tag
    groups, explained, totals = {}, {}, {}
    # ---- Gate A ----
    A = load(f"gate_a-{tag}.json")
    if A:
        n_inv = 0
        for r in A["results"]:
            c, t = r["case"], r["twins"].get(tag)
            if not t:
                continue
            od = f"{c['frm']} > {c['to']}" + (f" (maxTransfers={c['maxTransfers']})" if c.get("maxTransfers") is not None else "")
            ev = t.get("evidence") or {}
            fmt = lambda x: "none" if not x else f"{hms(x['dep'], False)}->{hms(x['arr'], False)} {x['transfers']}ch [{' > '.join(x['modes'])}]"
            ex = dict(gate="A", od=od, time=c["time"], planner=fmt(ev.get("twinBest")), reference=fmt(ev.get("refBest")), why=t["why"][:400])
            if t["verdict"] == "unexplained":
                w = t["why"]
                if w.startswith("empty answer"):
                    cause = "horizon (late evening / overnight)" if c["time"] in LATE else ("missed walk link (published footpath to/from a bus stop or station)" if "walk" in str((ev.get("refBest") or {}).get("modes")) else "empty answer")
                elif w.startswith("missed connection"):
                    cause = "missed walk link (published footpath to/from a bus stop or station)" if "footpath" in w else ("horizon (late evening / overnight)" if c["time"] in LATE else "missed connection")
                elif w.startswith("suboptimal ranking") or "vs best rail/EV reference" in w:
                    cause = "ranking (same arrival: more changes or earlier departure)"
                elif "impossible earlier route" in w:
                    cause = "invalid witness (earlier than the reference and fails validation)"
                else:
                    cause = "other"
                add(groups, cause, ex)
            elif t["verdict"] == "explained":
                k = re.sub(r"[(:;].*", "", t["why"]).strip()[:60]
                explained[k] = explained.get(k, 0) + 1
            if not t.get("resolverAgrees", True):
                bn = t.get("byName") or {}
                add(groups, "endpoint resolution (by name differs from the reference station)",
                    dict(gate="A", od=od, time=c["time"], planner=f"{(bn.get('resolvedFrom') or {}).get('name')} ({(bn.get('resolvedFrom') or {}).get('id')}) -> {(bn.get('resolvedTo') or {}).get('name')} ({(bn.get('resolvedTo') or {}).get('id')})",
                         reference=f"{r['ref']['resolvedFrom'].get('name')} ({r['ref']['resolvedFrom'].get('id')}) -> {r['ref']['resolvedTo'].get('name')} ({r['ref']['resolvedTo'].get('id')})", why="name resolution"))
            for v in t.get("validation", []):
                if v.get("valid") is False:
                    n_inv += 1
                    add(groups, "Gate C: " + err_cause(v["errors"][0]), dict(gate="A/C", od=od, time=c["time"], planner=f"{hms(v['dep'], False)}->{hms(v['arr'], False)} {v['lines']}", reference="published GTFS", why="; ".join(v["errors"])[:400]))
        s = A["summary"]["twins"].get(tag, {})
        totals["A"] = dict(cases=A["summary"]["cases"], **s.get("counts", {}), invalidJourneys=s.get("invalidJourneys"), journeysValidated=s.get("journeysValidated"),
                           resolverDisagreements=s.get("resolverDisagreements"))
    # ---- Gate B ----
    B = load(f"gate_b-{tag}.json")
    if B:
        ran = datetime.fromisoformat(B["summary"]["generatedAt"]).timestamp()
        past = 0
        for r in B["results"]:
            t = r["twins"].get(tag)
            if not t:
                continue
            if r["T"] < ran - 300:  # queried after its departure time: the live state has those trains as gone
                past += 1
                if t["verdict"] != "agree":
                    explained["B past departure time (live state), excluded"] = explained.get("B past departure time (live state), excluded", 0) + 1
                continue
            od = f"{r['frm']} > {r['to']}" + (f" (maxTransfers={r['maxTransfers']})" if r["maxTransfers"] != 3 else "")
            js = t.get("journeys") or []
            best = min(js, key=lambda j: (j["arr"], j["changes"])) if js else None
            ex = dict(gate="B", od=od, time=r["time"], planner=(f"{best['dep']}->{best['arr']} {best['changes']}ch {best['lines']}" if best else "none"),
                      oracle=r["oracle"]["summary"], why=t["why"][:300])
            v = t["verdict"]
            if v in ("fail-later", "fail-empty"):
                add(groups, witness_cause(r["oracle"].get("witness"), r["time"]), ex)
            elif v in ("fail-changes", "fail-departure"):
                add(groups, "ranking (same arrival: more changes or earlier departure)", ex)
            elif v == "fail-cap":
                add(groups, "maxTransfers cap exceeded", ex)
            elif v == "fail-invalid":
                add(groups, "invalid witness (better than the oracle but fails validation)", ex)
            elif v == "oracle-miss":
                add(groups, "oracle disagreement to check (planner better and valid)", ex)
            for j in js:
                if not j["valid"]:
                    add(groups, "Gate C: " + err_cause(j["errors"][0]), dict(gate="B/C", od=od, time=r["time"], planner=f"{j['dep']}->{j['arr']} {j['changes']}ch {j['lines']}", oracle="published GTFS", why="; ".join(j["errors"])[:400]))
        fut = [r for r in B["results"] if r["T"] >= ran - 300 and tag in r["twins"]]
        totals["B"] = dict(cases=B["summary"]["cases"], futureCases=len(fut), futureAgree=sum(r["twins"][tag]["verdict"] == "agree" for r in fut),
                           pastCasesExcluded=past, **B["summary"]["counts"].get(tag, {}), invalidJourneys=B["summary"]["invalid"].get(tag), journeys=B["summary"]["journeys"].get(tag))
    # ---- Gate D ----
    Dd = load(f"gate_d-{tag}.json")
    if Dd:
        for r in Dd["results"]:
            c = r["case"]
            od = f"{c['od'][0]} > {c['od'][1]}"
            scen = f"closure {c['section'][0]}-{c['section'][1]} {c['durationType']} {c['minutes']}m measures={[m['type'] + ':' + m['at'] for m in c['measures']]}" + (" +bus" if c.get("addBus") else "")
            if r.get("error"):
                add(groups, "harness error", dict(gate="D", od=od, time=c["Tlocal"], scenario=scen, why=r["error"][:200]))
                continue
            for k, v in r["checks"].items():
                if "oracleVerdict" in v:
                    vv = v["oracleVerdict"]
                    pc = v["planner"]["bestConfirmed"]
                    ex = dict(gate="D", od=od, time=c["Tlocal"], scenario=scen, stage=k, planner=("none" if not pc else f"{hms(-pc[2], False)}->{hms(pc[0], False)} {pc[1]}ch"),
                              oracle=v["oracleConfirmed"]["s"], why=v["why"][:300])
                    if vv.endswith(":planner-miss"):
                        cause = witness_cause(v["oracleConfirmed"].get("witness"), c["Tlocal"])
                        if cause == "missed connection":
                            cause = "missed connection under measures (every witness train runs in the twin at our times)"
                        add(groups, "D: " + cause + " (under measures)", dict(ex, probes=(v.get("attribution") or {}).get("probes")))
                    elif vv.endswith(":projection-diff"):
                        explained["D projection difference (twin measure effect differs from the documented contract)"] = explained.get("D projection difference (twin measure effect differs from the documented contract)", 0) + 1
                        add(groups, "measure projection difference (not counted as a planner failure)", dict(ex, probes=(v.get("attribution") or {}).get("probes")))
                    elif vv == "fail-invalid-certain":
                        add(groups, "closure crossing (certain journey invalid under the closure)", ex)
                    elif vv == "planner-better" and v["planner"]["bestConfirmed"] and v["oracleConfirmed"]["t"] and \
                            0 <= v["oracleConfirmed"]["t"][0] - v["planner"]["bestConfirmed"][0] <= 30 and "EV" in str(v["planner"]["journeys"]):
                        explained["D bus timing rounding (<= 30 s)"] = explained.get("D bus timing rounding (<= 30 s)", 0) + 1
                    elif vv in ("planner-better", "planner-only"):
                        pc_ = v["planner"]["bestConfirmed"]
                        outside = pc_ and [hms(-pc_[2], False), hms(pc_[0], False)] in (v.get("unjudged") or {}).get("journeys", [])
                        if outside:
                            explained["D planner certain detour via stations outside the oracle region"] = explained.get("D planner certain detour via stations outside the oracle region", 0) + 1
                        else:
                            add(groups, "oracle disagreement to check (planner better/only and valid)", ex)
                    elif vv in ("planner-better-outside-region", "planner-only-outside-region"):
                        explained["D planner certain detour via stations outside the oracle region"] = explained.get("D planner certain detour via stations outside the oracle region", 0) + 1
                    elif vv == "projection-diff-planner-side":
                        add(groups, "measure projection difference (not counted as a planner failure)", ex)
                    elif vv == "planner-better-outside-region":
                        explained["D planner better via stations outside the oracle region"] = explained.get("D planner better via stations outside the oracle region", 0) + 1
                    for iv in v.get("invalid", []):
                        cause = err_cause(iv["errors"][0])
                        e0 = iv["errors"][0]
                        if "nearest" in e0:
                            cause = "measure projection difference (twin retimes/holds a train differently from the contract)"
                        elif "not in the published timetable" in cause or "call/time" in cause:
                            cause = "closure crossing or cancelled call (journey uses a call our projection cuts/holds)" if not iv["uncertain"] else "uncertain journey uses a call our conditional projection cuts"
                        add(groups, "Gate C under measures: " + cause, dict(gate="D/C", od=od, time=c["Tlocal"], scenario=scen, planner=f"{iv['dep']}->{iv['arr']} {iv['lines']}{' (uncertain)' if iv['uncertain'] else ''}", why="; ".join(iv["errors"])[:300]))
                elif "ok" in v and not v["ok"] and not posthoc_ok(k, v, r):
                    name = {"inv_remove": "invariant: a closure improved the planner's optimum", "inv_addbus": "invariant: adding a bus worsened the optimum",
                            "inv_caps": "invariant: a higher maxTransfers gave a worse optimum"}.get(k, k)
                    add(groups, name, dict(gate="D", od=od, time=c["Tlocal"], scenario=scen, evidence={x: y for x, y in v.items() if x != "ok"}))
        totals["D"] = dict(Dd["summary"])
    # ---- Gate E ----
    E = load("gate_e.json")
    if E and tag in E.get("results", {}):
        res = E["results"][tag]
        for x in res["W1"]["violations"][:20]:
            add(groups, "closure crossing (Wädenswil replay W1)", dict(gate="E", od=x["od"], time=x["snapshot"], planner=x["leg"], why=x["why"]))
        if not res["W2"]["pass_"]:
            add(groups, "replay: S8 18839 not admitted after the 11:00 partial reopening (W2)", dict(gate="E", why="no journey with S8 18839 Wädenswil -> Pfäffikon SZ"))
        totals["E"] = E["summary"].get(tag)
    f = os.path.join(HERE, ".cache", "after_dir")
    adir = open(f).read().strip() if os.path.exists(f) else "/workspace/rail-twin-verify-after"
    commit = subprocess.run(["git", "-C", adir if tag == "after" else "/workspace/rail-twin", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    order = sorted(groups.items(), key=lambda kv: -kv[1]["count"])
    out = dict(tag=tag, plannerCommit=commit, generatedAt=datetime.now(Z).isoformat(), totals=totals,
               counts={k: v["count"] for k, v in order}, explained=explained, causes=dict(order))
    dump(os.path.join(RESULTS, f"failures-{tag}.json"), out)
    print(f"[{datetime.now(Z):%H:%M}] failures-{tag} @{commit}: " + "; ".join(f"{k}: {v['count']}" for k, v in order[:12]))


if __name__ == "__main__":
    main()
