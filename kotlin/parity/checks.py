"""The parity checks. Each takes a Ctx (a running Pair of twins) and records results with ctx.record(name, Cmp)."""
import json, time, traceback
from datetime import datetime
from zoneinfo import ZoneInfo
from lib import *

SLOT = 500

def epoch(local):
    """Swiss local 'YYYY-MM-DDTHH:MM[:SS]' -> epoch ms."""
    fmt = "%Y-%m-%dT%H:%M:%S" if local.count(":") == 2 else "%Y-%m-%dT%H:%M"
    return int(datetime.strptime(local, fmt).replace(tzinfo=ZoneInfo("Europe/Zurich")).timestamp() * 1000)

def canon(x):
    """Sort lists whose order is not meaningful (affected trains)."""
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "affectedTrains" and isinstance(v, list) else canon(v)) for k, v in x.items()}
    if isinstance(x, list): return [canon(v) for v in x]
    return x

class Ctx:
    def __init__(self, pair, time_tol=TIME_TOL_MS):
        self.p, self.time_tol = pair, time_tol
        self.res = {}   # name -> Cmp (merged)
        self.errors = {}  # name -> text
        self.order = []
    def record(self, name, c):
        if name not in self.res: self.res[name] = Cmp(); self.order.append(name)
        self.res[name].merge(c)
    def fail(self, name, text):
        self.errors[name] = text
        if name not in self.res: self.order.append(name)
        c = self.res.setdefault(name, Cmp()); c.add_diff("check error", "", text[:200])
    def slot(self, extra_ms=150):
        v = self.p.virtual() + extra_ms
        return int((v - 250) // SLOT + 1) * SLOT + 250
    def both(self, path, path_b=None, **kw):
        tgt = kw.pop("target", None) or self.slot()
        if path_b is None: return self.p.both(path, target=tgt, **kw)
        # different ids per instance: run the two requests at the same virtual instant
        import threading
        out = [None, None]
        def r(i, inst, pth): out[i] = inst.req(kw.get("method", "GET"), pth, kw.get("body"), tgt)
        ts = [threading.Thread(target=r, args=(0, self.p.a, path)), threading.Thread(target=r, args=(1, self.p.b, path_b))]
        [t.start() for t in ts]; [t.join() for t in ts]
        return out[0], out[1]
    def cmp(self, name, path, path_b=None, norm=False, ignore=(), tol=None, **kw):
        ra, rb = self.both(path, path_b, **kw)
        return self.cmp_res(name, ra, rb, norm, ignore, tol), (ra, rb)
    def cmp_res(self, name, ra, rb, norm=False, ignore=(), tol=None):
        c = Cmp()
        if ra[0] != rb[0]: c.add_diff(f"{name} http status", ra[0], rb[0])
        else:
            a, b = canon(ra[1]), canon(rb[1])
            if norm: a, b = normalize(a), normalize(b)
            diff(a, b, ignore=ignore, tol_by_key=tol, time_tol=self.time_tol, c=c)
        self.record(name, c)
        return c
    def rows(self):
        return [(n, self.res[n].status, self.res[n].details()) for n in self.order]

NOISE = {"generatedAt", "ms", "ts", "tick", "streamId", "updatedAt", "fetchedAt", "searches"}
POS_TOL = {"lat": 3e-5, "lon": 3e-5, "bearing": 3, "speedKmh": 1.0, "delaySec": 2, "speed": 1.0}

STATION_NAMES = ["Zürich HB", "Bern", "Basel SBB", "Luzern", "Lausanne", "Genève", "Winterthur", "St. Gallen", "Chur", "Lugano",
                 "Olten", "Thun", "Biel/Bienne", "Fribourg/Freiburg", "Sion", "Schaffhausen", "Aarau", "Zug", "Interlaken Ost", "Vevey",
                 "Wädenswil", "Pfäffikon SZ", "Brig", "Neuchâtel"]

def station_id(ctx, name):
    c, j = http("GET", ctx.p.a.base + "/api/stations?q=" + urllib.parse.quote(name))
    exact = [s for s in j if s["name"] == name] if isinstance(j, list) else []
    return (exact or j)[0]["id"]

import urllib.parse

# ------------------------------------------------------------------ read-only checks
def check_static(ctx):
    for p in ["/api/disruption-types", "/api/measure-types", "/api/train-actions", "/api/stations.geojson", "/api/abroad.geojson", "/api/network.geojson"]:
        ctx.cmp("static " + p.split("/api/")[1], p)
    ra, rb = ctx.both("/api/status")
    c = Cmp(); diff(shape(ra[1]), shape(rb[1]), c=c); ctx.record("status (structure only)", c)
    for p in ["/api/trains/nope", "/api/stations/9999999/board", "/api/disruptions/nope", "/api/bulletins/nope", "/api/plan?from=x", "/api/journeys/nope", "/api/geometry/journey/nope"]:
        ctx.cmp("errors " + p.split("?")[0].replace("/api/", ""), p)

def check_stations(ctx):
    qs = ["zurich", "bern", "basel", "geneve", "lausanne", "st. gallen", "luzern", "lugano", "biel", "chur", "neuchatel", "zzz-none", "8503000", "Wädenswil", ""]
    c = Cmp()
    for q in qs:
        ra = ctx.p.a.req("GET", "/api/stations?q=" + urllib.parse.quote(q)); rb = ctx.p.b.req("GET", "/api/stations?q=" + urllib.parse.quote(q))
        c.merge(diff(ra[1], rb[1], path=f"q={q!r}")) if ra[0] == rb[0] else c.add_diff(f"q={q!r} status", ra[0], rb[0])
    ctx.record("stations search (15 queries)", c)

def board_cmp(ra, rb, t, margin=2500, tt=TIME_TOL_MS):
    """Join boards by trainId; rows on one side only are fine near the window edges or past the 12-row limit."""
    c = Cmp()
    if ra[0] != rb[0]: c.add_diff("http status", ra[0], rb[0]); return c
    A, B = ra[1], rb[1]
    if not isinstance(A, list): return diff(A, B, c=c)
    ia, ib = {r["trainId"]: r for r in A}, {r["trainId"]: r for r in B}
    for k in ia.keys() & ib.keys():
        diff(ia[k], ib[k], path=f"{k}", c=c, time_tol=tt)
    for side, only, other in (("ts", ia.keys() - ib.keys(), B), ("kt", ib.keys() - ia.keys(), A)):
        src = ia if side == "ts" else ib
        for k in only:
            r = src[k]
            last = other[-1]["expected"] if len(other) >= 12 else None
            if (last is not None and r["expected"] >= last - margin) or abs(r["expected"] - (t - 60000)) < margin or abs(r["planned"] - (t + 3600000)) < margin or abs(r["planned"] - (t - 900000)) < margin:
                c.notes.append(f"(edge row {k[-12:]} only in {side}, accepted)")
            else:
                c.add_diff(f"board row only in {side}", r["trainId"], None)
    # order of the common rows
    oa = [r["trainId"] for r in A if r["trainId"] in ib]; ob = [r["trainId"] for r in B if r["trainId"] in ia]
    if oa != ob: c.add_diff("board order", oa[:3], ob[:3])
    return c

def check_boards(ctx, names=STATION_NAMES[:20]):
    ids = {n: station_id(ctx, n) for n in names}
    for n, i in ids.items():
        tgt = ctx.slot()
        ra, rb = ctx.both(f"/api/stations/{i}/board", target=tgt)
        ctx.record("boards (20 stations)", board_cmp(ra, rb, tgt))
    for n in names[:10]:
        ra, rb = ctx.both(f"/api/stations/{ids[n]}/arrivals")
        c = Cmp()
        if ra[0] != rb[0] or not isinstance(ra[1], list): c.add_diff("http status", ra[0], rb[0])
        else:
            ia, ib = {r["trainId"]: r for r in ra[1]}, {r["trainId"]: r for r in rb[1]}
            for k in ia.keys() & ib.keys():
                pa, pb = ia[k], ib[k]
                d = metres(pa["lat"], pa["lon"], pb["lat"], pb["lon"])
                if d > 0.5:
                    if d <= 3 + pa["speedKmh"] / 3.6: c.tol += 1; c.maxdev["metres"] = max(c.maxdev.get("metres", 0), d)
                    else: c.add_diff(f"{k[-12:]} position", f"{d:.0f} m apart", "")
                diff(pa, pb, ignore={"lat", "lon"}, tol_by_key={"speedKmh": 1, "etaSec": 2, "delaySec": 2}, path=k[-12:], c=c)
            for k in ia.keys() ^ ib.keys():
                if len(ra[1]) < 12 and len(rb[1]) < 12: c.add_diff("arrival only on one side", k, None)
                else: c.notes.append("(edge row of the 12-row cut)")
            oa = [r["trainId"] for r in ra[1] if r["trainId"] in ib]; ob = [r["trainId"] for r in rb[1] if r["trainId"] in ia]
            if oa != ob: c.notes.append("(order of ties differs)")
        ctx.record("arrivals (10 stations)", c)
    for n in names[:8]:
        ctx.cmp("neighbours (8 stations)", f"/api/stations/{ids[n]}/neighbours")
    return ids

def pos_cmp(pa, pb, c, path="$"):
    """A position payload: lat/lon as metres (tolerance grows with speed), the rest as usual."""
    d = metres(pa["lat"], pa["lon"], pb["lat"], pb["lon"])
    v = max(pa.get("speedKmh", 0), pb.get("speedKmh", 0)) / 3.6
    if d > 0.5:
        if d <= 3 + v * 1.0: c.tol += 1; c.maxdev["metres"] = max(c.maxdev.get("metres", 0), d)
        else: c.add_diff(path + ".position", f"{d:.0f} m apart", f"speed {v*3.6:.0f} km/h")
    diff(pa, pb, ignore=NOISE | {"lat", "lon"}, tol_by_key=POS_TOL, path=path, c=c)

def check_trains(ctx):
    tgt = ctx.slot()
    ra, rb = ctx.both("/api/trains", target=tgt)
    c = Cmp()
    if ra[0] != 200 or rb[0] != 200: c.add_diff("http", ra[0], rb[0]); ctx.record("trains list", c); return
    ia, ib = {t["trainId"]: t for t in ra[1]}, {t["trainId"]: t for t in rb[1]}
    for k in ia.keys() & ib.keys(): pos_cmp(ia[k], ib[k], c, k[-14:])
    for side, only, src in (("ts", ia.keys() - ib.keys(), ia), ("kt", ib.keys() - ia.keys(), ib)):
        for k in only:
            t = src[k]
            if t.get("atStop") and t.get("speedKmh", 1) == 0: c.notes.append(f"(train {k[-14:]} only in {side}, standing at a stop: activation edge)")
            else: c.add_diff(f"train only in {side}", k, t.get("prevStop"))
    c.notes.insert(0, f"{len(ia)} trains ts, {len(ib)} kt, {len(ia.keys() & ib.keys())} common")
    ctx.record("trains list", c)
    common = sorted(ia.keys() & ib.keys())
    sample = common[:: max(1, len(common) // 14)][:14]
    for k in sample:
        ra, rb = ctx.both(f"/api/trains/{k}")
        c = Cmp()
        if ra[0] != rb[0]: c.add_diff("http status", ra[0], rb[0])
        elif ra[0] == 200:
            pos_cmp(ra[1]["position"], rb[1]["position"], c, "position")
            diff(ra[1]["info"], rb[1]["info"], ignore=NOISE, c=c, time_tol=ctx.time_tol, path="info")
            diff(ra[1]["truth"], rb[1]["truth"], c=c, path="truth")
        ctx.record("train detail + info (14 trains)", c)
    return sample

PAIRS = [("Zürich HB", "Bern"), ("Basel SBB", "Luzern"), ("Genève", "Lausanne"), ("Lugano", "Zürich HB"), ("St. Gallen", "Chur"),
         ("Winterthur", "Olten"), ("Bern", "Brig"), ("Zürich HB", "Lausanne"), ("Luzern", "Lugano"), ("Biel/Bienne", "Thun"),
         ("Schaffhausen", "Basel SBB"), ("Fribourg/Freiburg", "Zürich Flughafen"), ("Interlaken Ost", "Bern"), ("Sion", "Genève"), ("Aarau", "Rapperswil")]

def check_plan(ctx, label="plan", after_local=None, offset_min=10, extra=True):
    after = epoch(after_local) if after_local else int(ctx.p.virtual() + offset_min * 60000)
    ids = []
    for f, t in PAIRS:
        q = f"/api/plan?from={urllib.parse.quote(f)}&to={urllib.parse.quote(t)}&after={after}&limit=4"
        c, (ra, rb) = ctx.cmp(f"{label} (15 pairs)", q, ignore=NOISE)
        if ra[0] == 200 and rb[0] == 200 and ra[1].get("journeys"): ids.append((ra[1]["journeys"][0]["id"], rb[1]["journeys"][0]["id"]))
    if extra:
        for q in [f"/api/plan?from=Zürich%20HB&to=Bern&after={after}&via=Olten", f"/api/plan?from=Zürich%20HB&to=Lugano&after={after}&maxTransfers=1&includeWait=true"]:
            ctx.cmp(f"{label} via/maxTransfers/includeWait", q, ignore=NOISE)
    return ids

def check_journeys(ctx, ids):
    for ia, ib in ids[:6]:
        ctx.cmp("journeys/{id} (6)", f"/api/journeys/{ia}", f"/api/journeys/{ib}", ignore=NOISE)
        ctx.cmp("geometry/journey/{id} (6)", f"/api/geometry/journey/{ia}", f"/api/geometry/journey/{ib}")

def check_geometry(ctx, sample):
    for f, t in [("Zürich HB", "Winterthur"), ("Bern", "Thun"), ("Lausanne", "Vevey"), ("Wädenswil", "Pfäffikon SZ"), ("Basel SBB", "Olten")]:
        ctx.cmp("geometry/section (5)", f"/api/geometry/section?from={urllib.parse.quote(f)}&to={urllib.parse.quote(t)}")
    for k in (sample or [])[:4]:
        ctx.cmp("geometry/train (4)", f"/api/geometry/train/{k}")

def check_brief_situation(ctx, sample):
    for q in ["station=Z%C3%BCrich%20HB", "station=Lausanne", "from=Bern&to=Z%C3%BCrich%20HB", "from=Luzern&to=Lugano", "lat=47.378&lon=8.540&to=Bern", "station=nowhere"]:
        ctx.cmp("brief (6)", "/api/brief?" + q, ignore=NOISE)
    for q in ["station=Bern", "from=Bern&to=Thun", "from=Lausanne&to=Vevey", "station=nowhere"] + [f"trainId={k}" for k in (sample or [])[:2]]:
        ctx.cmp("situation (6)", "/api/situation?" + q, ignore=NOISE, tol=POS_TOL | {"lat": 4e-4, "lon": 4e-4})

# ------------------------------------------------------------------ scenario flows
def scenario_flow(ctx):
    p = ctx.p
    ctx.time_tol = 6000  # simulated (held/slowed) trains advance with the tick spacing: two processes drift by a few seconds
    ids = {n: station_id(ctx, n) for n in ["Zürich HB", "Winterthur", "Bern", "Thun", "Lausanne", "Vevey", "Olten"]}
    T0 = int(ctx.slot(extra_ms=1500) // 1000 * 1000)
    S = [("EG_008", "Zürich HB", "Winterthur", "UNTIL", None), ("EG_006", "Bern", "Thun", "UNTIL_AT_LEAST", None), ("EG_052", "Lausanne", "Vevey", "UNTIL", None)]
    p.wait_until(T0 - 300)
    ra_ids, rb_ids = [], []
    for i, (cause, f, t, dt, _) in enumerate(S):
        body = {"cause": cause, "scope": {"kind": "section", "from": ids[f], "to": ids[t]}, "start": T0, "until": T0 + 7200000, "durationType": dt}
        if i == 0: body["measures"] = [{"type": "short_turn", "at": "both", "announcedAt": T0, "effectiveAt": T0}]
        if i == 1: body["effect"] = "interrupted"
        ra, rb = ctx.both("/api/disruptions", method="POST", body=body, target=T0 + 100 * i)
        ctx.cmp_res("scenario POST /disruptions (3)", ra, rb, norm=True, ignore=NOISE)
        ra_ids.append(ra[1]["disruption"]["id"] if ra[0] == 201 else None); rb_ids.append(rb[1]["disruption"]["id"] if rb[0] == 201 else None)
    if None in ra_ids or None in rb_ids:
        ctx.fail("scenario flow", f"creation failed: ts={ra_ids} kt={rb_ids}"); return
    watched = set()

    def post(i, suffix, body, at):
        ra, rb = ctx.both(f"/api/disruptions/{ra_ids[i]}{suffix}", f"/api/disruptions/{rb_ids[i]}{suffix}", method="POST", body=body, target=T0 + at * 1000)
        ctx.cmp_res(f"scenario POST measure/state/end ({body.get('type', suffix)})", ra, rb, norm=True, ignore=NOISE)

    def snapshot(at, label):
        tgt = T0 + at * 1000
        ctx.cmp("scenario GET /disruptions", "/api/disruptions", norm=True, ignore=NOISE, target=tgt)
        _, (ba, bb) = ctx.cmp("scenario GET /bulletins", "/api/bulletins", norm=True, ignore=NOISE, target=tgt + 500)
        ra, rb = ctx.both("/api/incidents", target=tgt + 1000)
        if ra[0] == 200 and rb[0] == 200:  # automatic incidents follow the trains' exact timing: compared apart (count only)
            na, nb = [i for i in ra[1] if i.get("source") == "auto"], [i for i in rb[1] if i.get("source") == "auto"]
            c = Cmp(); c.notes.append(f"auto incidents ts={len(na)} kt={len(nb)} (not compared one by one)"); ctx.record("scenario auto incidents (count)", c)
            ra, rb = (200, [i for i in ra[1] if i.get("source") != "auto"]), (200, [i for i in rb[1] if i.get("source") != "auto"])
        ctx.cmp_res("scenario GET /incidents (staff + control)", ra, rb, norm=True, ignore=NOISE)
        for i in range(3):
            ctx.cmp("scenario GET /bulletins/{id} (versions)", f"/api/bulletins/{ra_ids[i]}", f"/api/bulletins/{rb_ids[i]}", norm=True, ignore=NOISE, target=tgt + 1500)
            ctx.cmp("scenario GET /disruptions/{id}", f"/api/disruptions/{ra_ids[i]}", f"/api/disruptions/{rb_ids[i]}", norm=True, ignore=NOISE, target=tgt + 2000)
        for n in ["Zürich HB", "Winterthur", "Bern", "Thun", "Lausanne", "Vevey"]:
            t2 = ctx.slot()
            ra, rb = ctx.both(f"/api/stations/{ids[n]}/board", target=t2) if n in ids else (None, None)
            if ra is None: continue
            ctx.record("scenario boards (effective timetable)", board_cmp(normalize_rows(ra), normalize_rows(rb), t2, tt=ctx.time_tol))
            if ra[0] == 200:
                for r in ra[1]:
                    if r.get("disruptionId") or r["category"] == "EV": watched.add(r["trainId"])
        ctx.cmp("scenario GET /situation", "/api/situation?station=Bern", norm=True, ignore=NOISE, tol=POS_TOL | {"lat": 4e-4, "lon": 4e-4})
        ctx.cmp("scenario GET /situation", "/api/situation?from=Z%C3%BCrich%20HB&to=Winterthur", norm=True, ignore=NOISE, tol=POS_TOL | {"lat": 4e-4, "lon": 4e-4})
        ctx.cmp("scenario GET /brief", "/api/brief?station=Bern", norm=True, ignore=NOISE)
        for k in sorted(watched)[:10]:
            if k.startswith(("2026")) and "EV-" in k: continue  # buses get random ids: compared via boards
            ra, rb = ctx.both(f"/api/trains/{k}")
            c = Cmp()
            if ra[0] != rb[0]: c.add_diff(f"trains/{k[-18:]} status", ra[0], rb[0])
            elif ra[0] == 200:
                diff(normalize(ra[1]["info"]), normalize(rb[1]["info"]), ignore=NOISE, c=c, time_tol=ctx.time_tol, path=f"info {k[-14:]}")
                diff(ra[1]["truth"], rb[1]["truth"], c=c, path="truth")
            ctx.record("scenario train info (affected trains)", c)

    snapshot(10, "created")
    post(0, "/measures", {"type": "replacement_bus", "firstInMin": 5, "everyMin": 15, "at": T0 + 20000, "announcedAt": T0 + 20000}, 20)
    post(1, "/measures", {"type": "hold", "maxWaitMin": 60, "at": T0 + 20000, "announcedAt": T0 + 20000}, 20)
    post(2, "/measures", {"type": "one_track_open", "kmh": 40, "cancelShare": 0.5, "at": T0 + 20000, "announcedAt": T0 + 20000}, 20)
    post(2, "/measures", {"type": "replacement_bus", "firstInMin": 5, "everyMin": 10, "at": T0 + 20000, "announcedAt": T0 + 20000}, 21)
    snapshot(30, "measures")
    # a plan through the closed sections
    after = T0 + 5 * 60000
    ctx.cmp("scenario plan (includeWait)", f"/api/plan?from=Bern&to=Interlaken%20Ost&after={after}&includeWait=true", ignore=NOISE | {"id", "incidents", "warnings"}, norm=True, target=T0 + 35000)
    ctx.cmp("scenario plan (includeWait)", f"/api/plan?from=Z%C3%BCrich%20HB&to=St.%20Gallen&after={after}&includeWait=true", ignore=NOISE | {"id", "incidents", "warnings"}, norm=True, target=T0 + 36000)
    post(1, "/measures", {"type": "partial_resumption", "kmh": 80, "at": T0 + 60000, "announcedAt": T0 + 50000}, 50)
    post(0, "/measures", {"type": "prognosis", "until": T0 + 3600000, "durationType": "UNTIL_AT_LEAST", "announcedAt": T0 + 51000}, 51)
    snapshot(80, "partial")
    post(0, "/end", {"at": T0 + 100000}, 90)           # a scheduled resume
    post(2, "/state", {"effect": "resumed", "at": T0 + 110000}, 91)
    snapshot(130, "resumed")
    post(1, "/end", {"at": T0 + 140000}, 135)
    snapshot(175, "all ended")
    ra, rb = ctx.both("/api/control/reset", method="POST", body={}, target=T0 + 180000)
    ctx.cmp_res("scenario control/reset", ra, rb)

def normalize_rows(r):
    return (r[0], normalize(r[1])) if r[0] == 200 else r

# ------------------------------------------------------------------ replay
def replay_flow(ctx, times):
    base = "2026-09-10T"
    for hhmm in times:
        tgt = epoch(base + hhmm)
        ctx.p.wait_until(tgt - 2000)
        t = f"replay {hhmm}"
        ctx.cmp("replay /replays", "/api/replays", norm=True, target=tgt, ignore=NOISE)
        ctx.cmp("replay /disruptions", "/api/disruptions", norm=True, ignore=NOISE | {"affectedTrains"}, target=tgt + 500)
        ctx.cmp("replay /bulletins", "/api/bulletins", norm=True, ignore=NOISE, target=tgt + 1000)
        ra, rb = ctx.both("/api/incidents", target=tgt + 1500)
        if ra[0] == 200 and rb[0] == 200:
            c = Cmp(); c.notes.append(f"auto incidents ts={sum(i.get('source') == 'auto' for i in ra[1])} kt={sum(i.get('source') == 'auto' for i in rb[1])} (count only)"); ctx.record("replay auto incidents (count)", c)
            ra, rb = (200, [i for i in ra[1] if i.get("source") != "auto"]), (200, [i for i in rb[1] if i.get("source") != "auto"])
        ctx.cmp_res("replay /incidents (control)", ra, rb, norm=True, ignore=NOISE)
        ctx.cmp("replay /situation Wädenswil", "/api/situation?station=8503206", norm=True, ignore=NOISE | {"incidents", "delayMin"}, tol=POS_TOL, target=tgt + 2000)
        ctx.cmp("replay /brief Wädenswil", "/api/brief?station=8503206", norm=True, ignore=NOISE | {"delayMin"}, target=tgt + 2500)
        ra, rb = ctx.both("/api/replays/outcome", target=tgt + 3000)
        c = Cmp()
        if ra[0] == 200 and rb[0] == 200:
            ta = {o["trainId"]: o for o in ra[1]}; tb = {o["trainId"]: o for o in rb[1]}
            c.notes.append(f"outcome trains ts={len(ta)} kt={len(tb)}")
            for k in ta.keys() & tb.keys(): diff(ta[k], tb[k], path=k[-14:], c=c, time_tol=ctx.time_tol)
            for k in ta.keys() ^ tb.keys(): c.add_diff("outcome train only on one side", k, None)
        else: c.add_diff("http", ra[0], rb[0])
        ctx.record("replay /replays/outcome", c)
