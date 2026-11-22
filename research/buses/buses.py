#!/usr/bin/env python3
"""Replacement buses (EV, "Ersatzverkehr") for the twin: lead times from the SBB liveticker and speeds / stop
mapping from the official GTFS. Writes model.json and scorecard.json next to this file.

    /opt/venv/bin/python research/buses/buses.py [--no-osrm] [--liveticker DIR] [--gtfs ZIP] [--out DIR]

Paths can also be set with BUSES_LIVETICKER, BUSES_GTFS, BUSES_OUT. BUSES_CACHE=<dir> caches the stop_times pass
(development only).
"""
import argparse, collections, datetime as dt, glob, hashlib, io, json, math, os, pickle, random, re, sys, time, zipfile
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
LIVETICKER = os.environ.get("BUSES_LIVETICKER", "/workspace/sbb/Daten/extern-liveticker")
GTFS = os.environ.get("BUSES_GTFS", "/workspace/sbb/gtfs/gtfs_fp2026_20261118.zip")
OUT = os.environ.get("BUSES_OUT", HERE)
CACHE = os.environ.get("BUSES_CACHE", "")
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=false"
VERSION = "2026-11-22"

RAIL_TYPES = {2} | set(range(100, 118))          # GTFS basic rail + extended railway service types
BUS_TYPES = {3} | set(range(700, 718))           # GTFS basic bus + extended bus service types


# ----------------------------------------------------------------------------------------------------------- utils
def q(a, ps, nd=1):
    a = np.asarray(a, dtype=float)
    return {f"p{p}" if p != 50 else "median": (round(float(np.percentile(a, p)), nd) if len(a) else None) for p in ps}


def haversine_m(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * np.arcsin(np.sqrt(a))


def gtfs_secs(s):
    """'25:13:00' -> seconds (GTFS times can exceed 24:00:00)."""
    p = s.str.split(":", expand=True).astype(int)
    return p[0] * 3600 + p[1] * 60 + p[2]


# ------------------------------------------------------------------------------------------------- GTFS: one pass
def read_gtfs_small(z):
    rd = lambda n, **kw: pd.read_csv(z.open(n), dtype=str, encoding="utf-8-sig", keep_default_na=False, **kw)
    routes = rd("routes.txt")
    trips = rd("trips.txt", usecols=["route_id", "trip_id"])
    stops = rd("stops.txt")
    return routes, trips, stops


def stream_stop_times(z, trip_class):
    """Stream stop_times.txt once. trip_class: dict trip_id -> 1 rail, 2 bus, 3 EV on a bus route type, 4 EV on a
    rail route type.
    Returns (EV stop_times DataFrame, set of rail-served stop_ids, set of bus-served stop_ids, rows read)."""
    import pyarrow as pa, pyarrow.csv as pacsv, pyarrow.compute as pc
    cols = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]
    f = z.open("stop_times.txt")
    reader = pacsv.open_csv(f, read_options=pacsv.ReadOptions(block_size=1 << 26),
                            convert_options=pacsv.ConvertOptions(include_columns=cols,
                                                                 column_types={c: pa.string() for c in cols}))
    ev_parts, rail, bus, nrows = [], set(), set(), 0
    for batch in reader:
        nrows += batch.num_rows
        enc = pc.dictionary_encode(batch.column(0))
        dic = enc.dictionary.to_pylist()
        cls = np.fromiter((trip_class.get(t, 0) for t in dic), dtype=np.int8, count=len(dic))
        rowcls = cls[enc.indices.to_numpy(zero_copy_only=False)]
        sid = batch.column(3)
        for c, acc in ((1, rail), (2, bus), (3, bus)):
            m = rowcls == c
            if m.any():
                acc.update(pc.unique(pc.filter(sid, pa.array(m))).to_pylist())
        m = rowcls >= 3
        if m.any():
            ev_parts.append(pa.Table.from_batches([batch]).filter(pa.array(m)))
    ev = pa.concat_tables(ev_parts).to_pandas()
    return ev, rail, bus, nrows


# ------------------------------------------------------------------------------------------- PART A: liveticker
TS_FMT = "%Y-%m-%d %H:%M:%S.%f %z"
BUS_SENTENCE = {"de": r"ersatzbus", "fr": r"bus de remplacement", "it": r"autobus sostitutiv", "en": r"replacement bus"}

