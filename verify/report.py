# Results tables per gate (before = main, after = feat/planner-exact) -> README.md between the RESULTS markers,
# and verify/results/summary.json with the one-line summary.
#   python verify/report.py
import json, os, re, subprocess, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, Z, dump  # noqa: E402

def after_dir():
    f = os.path.join(HERE, ".cache", "after_dir")
    return open(f).read().strip() if os.path.exists(f) else "/workspace/rail-twin-verify-after"


COMMITS = {"before": "/workspace/rail-twin", "after": after_dir()}


def load(n):
    p = os.path.join(RESULTS, n)
    return json.load(open(p)) if os.path.exists(p) else None


def commit(tag):
    return subprocess.run(["git", "-C", COMMITS[tag], "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()


def gate_a(tag):
    A = load(f"gate_a-{tag}.json")
    if not A:
        return None
    s = A["summary"]["twins"][tag]
    c = s["counts"]
    return dict(cases=A["summary"]["cases"], identical=c.get("identical", 0), explained=c.get("explained", 0), unexplained=c.get("unexplained", 0) + c.get("check", 0),
                oracleAgrees=s.get("oracleAgrees"), invalid=s.get("invalidJourneys"), validated=s.get("journeysValidated"), resolver=s.get("resolverDisagreements"),
                lead=A["summary"].get("minRefLeadMin"))


def gate_b(tag):
    B = load(f"gate_b-{tag}.json")
    if not B:
        return None
    ran = datetime.fromisoformat(B["summary"]["generatedAt"]).timestamp()
    fut = [r for r in B["results"] if r["T"] >= ran - 300 and tag in r["twins"]]
    agree = sum(r["twins"][tag]["verdict"] == "agree" for r in fut)
    cnt = {}
    for r in fut:
        v = r["twins"][tag]["verdict"]
        cnt[v] = cnt.get(v, 0) + 1
    inv = sum(r["twins"][tag]["invalid"] for r in fut)
    nj = sum(len(r["twins"][tag]["journeys"]) for r in fut)
    return dict(cases=len(fut), agree=agree, counts=cnt, invalid=inv, journeys=nj, excludedPast=len(B["results"]) - len(fut))


def gate_d(tag):
    from failures import posthoc_ok
    from common import hms
    Dd = load(f"gate_d-{tag}.json")
    if not Dd:
        return None
    k = dict(stages=0, agree=0, plannerMiss=0, invalidCertain=0, projectionDiff=0, outsideRegion=0, otherToCheck=0, invRemove=0, invBus=0, invCaps=0, invalidJourneys=0)
    for r in Dd["results"]:
        for name, v in r.get("checks", {}).items():
            if "oracleVerdict" in v:
                vv = v["oracleVerdict"]
                k["stages"] += 1
                k["invalidJourneys"] += len(v.get("invalid", []))
                pc = v["planner"]["bestConfirmed"]
                outside = pc and [hms(-pc[2], False), hms(pc[0], False)] in (v.get("unjudged") or {}).get("journeys", [])
                if vv == "agree":
                    k["agree"] += 1
                elif vv.endswith(":planner-miss"):
                    k["plannerMiss"] += 1
                elif vv == "fail-invalid-certain":
                    k["invalidCertain"] += 1
                elif "projection-diff" in vv:
                    k["projectionDiff"] += 1
                elif vv.endswith("outside-region") or (vv in ("planner-only", "planner-better") and outside):
                    k["outsideRegion"] += 1
                elif vv == "planner-better" and pc and v["oracleConfirmed"]["t"] and 0 <= v["oracleConfirmed"]["t"][0] - pc[0] <= 30 and "EV" in str(v["planner"]["journeys"]):
                    k["projectionDiff"] += 1  # bus timing rounding
                else:
                    k["otherToCheck"] += 1
            elif "ok" in v and not v["ok"] and not posthoc_ok(name, v, r):
                key = {"inv_remove": "invRemove", "inv_addbus": "invBus", "inv_caps": "invCaps"}.get(name)
                if key:
                    k[key] += 1
    return dict(cases=Dd["summary"]["cases"], errors=Dd["summary"].get("errors", 0), **k)


def gate_e(tag):
    E = load("gate_e.json")
    if not E or tag not in E.get("summary", {}):
        return None
    s = E["summary"][tag]
    return dict(W1=s["W1"], W1violations=s["W1violations"], W2=s["W2"], W2offered=s.get("W2offered"))


def main():
    rows = {t: dict(commit=commit(t), A=gate_a(t), B=gate_b(t), D=gate_d(t), E=gate_e(t)) for t in ("before", "after")}
    L = []
    L.append(f"Generated {datetime.now(Z):%Y-%m-%d %H:%M} (Swiss time). before = `main` @ `{rows['before']['commit']}`, after = `feat/planner-exact` @ `{rows['after']['commit']}`.\n")
    L.append("**Gate A, external differential (transport.opendata.ch, static timetable, scheduled-to-scheduled in seconds, every disagreement arbitrated by the oracle)**\n")
    L.append("| | cases | identical | explained | unexplained | oracle agrees with planner | invalid journeys (Gate C) | name resolver disagreements |")
    L.append("|---|---|---|---|---|---|---|---|")
    for t in ("before", "after"):
        a = rows[t]["A"]
        if a:
            L.append(f"| {t} | {a['cases']} | {a['identical']} | {a['explained']} | {a['unexplained']} | {a['oracleAgrees']}/{a['cases']} | {a['invalid']}/{a['validated']} | {a['resolver']} |")
    L.append("\n**Gate B, independent oracle (4 regional subnetworks, rail + EV + published footpaths, departure times still in the future, caps 3/1/0)**\n")
    L.append("| | cases | exact agreement (arrival, changes, departure) | failures by verdict | invalid journeys (Gate C) |")
    L.append("|---|---|---|---|---|")
    for t in ("before", "after"):
        b = rows[t]["B"]
        if b:
            f = ", ".join(f"{k} {v}" for k, v in sorted(b["counts"].items()) if k != "agree") or "none"
            L.append(f"| {t} | {b['cases']} | {b['agree']}/{b['cases']} | {f} | {b['invalid']}/{b['journeys']} |")
    L.append("\n**Gate D, seeded disruptions (closures, short turns, holds, UNTIL / UNTIL_AT_LEAST / UNKNOWN, added buses), oracle on our own projection of the record**\n")
    L.append("| | cases (stages) | oracle agreement | planner misses | certain journey invalid under the closure | projection differences (not counted) | certain detours outside the oracle region | other to check | invariant failures (remove / add bus / caps) | harness errors |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for t in ("before", "after"):
        d = rows[t]["D"]
        if d:
            L.append(f"| {t} | {d['cases']} ({d['stages']}) | {d['agree']}/{d['stages']} | {d['plannerMiss']} | {d['invalidCertain']} | {d['projectionDiff']} | {d['outsideRegion']} | {d['otherToCheck']} | {d['invRemove']} / {d['invBus']} / {d['invCaps']} | {d['errors']} |")
    L.append("\n**Gate E, Wädenswil replay (10 Sep 2026), observed witnesses**\n")
    L.append("| | W1: S8 18823 never crosses before the reopening, no certain crossing | W2: S8 18839 admitted after the 11:00 partial reopening |")
    L.append("|---|---|---|")
    for t in ("before", "after"):
        e = rows[t]["E"]
        if e:
            w2 = e["W2offered"][0] if e.get("W2offered") else None
            w2s = f"pass ({w2['leg']}, arrival error vs REAL {w2['arrErrorSec']:+d} s)" if e["W2"] and w2 and w2.get("arrErrorSec") is not None else ("pass" if e["W2"] else "FAIL")
            L.append(f"| {t} | {'pass' if e['W1'] else 'FAIL'} ({e['W1violations']} violations) | {w2s} |")
    md = "\n".join(L)
    a, b, d, e = rows["after"]["A"], rows["after"]["B"], rows["after"]["D"], rows["after"]["E"]
    parts = []
    if a:
        parts.append(f"A: {a['identical']}/{a['cases']} identical, {a['explained']} explained, {a['unexplained']} unexplained (oracle agrees {a['oracleAgrees']}/{a['cases']})")
    if b:
        parts.append(f"B: {b['agree']}/{b['cases']} oracle agreement")
    if a and b:
        parts.append(f"C: {a['invalid'] + b['invalid']} invalid of {a['validated'] + b['journeys']} journeys")
    if d:
        parts.append(f"D: {d['cases']} seeded cases ({d['stages']} stages), {d['plannerMiss'] + d['invalidCertain']} oracle mismatches, {d['invRemove'] + d['invBus'] + d['invCaps']} invariant failures ({d['agree']} exact agreements, {d['outsideRegion']} detours outside the oracle region, {d['projectionDiff']} projection differences, {d['otherToCheck']} to check)")
    if e:
        parts.append(f"E: {int(bool(e['W1'])) + int(bool(e['W2']))}/2 witnesses")
    line = "; ".join(parts)
    dump(os.path.join(RESULTS, "summary.json"), dict(generatedAt=datetime.now(Z).isoformat(), summaryAfter=line, rows=rows))
    p = os.path.join(HERE, "README.md")
    if os.path.exists(p):
        s = open(p).read()
        s = re.sub(r"<!-- RESULTS -->.*<!-- /RESULTS -->", "<!-- RESULTS -->\n" + md + "\n\n**Summary (after):** " + line + "\n<!-- /RESULTS -->", s, flags=re.S)
        open(p, "w").write(s)
    print(line)


if __name__ == "__main__":
    main()
