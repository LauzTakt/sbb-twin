#!/opt/venv/bin/python
"""Run the parity checks between the TypeScript twin (reference) and the Kotlin twin.

  run_all.py                       day checks (08:00), night plan (23:30), scenario flows, Wädenswil replay
  run_all.py --only plan,boards    named groups: static stations boards trains plan journeys geometry brief scenario night replay
  run_all.py --kt ts               validate the harness: second TypeScript instance instead of Kotlin
"""
import argparse, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib, checks
from lib import *

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma list of groups")
    ap.add_argument("--kt", default="kt", choices=["kt", "ts"], help="what to compare the TS twin with (ts = harness self-test)")
    ap.add_argument("--jar", default=lib.JAR)
    ap.add_argument("--ts-dir", default=lib.TS_DIR)
    ap.add_argument("--ts-port", type=int, default=0, help="8800-8899 (default: random free)")
    ap.add_argument("--kt-port", type=int, default=0, help="8900-8999 (default: random free)")
    ap.add_argument("--replay-times", default="05:50,07:20,09:00", help="virtual times of day (2026-09-10) to compare in the replay, e.g. 05:50,07:20,11:05,15:30")
    ap.add_argument("--out", default=os.path.join(lib.HERE, "REPORT.md"))
    a = ap.parse_args()
    lib.JAR, lib.TS_DIR = a.jar, a.ts_dir
    groups = set(filter(None, a.only.split(",")))
    want = lambda g: not groups or g in groups
    rows = []
    def phase(name, fn, tt=1500, **pkw):
        try:
            p = start_pair(a.kt, jar_port=a.kt_port or None, **pkw)
        except Exception as e:
            rows.append((f"{name}: start", "differs", f"could not start instances: {e}")); return
        print(f"[{name}] ts :{p.a.port} {a.kt} :{p.b.port}; clock offset b-a = {p.b.virtual() - p.a.virtual():.0f} ms", flush=True)
        ctx = checks.Ctx(p, time_tol=tt)
        try: fn(ctx)
        except Exception: ctx.fail(f"{name} (harness error)", traceback.format_exc()[-300:])
        finally: p.stop()
        rows.extend(ctx.rows())

    def guarded(ctx, name, f, *args):
        try: return f(ctx, *args)
        except Exception: ctx.fail(name, traceback.format_exc()[-300:])

    day_groups = {"static", "stations", "boards", "trains", "plan", "journeys", "geometry", "brief", "scenario"}
    if groups == set() or groups & day_groups:
        def day(ctx):
            sample, ids = None, []
            if want("static"): guarded(ctx, "static", checks.check_static)
            if want("stations"): guarded(ctx, "stations", checks.check_stations)
            if want("boards"): guarded(ctx, "boards", checks.check_boards)
            if want("trains") or want("geometry") or want("brief"): sample = guarded(ctx, "trains", checks.check_trains)
            if want("plan") or want("journeys"): ids = guarded(ctx, "plan", checks.check_plan) or []
            if want("journeys"): guarded(ctx, "journeys", checks.check_journeys, ids)
            if want("geometry"): guarded(ctx, "geometry", checks.check_geometry, sample)
            if want("brief"): guarded(ctx, "brief", checks.check_brief_situation, sample)
            if want("scenario"): guarded(ctx, "scenario", checks.scenario_flow)
        phase("day 08:00", day)
    if want("night"):
        def night(ctx):
            time.sleep(10)  # the next service day loads in the background after the first planner warm-up
            guarded(ctx, "night plan", lambda c: checks.check_plan(c, "night plan", after_local="2026-11-22T23:35", extra=False))
            guarded(ctx, "night brief", lambda c: [c.cmp("night brief", "/api/brief?" + q, ignore=checks.NOISE) for q in ["from=Z%C3%BCrich%20HB&to=Bern", "station=Bern"]])
        phase("night 23:30", night, replay="2026-11-22T23:30")
    if want("replay"):
        phase("replay Wädenswil", lambda c: checks.replay_flow(c, a.replay_times.split(",")), replay="2026-09-10T05:30", speed=20, tt=4000,
              extra_env={"RAIL_REPLAY_SCENARIO": "waedenswil-2026-09-10", "RAIL_DAYS_DIR": "/workspace/sbb/gtfs"})
    md = ["| check | status | details |", "|---|---|---|"] + [f"| {n} | {s} | {d.replace('|', '/')} |" for n, s, d in rows]
    out = "\n".join(md)
    print(out)
    open(a.out, "w").write(out + "\n")
    print(f"\nwritten {a.out}; logs in {lib.SCRATCH}")
    sys.exit(1 if any(s == "differs" for _, s, _ in rows) else 0)

if __name__ == "__main__":
    main()