# Message classes, built from the real titles/texts (original language first, English translation as fallback).
# A message version can carry several classes ("first bus running, more buses being searched").
CLASS_RE = {
    "search": [
        # en
        r"bus search", r"search(ing)? (for )?(\w+ )?(replacement )?bus", r"look(ing)? for (\w+ )?(replacement )?bus",
        r"bus(es)? (have|has) been (ordered|organi[sz]ed|requested|mobili[sz]ed|called)",
        r"bus(es)? (are|is) (being )?(ordered|organi[sz]ed|requested|wanted|on standby)", r"being organi[sz]ed",
        r"arrival (of the )?(\w+ )?(is )?(still )?unclear", r"mobili[sz]ed (\w+ )?bus",
        # de
        r"bus(se)?such", r"such(en)? (\w+ )*?(ersatz)?bus", r"bus(se)? (werden|wird) gesucht",
        r"(ersatz|bahnersatz)?bus(se)? (sind|ist|wurden|wurde|werden|wird|konnten) (\w+ )?(aufgeboten|bestellt|organisiert|angefordert)",
        r"es werden (\w+ )?(ersatz|bahnersatz)?bus(se)? (\(ev\) )?organisiert", r"haben (\w+ )?busse aufgeboten",
        r"(eintreffen|ankunft)\b.*\bunklar",
        # fr
        r"recherche (de |des )?(\w+ )?bus", r"bus (\w+ )*?en recherche", r"recherchons (\w+ )*?(des )?bus",
        r"(bus|cars?)\b[^.]{0,40}\b(ont été|a été|sont|est) (\w+ )?(command|organis|mobilis|demand)",
        r"commande de bus", r"bus\b[^.]{0,30}\ben cours d'organisation", r"arrivée\b[^.]{0,60}\b(inconnue|incertaine|pas encore connue)",
        # it
        r"ricerca (di |degli )?(\w+ )?(bus|autobus)", r"cerc(hiamo|ando) (\w+ )*?autobus",
        r"autobus\b[^.]{0,40}\b(sono stati|è stato|vengono|viene) (ordinat|organizzat|richiest)",
        # decided but not yet running ("des bus vont être mis en service", "es werden Ersatzbusse verkehren")
        r"bus\b[^.]{0,40}\b(vont|va|seront|sera) (être )?mise?s? en (service|place|circulation)",
        r"es werden (\w+ )?(bahnersatz|ersatz)?bus(se)? verkehren",
    ],
    "confirmed": [
        r"bus(es|se)?\b[^.]{0,60}\b(confirm|bestätigt|confermat)", r"(confirm|bestätigt)\w*\b[^.]{0,40}\bbus",
        r"we('ve| have)? found (\w+ )*?bus", r"avons trouvé (\w+ )*?bus", r"(?<!pas de )\bbus disponibles? (à|a|dans|en)\b",
    ],
    "shortage": [
        r"only (one|1|two|2|a few|few) (\w+ )?(replacement )?bus", r"no (\w+ )?(replacement )?bus(es)? (are )?(currently |yet )?available",
        r"no (\w+ )?(replacement )?bus(es)? yet", r"shortage", r"not enough (\w+ )?bus", r"insufficient (\w+ )?bus",
        r"nur (ein|einen|1|zwei|2|wenige) (\w+ )?(bahn)?(ersatz)?bus", r"keine (\w+ )?(bahn)?(ersatz)?bus(se)? (\w+ )?verfügbar",
        r"noch keine (\w+ )?(bahn)?(ersatz)?bus", r"engpäss?e bei (\w+ )?(bahn)?(ersatz)?bus", r"nicht genügend (\w+ )?bus",
        r"(un )?seul (\w+ )?bus", r"pas (de|assez de) (\w+ )?bus\b[^.]{0,40}\bdisponible", r"aucun (\w+ )?bus",
        r"manque de (\w+ )?(bus|chauffeur)", r"pénurie", r"pas encore de bus",
        r"solo (un|uno|1|due|2) (\w+ )?autobus", r"nessun (\w+ )?autobus",
    ],
    "running": [
        # en
        r"bus(es)?\b[^.]{0,30}\b(in operation|in service|in circulation|in use|on the road|on site)",
        r"bus(es)? (are|is) (now )?(running|operating|circulating|in place)", r"bus(es)? run(s)? (between|from|in)",
        r"first (\w+ )*?bus(es)? (\w+ )?(left|departed|run|running|in)", r"(service launch|put into service)",
        # de
        r"(bahnersatz|ersatz)?bus(se)?\b[^.]{0,30}\b(in betrieb|im einsatz|vor ort)",
        r"(bahnersatz|ersatz)?bus(se)? (verkehr(en|t)|fahren|fährt|zirkulier)", r"erste[rn]? (\w+ )*?(bahnersatz|ersatz)?bus(se)?\b[^.]{0,30}\b(abgefahren|unterwegs|verkehr|fahr|einsatz|betrieb)",
        r"erste busfahrten",
        # fr
        r"bus\b[^.]{0,40}\b(circulent|circule|circules|en circulation|en service|en place|mis en place|roulent|sur place)\b",
        r"mise en service (des|du) (\w+ )?bus", r"premiers? (\w+ )*?bus (\w+ )?(circul|part|est parti|sont partis|en service)",
        # it
        r"autobus\b[^.]{0,40}\b(circolano|in servizio|in circolazione|in funzione)",
    ],
}
CLASS_C = {k: re.compile("|".join(f"(?:{p})" for p in v), re.I) for k, v in CLASS_RE.items()}
# "running" only counts in a sentence without a future / planned marker ("les bus circuleront", "der erste Bus soll")
FUTURE = re.compile(r"\b(va|vont|sera|seront|devrai(t|ent)|prévus?|partira|\w+eront|wird|werden|sollte|soll|sollen|in kürze|"
                    r"voraussichtlich|geplant|will|should|expected|planned|soon|sarà|saranno|previst\w)\b", re.I)
SENT = re.compile(r"(?<=[.!?])\s+|\s*\n\s*|\s+\|\|\s+")


# nor in a negated or uncertain one ("Actuellement pas de bus de substitution en service", "noch nicht klar, wann
# dieser Bus vor Ort ist"): those say the bus is NOT running yet
NEGATION = re.compile(r"\b(pas|aucun\w*|kein\w*|nicht|unklar|no|not|nessun\w*|non|ancora|noch|en cours)\b", re.I)


def classify(text):
    out = {k for k, rx in CLASS_C.items() if k != "running" and rx.search(text)}
    if any(CLASS_C["running"].search(x) and not FUTURE.search(x) and not NEGATION.search(x) for x in SENT.split(text)):
        out.add("running")
    return out


def load_liveticker(d):
    rd = lambda pat: pd.concat([pd.read_csv(f, dtype=str, keep_default_na=False) for f in sorted(glob.glob(os.path.join(d, pat)))],
                               ignore_index=True)
    inc = pd.concat([rd("incident_audit_*.csv"), rd("incident_2*.csv")], ignore_index=True)
    msg = pd.concat([rd("message_audit_*.csv"), rd("message_2*.csv")], ignore_index=True)
    for df, cols in ((inc, ["created_date", "last_modified_date", "created_at_source", "updated_at_source"]),
                     (msg, ["created_date", "last_modified_date"])):
        for c in cols:
            df[c] = pd.to_datetime(df[c].replace("", None), format=TS_FMT, utc=True)
    inc = inc.sort_values(["id", "last_modified_date"]).reset_index(drop=True)
    msg = msg.sort_values(["id", "last_modified_date"]).reset_index(drop=True)
    return inc, msg


def orig_lang(r):
    for l in ("de", "fr", "it", "en"):
        if r[f"{l}_translated"] == "false":
            return l
    return "de"


def part_a(inc, msg, use_en_fallback=False, start_mode="min_source_created"):
    """Returns (model fragment, scorecard fragment, per-incident table)."""
    inc = inc.copy()
    inc["intr"] = inc.summary_en.str.startswith("Interrupted service") | inc.summary_de.str.startswith("Unterbruch")
    pats = {l: re.compile(p, re.I) for l, p in BUS_SENTENCE.items()}
    inc["busSentence"] = False
    for l, rx in pats.items():
        inc["busSentence"] |= inc[f"description_{l}"].str.contains(rx) | inc[f"summary_{l}"].str.contains(rx)
    g = inc.groupby("id", sort=False)
    first = g.head(1).set_index("id")
    per = pd.DataFrame({"interrupted": g.intr.any(), "busFirst": first.busSentence, "busAny": g.busSentence.any(),
                        "title": g.summary_en.first(), "lifecycleLast": g.lifecycle.last()})
    # first version with the bus sentence (when it is added later)
    bs = inc[inc.busSentence].groupby("id").last_modified_date.min()
    if start_mode == "min_source_created":
        start = pd.concat([first.created_at_source, first.created_date, first.last_modified_date], axis=1).min(axis=1)
    elif start_mode == "created_date":
        start = pd.concat([first.created_date, first.last_modified_date], axis=1).min(axis=1)
    else:
        start = first.created_at_source
    per["start"] = start
    per["busSentenceAt"] = bs
    # messages: one event per published version, timestamp = that version's last_modified_date; the first version of a
    # message is stamped with its first publication time (earliest of created_date / last_modified_date)
    m = msg[msg.status == "PUBLISHED"].copy()
    m["ol"] = m.apply(orig_lang, axis=1)
    m["t"] = m.last_modified_date
    firstpub = msg.groupby("id")[["created_date", "last_modified_date"]].min().min(axis=1)
    isfirst = ~m.duplicated("id")
    m.loc[isfirst, "t"] = m.loc[isfirst, "id"].map(firstpub)
    def text(r, l):
        return f"{r[f'title_{l}']} || {r[f'message_{l}']}"
    cls = []
    for _, r in m.iterrows():
        c = classify(text(r, r.ol))
        if not c and use_en_fallback and r.ol != "en":
            c = classify(text(r, "en"))
        cls.append(c)
    m["cls"] = cls
    m["titleOrig"] = [r[f"title_{r.ol}"] for _, r in m.iterrows()]
    for k in CLASS_RE:
        e = m[m.cls.apply(lambda s: k in s)]
        per[f"first_{k}"] = e.groupby("incident_id_fk").t.min()
        per[f"title_{k}"] = e.sort_values("t").groupby("incident_id_fk").titleOrig.first()
    per = per[per.index.notna()]
    return per, m


# ------------------------------------------------------------------------------------------------ PART B: GTFS
BANDS = [2, 5, 10, 20, None]


def band_of(km):
    for i, b in enumerate(BANDS):
        if b is None or km <= b:
            return i
    return len(BANDS) - 1


def is_test_route(route_id):
    return int(hashlib.md5(route_id.encode()).hexdigest(), 16) % 10 < 3


def osrm_ratios(pairs, cache_path, use_osrm, max_n=120, seed=42):
    """pairs: DataFrame with lat1, lon1, lat2, lon2, straight_m (distinct hops). Returns list of road/straight ratios."""
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            cache = json.load(f)
    sample = pairs.sample(min(max_n, len(pairs)), random_state=seed)
    ratios, fetched, failed = [], 0, 0
    if use_osrm:
        import requests
    for r in sample.itertuples():
        key = f"{r.lon1:.6f},{r.lat1:.6f};{r.lon2:.6f},{r.lat2:.6f}"
        if key not in cache and use_osrm:
            try:
                resp = requests.get(OSRM_URL.format(lon1=f"{r.lon1:.6f}", lat1=f"{r.lat1:.6f}", lon2=f"{r.lon2:.6f}",
                                                    lat2=f"{r.lat2:.6f}"), timeout=4,
                                    headers={"User-Agent": "rail-twin-research/1.0"})
                js = resp.json()
                cache[key] = js["routes"][0]["distance"] if js.get("code") == "Ok" and js.get("routes") else None
                fetched += 1
            except Exception:
                failed += 1
            time.sleep(1.0)
        if cache.get(key):
            ratios.append(cache[key] / r.straight_m)
    with open(cache_path, "w") as f:
        json.dump(cache, f, indent=0, sort_keys=True)
    return ratios, len(sample), fetched, failed


def part_b(z, routes, trips, stops, ev_st, rail_stops, bus_stops, ev_route_ids, use_osrm, cache_path):
    S = stops.set_index("stop_id")
    lat, lon = S.stop_lat.astype(float), S.stop_lon.astype(float)
    rtype = routes.set_index("route_id").route_type.astype(int)
    info = {}
    # ---- EV routes: keep those whose stops are road stops (not served by any non-EV rail trip)
    st = ev_st.merge(trips, on="trip_id", how="left")
    rs = st.drop_duplicates(["route_id", "stop_id"])
    rs = rs.assign(rail=rs.stop_id.isin(rail_stops))
    share_rail = rs.groupby("route_id").rail.mean()
    keep = set(share_rail[share_rail < 0.5].index)
    info["evRoutes"] = len(ev_route_ids)
    info["evRouteTypes"] = {str(k): int(v) for k, v in rtype.loc[sorted(ev_route_ids)].value_counts().items()}
    info["evRoutesWithTrips"] = int(share_rail.size)
    info["evRoutesDroppedRailStops"] = sorted(set(share_rail.index) - keep)
    info["evRoutesDroppedRailStopsTypes"] = {r: int(rtype[r]) for r in info["evRoutesDroppedRailStops"]}
    info["nonRoadEvRouteTypesKept"] = {r: int(rtype[r]) for r in keep if rtype[r] not in BUS_TYPES}
    st = st[st.route_id.isin(keep)].copy()
    st["seq"] = st.stop_sequence.astype(int)
    st = st.sort_values(["trip_id", "seq"]).reset_index(drop=True)
    st["arr"], st["dep"] = gtfs_secs(st.arrival_time), gtfs_secs(st.departure_time)
    same_next = st.trip_id.eq(st.trip_id.shift(-1))
    pos = st.groupby("trip_id").cumcount()
    last = ~same_next
    # dwell at intermediate stops
    inter = st[(pos > 0) & ~last]
    dw = inter.assign(d=inter.dep - inter.arr).drop_duplicates(["route_id", "stop_id", "d"]).d
    # hops
    h = pd.DataFrame({"route_id": st.route_id, "a": st.stop_id, "b": st.stop_id.shift(-1),
                      "min": (st.arr.shift(-1) - st.dep) / 60.0})[same_next]
    h = h.drop_duplicates(["route_id", "a", "b", "min"]).reset_index(drop=True)
    h["lat1"], h["lon1"] = lat.reindex(h.a).values, lon.reindex(h.a).values
    h["lat2"], h["lon2"] = lat.reindex(h.b).values, lon.reindex(h.b).values
    h["straight_m"] = haversine_m(h.lat1, h.lon1, h.lat2, h.lon2)
    n0 = len(h)
    drop = {"zeroMinutes": int((h["min"] <= 0).sum())}
    h = h[h["min"] > 0]
    drop["straightUnder300m"] = int((h.straight_m < 300).sum())
    h = h[h.straight_m >= 300]
    # ---- road factor from OSRM on distinct hops
    pairs = h.drop_duplicates(["a", "b"])[["lat1", "lon1", "lat2", "lon2", "straight_m"]]
    ratios, nsample, fetched, failed = osrm_ratios(pairs, cache_path, use_osrm)
    if len(ratios) >= 30:
        rf = round(float(np.median(ratios)), 3)
        rq = q(ratios, [25, 50, 75], nd=3)
        method = (f"median OSRM driving distance / straight distance on {len(ratios)} of {nsample} randomly sampled distinct "
                  f"EV hops (router.project-osrm.org; p25 {rq['p25']:.2f}, median {rq['median']:.2f}, p75 {rq['p75']:.2f})")
    else:
        rf, rq = 1.3, None
        method = f"default 1.3 (OSRM calibration unavailable: {len(ratios)} usable responses)"
    h["kmh"] = h.straight_m / 1000 * rf / (h["min"] / 60)
    drop["speedOutside5to100"] = int(((h.kmh < 5) | (h.kmh > 100)).sum())
    h = h[(h.kmh >= 5) & (h.kmh <= 100)].copy()
    h["band"] = [band_of(x / 1000) for x in h.straight_m]
    by = []
    for i, b in enumerate(BANDS):
        x = h[h.band == i].kmh
        by.append({"maxKm": b, "n": int(len(x)), **q(x, [25, 50, 75])})
    speed = {"roadFactor": rf, "roadFactorMethod": method, "kmh": {"n": int(len(h)), **q(h.kmh, [25, 50, 75])},
             "byStraightKm": by, "dwellSec": {"n": int(len(dw)), "median": float(np.median(dw)) if len(dw) else None,
                                               "p75": float(np.percentile(dw, 75)) if len(dw) else None},
             "routes": int(h.route_id.nunique()), "trips": int(st.trip_id.nunique()), "hops": int(len(h)),
             "hopsBeforeFilters": int(n0), "dropped": drop,
             "hopDefinition": "consecutive stops of an EV trip; identical hops per route (from, to, scheduled minutes) "
                              "counted once; km/h = straight km x roadFactor / (arrival at next - departure)"}
    roadq = {"n": len(ratios), "sampled": nsample, "fetchedThisRun": fetched, "failed": failed, **(rq or {})}
    # ---- holdout by route: learned band speed vs the twin's old flat 50 km/h x 1.3
    h["test"] = h.route_id.map(is_test_route)
    tr, te = h[~h.test], h[h.test]
    band_med = tr.groupby("band").kmh.median()
    overall_med = tr.kmh.median()
    pred = te.straight_m / 1000 * rf / te.band.map(band_med).fillna(overall_med) * 60
    pred_overall = te.straight_m / 1000 * rf / overall_med * 60
    pred_old = te.straight_m / 1000 * 1.3 / 50 * 60
    err = lambda p: float(np.mean(np.abs(p - te["min"])))
    bias = lambda p: float(np.mean(p - te["min"]))
    holdout = {"trainRoutes": int(tr.route_id.nunique()), "testRoutes": int(te.route_id.nunique()),
               "trainHops": int(len(tr)), "testHops": int(len(te)),
               "maeMin": {"learnedByBand": round(err(pred), 2), "learnedOverall": round(err(pred_overall), 2),
                          "flat50kmh": round(err(pred_old), 2)},
               "biasMin": {"learnedByBand": round(bias(pred), 2), "learnedOverall": round(bias(pred_overall), 2),
                           "flat50kmh": round(bias(pred_old), 2)},
               "meanScheduledMin": round(float(te["min"].mean()), 2)}
    # per-band MAE on test
    pb = []
    for i, b in enumerate(BANDS):
        mk = te.band == i
        if mk.any():
            pb.append({"maxKm": b, "n": int(mk.sum()), "learned": round(float(np.mean(np.abs(pred[mk] - te["min"][mk]))), 2),
                       "flat50kmh": round(float(np.mean(np.abs(pred_old[mk] - te["min"][mk]))), 2)})
    holdout["byBand"] = pb
    ev_stops_used = set(st.stop_id)
    return speed, roadq, holdout, info, ev_stops_used, h


def name_score(station, cand):
    c = cand.lower()
    st = station.lower()
    if c in {f"{st}, bahnhof", f"{st}, gare", f"{st}, stazione", f"{st}, bahnhof sbb", f"{st}, gare cff", f"{st}, staziun"}:
        return 2
    return 1 if c.startswith(st) else 0


def station_stops(z, stops, rail_stops, bus_stops, ev_stops_used):
    s = stops.copy()
    s["lat"], s["lon"] = s.stop_lat.astype(float), s.stop_lon.astype(float)
    s["parent"] = np.where(s.location_type == "1", s.stop_id, s.parent_station)
    s.loc[s.parent == "", "parent"] = s.loc[s.parent == "", "stop_id"]
    par_of = dict(zip(s.stop_id, s.parent))
    P = s.drop_duplicates("parent", keep="last").set_index("parent")   # fallback rows for orphan stops
    Pp = s[s.location_type == "1"].set_index("stop_id")
    P.loc[Pp.index, ["stop_name", "lat", "lon", "didok", "original_stop_id"]] = Pp[["stop_name", "lat", "lon", "didok", "original_stop_id"]]
    rail_par = sorted({par_of[x] for x in rail_stops if x in par_of})
    bus_par = sorted({par_of[x] for x in bus_stops if x in par_of})
    ev_par = sorted({par_of[x] for x in ev_stops_used if x in par_of})
    stations = P.loc[rail_par]
    stations = stations[stations.didok.str.startswith("85")]
    # generic footpaths (no route / trip) between stop places
    t = pd.read_csv(z.open("transfers.txt"), dtype=str, encoding="utf-8-sig", keep_default_na=False,
                    usecols=["from_stop_id", "to_stop_id", "from_route_id", "to_route_id", "from_trip_id", "to_trip_id",
                             "min_transfer_time"])
    t = t[(t.from_route_id == "") & (t.to_route_id == "") & (t.from_trip_id == "") & (t.to_trip_id == "") & (t.min_transfer_time != "")]
    t = pd.DataFrame({"pa": t.from_stop_id.map(par_of), "pb": t.to_stop_id.map(par_of), "sec": t.min_transfer_time.astype(float)})
    t = t[t.pa != t.pb].dropna()
    tr = t.groupby(["pa", "pb"]).sec.median().to_dict()
    # bus-served child stops per parent (for a bus stop inside the station's own stop place)
    bus_child = s[s.stop_id.isin(bus_stops | ev_stops_used)][["parent", "lat", "lon"]]
    def cand_arrays(pars):
        c = P.loc[pars]
        return np.array(pars), c.lat.values, c.lon.values, c.stop_name.values
    EV, BUS = cand_arrays(ev_par), cand_arrays(bus_par)
    ev_set = set(ev_par)
    out, counts = {}, collections.Counter()
    for sid, r in stations.iterrows():
        pick = None
        for basis, (ids, la, lo, nm), radius in (("ev", EV, 600), ("bus", BUS, 400)):
            d = haversine_m(r.lat, r.lon, la, lo)
            if basis == "bus":   # a stop named "<station>, Bahnhof" within 1.5 km beats the nearest stop
                named = [i for i in np.where(d <= 1500)[0] if name_score(r.stop_name, nm[i]) == 2]
                if named:
                    i = min(named, key=lambda i: d[i]); pick = (basis, ids[i], d[i]); break
            idx = np.where(d <= radius)[0]
            if len(idx):
                dmin = d[idx].min()
                ties = [i for i in idx if d[i] <= dmin + 20]
                i = max(ties, key=lambda i: (name_score(r.stop_name, nm[i]), -d[i]))
                pick = (basis, ids[i], d[i]); break
        if pick is None:
            counts["none"] += 1
            continue
        basis, pid, dist = pick
        c = P.loc[pid]
        lat_, lon_ = c.lat, c.lon
        if pid == sid:   # bus stops inside the station's own stop place: walk to the nearest bus-served child stop
            ch = bus_child[bus_child.parent == pid]
            if len(ch):
                dd = haversine_m(r.lat, r.lon, ch.lat.values, ch.lon.values)
                j = int(np.argmin(dd)); dist = dd[j]; lat_, lon_ = ch.lat.values[j], ch.lon.values[j]
        walk_m = int(round(dist * 1.3 / 10.0) * 10)
        sec = [tr[k] for k in ((sid, pid), (pid, sid)) if k in tr]
        if sec:
            walk_min, wb = max(1, math.ceil(float(np.median(sec)) / 60)), "transfer"
        else:
            walk_min, wb = max(1, math.ceil(walk_m / 80)), "estimate"
        counts[basis] += 1
        counts[wb] += 1
        out[r.didok] = {"name": c.stop_name, "stopId": c.original_stop_id or pid.replace("Parent", "", 1), "didok": c.didok,
                        "lat": round(float(lat_), 5), "lon": round(float(lon_), 5), "walkM": walk_m, "walkMin": walk_min,
                        "walkBasis": wb, "ev": bool(pid in ev_set), "basis": basis, "station": r.stop_name,
                        "stationLat": round(float(r.lat), 5), "stationLon": round(float(r.lon), 5)}
    counts["stations"] = len(stations)
    return out, dict(counts)


# -------------------------------------------------------------------------------------------------------- main
def minutes(a, b):
    return (a - b).dt.total_seconds() / 60.0


def clean(x):
    x = x.dropna()
    bad = int(((x < 0) | (x > 1440)).sum())
    return x[(x >= 0) & (x <= 1440)], bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--liveticker", default=LIVETICKER)
    ap.add_argument("--gtfs", default=GTFS)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--no-osrm", action="store_true", help="do not call OSRM (cached responses are still used)")
    a = ap.parse_args()
    t0 = time.time()
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    lt_files = sorted(os.path.basename(f) for f in glob.glob(os.path.join(a.liveticker, "*.csv")) if "reason" not in f)

    # ---------------- PART A
    inc, msg = load_liveticker(a.liveticker)
    per, m = part_a(inc, msg)
    intr = per[per.interrupted]
    bff = {"interrupted": int(len(intr)), "withBusSentence": int(intr.busFirst.sum()),
           "share": round(float(intr.busFirst.mean()), 2)}
    bany = {"interrupted": int(len(intr)), "withBusSentence": int(intr.busAny.sum()),
            "share": round(float(intr.busAny.mean()), 2)}
    bs_lead, bs_bad = clean(minutes(intr[intr.busAny].busSentenceAt, intr[intr.busAny].start))
    lead, dropped = {}, {}
    for k, col in (("firstSearch", "first_search"), ("firstConfirmed", "first_confirmed"),
                   ("firstShortage", "first_shortage"), ("firstRunning", "first_running")):
        x, bad = clean(minutes(per[col], per.start))
        per[k] = minutes(per[col], per.start).where(lambda v: (v >= 0) & (v <= 1440))
        lead[k] = {"n": int(len(x)), **q(x, [10, 25, 50, 75, 90])}
        if k in ("firstSearch", "firstRunning"):  # the sorted sample: the twin conditions on "none yet after e minutes"
            lead[k]["samples"] = [round(float(v), 1) for v in np.sort(np.asarray(x, dtype=float))]
        dropped[k] = bad
    both = per.dropna(subset=["firstSearch", "firstRunning"])
    d = both.firstRunning - both.firstSearch
    lead["searchToRunning"] = {"n": int((d > 0).sum()), **q(d[d > 0], [25, 50, 75])}
    nonpos = int((d <= 0).sum())
    sh = per.dropna(subset=["firstShortage"]).sort_values("start")
    shortages = {"incidents": int(len(sh)), "examples": [
        {"incidentId": i, "title": r.title, "messageTitle": r.title_shortage, "minutesFromStart": round(float(r.firstShortage))}
        for i, r in sh.iterrows()]}
    # out-of-time check of the empirical first-running window
    run = per.dropna(subset=["firstRunning"]).sort_values("start")
    cut = int(round(len(run) * 0.6))
    fit, test = run.iloc[:cut], run.iloc[cut:]
    fq = q(fit.firstRunning, [10, 25, 50, 75, 90])
    cov = []
    for lo, hi, nominal in (("p25", "p75", 0.5), ("p10", "p90", 0.8)):
        inside = ((test.firstRunning >= fq[lo]) & (test.firstRunning <= fq[hi])).mean()
        cov.append({"bin": f"first bus running, fitted {lo}-{hi} window ({fq[lo]:.0f}-{fq[hi]:.0f} min)",
                    "predicted": nominal, "observed": round(float(inside), 3), "n": int(len(test))})
    sq = None
    srch = per.dropna(subset=["firstSearch"]).sort_values("start")
    cs = int(round(len(srch) * 0.6))
    if cs > 10:
        sq = q(srch.iloc[:cs].firstSearch, [10, 25, 50, 75, 90])
        st_ = srch.iloc[cs:]
        for lo, hi, nominal in (("p25", "p75", 0.5), ("p10", "p90", 0.8)):
            inside = ((st_.firstSearch >= sq[lo]) & (st_.firstSearch <= sq[hi])).mean()
            cov.append({"bin": f"first search message, fitted {lo}-{hi} window ({sq[lo]:.0f}-{sq[hi]:.0f} min)",
                        "predicted": nominal, "observed": round(float(inside), 3), "n": int(len(st_))})
    within = {f"{w}": round(float((run.firstRunning <= w).mean()), 3) for w in (15, 30, 60, 120)}
    ex = both[(both.firstRunning > both.firstSearch)].sort_values("start").tail(4)
    examples = [{"id": i, "title": r.title, "announced": f"bus search at +{r.firstSearch:.0f} min ({r.title_search})",
                 "predicted": f"empirical first-bus window p25-p75 {lead['firstRunning']['p25']:.0f}-{lead['firstRunning']['p75']:.0f} min",
                 "actual": f"first bus running at +{r.firstRunning:.0f} min ({r.title_running})",
                 "start": r.start.isoformat()} for i, r in ex.iterrows()]
    # cross-check: titles only (the earlier hand count used message titles)
    tit = {}
    for k in ("search", "running"):
        e = m[[k in classify(t) for t in m.titleOrig]]
        x, _ = clean(minutes(e.groupby("incident_id_fk").t.min(), per.start.reindex(e.groupby("incident_id_fk").t.min().index)))
        tit[k] = {"n": int(len(x)), **q(x, [25, 50, 75])}
    ta = time.time() - t0

    # ---------------- PART B
    z = zipfile.ZipFile(a.gtfs)
    routes, trips, stops = read_gtfs_small(z)
    rt = routes.route_type.astype(int)
    ev_mask = routes.route_short_name.str.match(r"^EV\d*$") | (routes.route_desc == "EV")
    ev_route_ids = set(routes.route_id[ev_mask])
    rclass = {}
    for rid, t, e in zip(routes.route_id, rt, ev_mask):
        rclass[rid] = (3 if t in BUS_TYPES else 4) if e else (1 if t in RAIL_TYPES else (2 if t in BUS_TYPES else 0))
    trip_class = {t: rclass.get(r, 0) for r, t in zip(trips.route_id, trips.trip_id)}
    ev_st, rail_stops, bus_stops, nrows = stream_stop_times(z, trip_class)
    speed, roadq, holdout, info, ev_stops_used, hops = part_b(
        z, routes, trips, stops, ev_st, rail_stops, bus_stops, ev_route_ids, not a.no_osrm, os.path.join(a.out, "osrm_cache.json"))
    ss, sscount = station_stops(z, stops, rail_stops, bus_stops, ev_stops_used)
    tb = time.time() - t0 - ta

    model = {
        "name": "buses", "version": VERSION, "generatedAt": now,
        "sources": {"liveticker": ", ".join(lt_files), "gtfs": os.path.basename(a.gtfs)},
        "busFromFirstVersion": bff,
        "busInAnyVersion": bany,
        "busSentenceLeadMin": {"n": int(len(bs_lead)), **q(bs_lead, [25, 50, 75])},
        "leadTimeMin": lead,
        "leadTimeDefinition": (
            "minutes from the incident start (earliest of created_at_source / created_date of its first version, "
            "versions ordered by last_modified_date) to the first PUBLISHED message version classified as search / "
            "confirmed / shortage / running (regexes on title + text in the message's original language; the first "
            "version of a message is stamped with its first publication time, later versions with their "
            "last_modified_date); all incidents, values < 0 or > 24 h dropped"),
        "shortages": shortages,
        "speed": speed,
        "stationStops": ss,
    }
    model["speed"]["roadFactorQuartiles"] = roadq
    model["speed"]["evRoutes"] = info
    sc = {
        "model": "buses", "generatedAt": now,
        "data": {"incidents": int(len(per)), "interrupted": int(len(intr)), "messageVersionsPublished": int(len(m)),
                 "incidentsWithRunningBus": int(len(run)), "fitIncidents": int(len(fit)), "testIncidents": int(len(test)),
                 "splitAt": test.start.iloc[0].isoformat() if len(test) else None,
                 "evRoutes": speed["routes"], "evTrips": speed["trips"], "evHops": speed["hops"],
                 "stopTimesRows": int(nrows), "source": f"liveticker export 2026-10-12; {os.path.basename(a.gtfs)}"},
        "headline": (f"In {len(run)} real incidents the first replacement bus ran a median "
                     f"{lead['firstRunning']['median']:.0f} min after the incident started ({within['15']:.0%} within 15 min, "
                     f"{within['60']:.0%} within 1 h), and timetabled EV buses make {speed['kmh']['median']:.0f} km/h by road; "
                     f"these learned speeds cut the hop-time error on held-out routes from "
                     f"{holdout['maeMin']['flat50kmh']:.2f} to {holdout['maeMin']['learnedByBand']:.2f} min vs the old flat 50 km/h."),
        "metrics": [
            {"name": "Hop time MAE (min), held-out EV routes", "lowerIsBetter": True,
             "values": {"model": holdout["maeMin"]["learnedByBand"], "learnedOverallSpeed": holdout["maeMin"]["learnedOverall"],
                        "old_flat_50kmh_x1.3": holdout["maeMin"]["flat50kmh"]},
             "n": holdout["testHops"], "detail": holdout},
            {"name": "Share of incidents with a running bus within N min of the start", "lowerIsBetter": False,
             "values": within, "n": int(len(run)), "note": "the twin used to assume a first bus 15 min after the decision"},
            {"name": "Road factor (OSRM driving / straight distance)", "lowerIsBetter": None,
             "values": {"median": speed["roadFactor"], **{k: v for k, v in roadq.items() if k in ("p25", "p75")}},
             "n": roadq["n"]},
            {"name": "Bus sentence in the bulletin, interrupted incidents", "lowerIsBetter": None,
             "values": {"firstVersion": bff["share"], "anyVersion": bany["share"]}, "n": bff["interrupted"]},
        ],
        "calibration": cov,
        "examples": examples,
        "notes": [
            f"Interrupted = some version of the incident has summary 'Interrupted service' / 'Unterbruch' ({len(intr)} of {len(per)}).",
            f"The bus sentence (de 'Ersatzbus', fr 'bus de remplacement', it 'autobus sostitutiv', en 'replacement bus' in summary or "
            f"description) is in the FIRST version of {bff['withBusSentence']}/{bff['interrupted']} interrupted incidents "
            f"({bff['share']:.0%}); {bany['withBusSentence']}/{bany['interrupted']} ({bany['share']:.0%}) carry it in SOME version "
            f"(median {model['busSentenceLeadMin']['median']} min after the start). The 347/480 = 72% of the earlier hand count is the "
            f"any-version count.",
            f"Message classes use title + text; with titles only (the earlier hand count) search n={tit['search']['n']} "
            f"(median {tit['search']['median']} min), running n={tit['running']['n']} (median {tit['running']['median']} min). "
            f"Title + text gives more incidents and similar quartiles; 'running' ignores sentences in the future tense "
            f"('les bus circuleront', 'der erste Bus soll').",
            f"Dropped as < 0 or > 24 h: {dropped}. Search -> running: {nonpos} incidents whose first search message came at or "
            f"after the first running bus (looking for more buses) are excluded.",
            f"Shortage = 'only one bus', 'no replacement buses (yet / available)', 'not enough buses', 'Engpässe bei Ersatzbussen' "
            f"etc.: {len(sh)} incidents (the earlier hand count found 5 on titles only).",
            f"Out-of-time check: quantiles fitted on the earliest 60% of incidents by start date ({len(fit)}), coverage on the "
            f"later {len(test)}.",
            "The liveticker shows what the control centre published, not when buses physically left; publication lags reality.",
            f"Speed: EV routes = route_short_name EV/EVn or route_desc EV ({info['evRoutes']} routes; types {info['evRouteTypes']}); "
            f"routes whose stops are mostly rail platforms are dropped ({info['evRoutesDroppedRailStops']}). "
            f"Hops dropped: {speed['dropped']}. Scheduled times are rounded to whole minutes, so short hops are noisy.",
            f"Speeds come from the planned (timetabled) EV trips of the 2026 timetable (construction closures), not from "
            f"ad-hoc emergency buses, which have no timetable.",
            f"stationStops: {len(ss)} of {sscount.get('stations')} Swiss rail stations (DIDOK 85xxxxx parents served by route types "
            f"2/100-117) mapped ({sscount}); walkMin from transfers.txt footpaths when present, else ceil(walkM / 80 m/min).",
        ],
    }
    os.makedirs(a.out, exist_ok=True)
    body = {k: v for k, v in model.items() if k != "stationStops"}
    txt = json.dumps(body, ensure_ascii=False, indent=1)[:-2]   # one line per station keeps the file small and diffable
    rows = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in sorted(ss.items()))
    with open(os.path.join(a.out, "model.json"), "w") as f:
        f.write(txt + ',\n "stationStops": {\n' + rows + "\n }\n}\n")
    with open(os.path.join(a.out, "scorecard.json"), "w") as f:
        json.dump(sc, f, ensure_ascii=False, indent=1)
    # ---------------- print
    print(f"busFromFirstVersion {bff}  busInAnyVersion {bany}")
    for k, v in lead.items():
        print(f"leadTimeMin.{k}: {v}")
    print(f"titles only: {tit}")
    print(f"shortages: {len(sh)} incidents; within N min: {within}; coverage: {[(c['bin'], c['observed'], c['n']) for c in cov]}")
    print(f"roadFactor {speed['roadFactor']} ({speed['roadFactorMethod']})")
    print(f"kmh {speed['kmh']}; bands {[(b['maxKm'], b['n'], b['median']) for b in speed['byStraightKm']]}; dwell {speed['dwellSec']}")
    print(f"routes {speed['routes']} trips {speed['trips']} hops {speed['hops']} dropped {speed['dropped']}")
    print(f"holdout MAE {holdout['maeMin']} bias {holdout['biasMin']} testHops {holdout['testHops']}")
    print(f"ev routes info {info}")
    print(f"stationStops {len(ss)} {sscount}")
    for k in ("8500218", "8502113"):
        print(k, ss.get(k))
    print(f"headline: {sc['headline']}")
    print(f"runtime: part A {ta:.0f} s, part B {tb:.0f} s, total {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
