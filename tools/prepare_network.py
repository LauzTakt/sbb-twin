#!/usr/bin/env python3
"""Build rail-twin's track geometry from the federal rail network (BAV "Schienennetz").

Every leg between two consecutive stops of a timetable trip gets the shortest path on the real
track graph (one undirected edge per BAV Netzsegment, never mixing gauges), validated against the
straight-line distance and the minimum scheduled running time.

Outputs in rail-twin/data/:
  network.json.gz      {"version":1, "nodes":[[stationId|null, name, lon, lat]...],
                        "edges":[[bavId, aNode, bNode, tracks, lengthM, [lon,lat,...]]...]}
  paths.json.gz        {"<from>><to>": [lengthM, "bav", [signed edge refs]]}  (+i = edge i-1 a->b)
  trips-meta.json.gz   {"<trip_id>": [trip_short_name, agency_name, route_short_name]}
  network-lines.geojson  simplified base layer, properties {id, tracks}
  coverage.json        counts, plausibility outliers, Lake Zurich check

Run (re-runnable, about a minute):
  uv run --no-project --with pyproj --with numpy python tools/prepare_network.py
"""
import argparse
import collections
import csv
import gzip
import heapq
import io
import json
import math
import os
import re
import sqlite3
import struct
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[1]

NODE_TOL_M = 100.0       # a segment end this close to its referenced node is accepted as is
SNAP_M = 2.0             # "coincident" distance (end on another node / on the other ends at its node)
GAP_MAX_M = 200.0        # an isolated end up to this far from its node is a station-area gap; beyond: quarantine
MATCH_M = 300.0          # fallback station -> node search radius (name must match)
SIBLING_M = 250.0        # gauge/part sub-nodes of a station complex ("Bern RBS", "Montreux MOB", "Aigle [voie 11-16]")
SIBLING_COST = (2.0, 100.0)  # starting/ending at a sub-node costs a*d + b metres, so the main node wins when it works
DETOUR_FACTOR, DETOUR_ADD_M = 2.5, 2000.0
MAX_KMH = 250.0
MIN_RUN_S = 60           # GTFS times are whole minutes: a 0-minute leg is judged as 1 minute
SIMPLIFY_M = 8.0
LAKE_ZURICH = ["8503206", "8503207", "8503208", "8503210", "8503209"]  # Wädenswil .. Pfäffikon SZ via Freienbach SBB
LAKE_ZURICH_EDGES = ["ch14uvag000882%02d" % i for i in range(60, 65)]
JUNCTION_RE = re.compile(r"\((Abzw|Spw|Verzw|Vzw|bif|Wds|Agl|Sptr|embr|c bin)\)|Km-Sprung|saut kilom", re.I)


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def polyline_length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def names_match(a, b):
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    ta, tb = set(na.split()), set(nb.split())
    return ta <= tb or tb <= ta


# ----------------------------------------------------------------------------- GeoPackage / WKB

def wkb_of(blob):
    """Strip the GeoPackage binary header: magic 'GP', version, flags (bit 0 byte order, bits 1-3 envelope)."""
    if blob is None or bytes(blob[:2]) != b"GP":
        raise ValueError("not a GeoPackage geometry blob")
    envelope = (0, 32, 48, 48, 64, 0, 0, 0)[(blob[3] >> 1) & 7]
    return bytes(blob[8 + envelope:])


def read_wkb(buf, pos=0):
    """Parse ISO/EWKB; returns (("point", (x, y)) | ("line", [(x, y)...]) | ("multi", [parts]), next_pos). XY only."""
    bo = "<" if buf[pos] == 1 else ">"
    code = struct.unpack_from(bo + "I", buf, pos + 1)[0]
    pos += 5
    has_z, has_m = bool(code & 0x80000000), bool(code & 0x40000000)
    if code & 0x20000000:  # EWKB SRID
        pos += 4
    code &= 0x0FFFFFFF
    base, iso = code % 1000, code // 1000
    has_z |= iso in (1, 3)
    has_m |= iso in (2, 3)
    dim = 2 + has_z + has_m
    if base == 1:
        return ("point", struct.unpack_from(bo + "dd", buf, pos)), pos + 8 * dim
    if base == 2:
        n = struct.unpack_from(bo + "I", buf, pos)[0]
        vals = struct.unpack_from(bo + "d" * (n * dim), buf, pos + 4)
        return ("line", [(vals[i], vals[i + 1]) for i in range(0, n * dim, dim)]), pos + 4 + 8 * n * dim
    if base in (4, 5, 7, 9, 11):  # multipoint, multilinestring, collection, compoundcurve, multicurve
        n = struct.unpack_from(bo + "I", buf, pos)[0]
        pos += 4
        parts = []
        for _ in range(n):
            g, pos = read_wkb(buf, pos)
            parts.append(g)
        return ("multi", parts), pos
    raise NotImplementedError(f"WKB geometry type {code} (curved geometry?) is not supported")


def line_parts(g):
    kind, v = g
    if kind == "line":
        return [v]
    if kind == "multi":
        return [p for part in v for p in line_parts(part)]
    return []


def first_point(g):
    kind, v = g
    if kind == "point":
        return v
    if kind == "line":
        return v[0]
    return first_point(v[0])


def join_parts(parts):
    """Concatenate the parts of a multi-line into one polyline (orienting each part to continue the previous one)."""
    parts = [p for p in parts if p]
    pts = list(parts[0])
    if len(parts) > 1 and min(dist(pts[0], parts[1][0]), dist(pts[0], parts[1][-1])) < \
            min(dist(pts[-1], parts[1][0]), dist(pts[-1], parts[1][-1])):
        pts.reverse()
    for part in parts[1:]:
        if dist(pts[-1], part[-1]) < dist(pts[-1], part[0]):
            part = part[::-1]
        pts.extend(part)
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    return out


class Grid:
    """Bucket points for radius queries (metres, LV95)."""

    def __init__(self, cell=250.0):
        self.cell, self.buckets = cell, collections.defaultdict(list)

    def add(self, key, p):
        self.buckets[(int(p[0] // self.cell), int(p[1] // self.cell))].append((key, p))

    def near(self, p, r):
        c = self.cell
        k = int(math.ceil(r / c))
        cx, cy = int(p[0] // c), int(p[1] // c)
        found = []
        for i in range(cx - k, cx + k + 1):
            for j in range(cy - k, cy + k + 1):
                for key, q in self.buckets.get((i, j), ()):
                    dd = dist(p, q)
                    if dd <= r:
                        found.append((dd, key))
        return sorted(found)


def load_network(gpkg):
    db = sqlite3.connect(f"file:{gpkg}?mode=ro", uri=True)
    nodes = []
    for rowid, oid, num, name, abbr, parent, geom in db.execute(
            "select id, interlis_oid, Betriebspunkt_Nummer, Betriebspunkt_Name, Betriebspunkt_Abkuerzung,"
            " rUebergeordnet, geom from Netzknoten order by id"):
        nodes.append(dict(oid=oid, num=num, name=name or abbr or oid, abbr=abbr, parent=parent,
                          xy=first_point(read_wkb(wkb_of(geom))[0])))
    segs = []
    for rowid, oid, a, b, tracks, gauge, elec, op, label, km_a, km_b, geom in db.execute(
            "select id, interlis_oid, rAnfangsknoten, rEndknoten, AnzahlStreckengleise, Spurweite,"
            " Elektrifizierung, Infrastrukturbetr_TUAbkuerzung, Betriebspunkt_Name, KmAnfang, KmEnde, geom"
            " from Netzsegment order by id"):
        parts = line_parts(read_wkb(wkb_of(geom))[0])
        segs.append(dict(oid=oid, a_oid=a, b_oid=b, tracks=tracks, gauge=gauge or "", elec=elec, op=op,
                         label=label, km=(km_a, km_b), pts=join_parts(parts) if parts else [], parts=len(parts)))
    db.close()
    return nodes, segs


def gauges_of(value):
    """'mm1435' -> (1435,), 'mm1000_1435' (dual gauge) -> (1000, 1435)."""
    found = tuple(int(v) for v in re.findall(r"\d+", value or ""))
    return found or (0,)


def check_segments(nodes, segs):
    """Orient every segment from its start node to its end node; repair or quarantine far ends."""
    by_oid = {n["oid"]: i for i, n in enumerate(nodes)}
    grid = Grid()
    for i, n in enumerate(nodes):
        grid.add(i, n["xy"])
    report = collections.defaultdict(list)
    for s in segs:
        s["a"], s["b"] = by_oid.get(s["a_oid"]), by_oid.get(s["b_oid"])
        s["status"] = "ok"
        if s["a"] is None or s["b"] is None:
            s["status"] = "quarantine"
            report["quarantined"].append(dict(id=s["oid"], reason="missing node reference"))
            continue
        if len(s["pts"]) < 2:
            s["status"] = "quarantine"
            report["quarantined"].append(dict(id=s["oid"], reason="empty geometry"))
            continue
        pa, pb, pts = nodes[s["a"]]["xy"], nodes[s["b"]]["xy"], s["pts"]
        if dist(pts[0], pb) + dist(pts[-1], pa) < dist(pts[0], pa) + dist(pts[-1], pb):
            pts.reverse()
            report["reversed"].append(dict(id=s["oid"], a=nodes[s["a"]]["name"], b=nodes[s["b"]]["name"]))
    ends_at = collections.defaultdict(list)
    for k, s in enumerate(segs):
        if s["status"] == "ok":
            ends_at[s["a"]].append((k, s["pts"][0]))
            ends_at[s["b"]].append((k, s["pts"][-1]))
    for k, s in enumerate(segs):
        if s["status"] != "ok":
            continue
        for end in ("a", "b"):
            ref = s[end]
            other_end = s["b" if end == "a" else "a"]
            p = s["pts"][0] if end == "a" else s["pts"][-1]
            gap = dist(p, nodes[ref]["xy"])
            if gap <= NODE_TOL_M:
                continue
            info = dict(id=s["oid"], end=end, node=nodes[ref]["name"], gapM=round(gap, 1))
            on_node = [i for dd, i in grid.near(p, SNAP_M) if i not in (ref, other_end)]
            if on_node:
                s[end] = on_node[0]
                info["reattachedTo"] = nodes[on_node[0]]["name"]
                report["repaired"].append(info)
            elif any(j != k and dist(p, q) <= SNAP_M for j, q in ends_at[ref]):
                report["offset_consistent"].append(info)   # the other segments meet here too: node is off-track
            elif gap <= GAP_MAX_M:
                report["gap_kept"].append(info)
            else:
                s["status"] = "quarantine"
                info["reason"] = "end %.0f m from its node" % gap
                report["quarantined"].append(info)
                break
    return report


# ----------------------------------------------------------------------------- timetable

def load_timetable(rail_db):
    db = sqlite3.connect(f"file:{rail_db}?mode=ro", uri=True)
    stations = {idx: dict(id=str(sid), name=name, lon=lon, lat=lat)
                for idx, sid, name, lon, lat in db.execute("select idx, id, name, lon, lat from stations")}
    pairs, ev_pairs, same, legs = {}, set(), 0, 0
    for cat, raw in db.execute("select cat, calls from trips"):
        calls = json.loads(raw)
        for k in range(0, len(calls) - 3, 3):
            a, dep, b, arr = calls[k], calls[k + 2], calls[k + 3], calls[k + 4]
            legs += 1
            if a == b:
                same += 1
                continue
            key = (stations[a]["id"], stations[b]["id"])
            if cat == "EV":  # rail replacement buses run on roads, not on the track
                ev_pairs.add(key)
                continue
            rec = pairs.get(key)
            if rec is None:
                pairs[key] = [arr - dep, 1]
            else:
                rec[0] = min(rec[0], arr - dep)
                rec[1] += 1
    db.close()
    by_id = {s["id"]: s for s in stations.values()}
    return by_id, pairs, dict(legs=legs, same_station_legs=same, ev_only_pairs=len(ev_pairs - set(pairs)))


def load_trip_meta(gtfs_zip):
    """{trip_id: [trip_short_name, agency_name, route_short_name]} for rail-type routes (as timetable.py)."""
    def rows(z, name):
        return csv.DictReader(io.TextIOWrapper(z.open(name + ".txt"), encoding="utf-8-sig", newline=""))

    meta = {}
    with zipfile.ZipFile(gtfs_zip) as z:
        agency = {r["agency_id"]: r["agency_name"] for r in rows(z, "agency")}
        routes = {}
        for r in rows(z, "routes"):
            mode = int(r["route_type"])
            if mode == 2 or 100 <= mode < 200 or mode == 714 or r["route_desc"] == "EV":
                routes[r["route_id"]] = (agency.get(r["agency_id"], ""), r["route_short_name"])
        keys = {('"' + k + '"').encode() for k in routes} | {k.encode() for k in routes}
        with z.open("trips.txt") as stream:
            header = next(csv.reader([next(stream).decode("utf-8-sig")]))
            ir, it, iname = header.index("route_id"), header.index("trip_id"), header.index("trip_short_name")
            if ir != 0:
                raise RuntimeError("trips.txt: route_id is expected as the first column")
            selected = (line.decode("utf-8") for line in stream if line.split(b",", 1)[0] in keys)
            for r in csv.reader(selected):
                agency_name, short = routes[r[ir]]
                meta[r[it]] = [r[iname], agency_name, short]
    return meta, len(routes)


# ----------------------------------------------------------------------------- routing

class Router:
    def __init__(self, nodes, edges):
        self.nodes, self.edges = nodes, edges
        self.adj = collections.defaultdict(lambda: collections.defaultdict(list))  # gauge -> node -> [(m, w, ref)]
        self.node_gauges = collections.defaultdict(set)
        for e, s in enumerate(edges):
            for g in s["gauges"]:
                self.adj[g][s["a"]].append((s["b"], s["length"], e + 1))
                self.adj[g][s["b"]].append((s["a"], s["length"], -(e + 1)))
                self.node_gauges[s["a"]].add(g)
                self.node_gauges[s["b"]].add(g)

    def search(self, sources, targets, bound):
        """Multi-source Dijkstra on (node, gauge) states. sources: [(node, cost)];
        targets: {node: [(key, cost)]}. Returns {key: (cost, state)}, pred."""
        inf = float("inf")
        best_dist, pred, heap = {}, {}, []
        for n, c in sources:
            for g in self.node_gauges.get(n, ()):
                if c < best_dist.get((n, g), inf):
                    best_dist[(n, g)] = c
                    pred[(n, g)] = None
                    heapq.heappush(heap, (c, n, g))
        found = {}
        while heap:
            d0, n, g = heapq.heappop(heap)
            if d0 > best_dist[(n, g)]:
                continue
            if d0 > bound:
                break
            for key, c in targets.get(n, ()):
                if d0 + c < found.get(key, (inf,))[0]:
                    found[key] = (d0 + c, (n, g))
            for m, w, ref in self.adj[g].get(n, ()):
                nd = d0 + w
                if nd < best_dist.get((m, g), inf):
                    best_dist[(m, g)] = nd
                    pred[(m, g)] = ((n, g), ref)
                    heapq.heappush(heap, (nd, m, g))
        return found, pred

    @staticmethod
    def unwind(pred, state):
        refs = []
        while pred[state] is not None:
            state, ref = pred[state]
            refs.append(ref)
        refs.reverse()
        return refs, state[0]


def douglas_peucker(pts, tol):
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = pts[i]
        dx, dy = pts[j][0] - ax, pts[j][1] - ay
        l2 = dx * dx + dy * dy
        worst, wk = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] - ax, pts[k][1] - ay
            t = 0.0 if l2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / l2))
            dd = math.hypot(px - t * dx, py - t * dy)
            if dd > worst:
                worst, wk = dd, k
        if worst > tol:
            keep[wk] = True
            stack.append((i, wk))
            stack.append((wk, j))
    return [p for p, k in zip(pts, keep) if k]


def write_atomic(path, data, gz=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, suffix=".tmp") as tmp:
        if gz:
            with gzip.GzipFile(fileobj=tmp, mode="wb", compresslevel=9, mtime=0) as z:
                z.write(data)
        else:
            tmp.write(data)
    os.replace(tmp.name, path)


def compact(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()


# ----------------------------------------------------------------------------- main

def main():
    cli = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cli.add_argument("--gpkg", type=Path, default=Path("/workspace/sbb/geo/schienennetz_2056_de.gpkg"))
    cli.add_argument("--rail-db", type=Path, default=Path("/workspace/sbb/gtfs/rail-v1.sqlite"))
    cli.add_argument("--gtfs", type=Path, default=Path("/workspace/sbb/gtfs/gtfs_fp2026_20261118.zip"))
    cli.add_argument("--out", type=Path, default=ROOT / "data")
    cli.add_argument("--skip-trips-meta", action="store_true", help="reuse an existing trips-meta.json.gz")
    args = cli.parse_args()
    t0 = time.time()
    to_wgs = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)
    to_lv95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)

    # --- network
    nodes, segs = load_network(args.gpkg)
    log(f"read {len(nodes)} nodes, {len(segs)} segments, {sum(len(s['pts']) for s in segs)} vertices")
    seg_report = check_segments(nodes, segs)
    edges = [s for s in segs if s["status"] == "ok"]
    for s in edges:
        s["length"] = polyline_length(s["pts"])
        s["gauges"] = gauges_of(s["gauge"])
    edge_index = {s["oid"]: e for e, s in enumerate(edges)}
    log(f"kept {len(edges)} edges, quarantined {len(segs) - len(edges)}; reversed {len(seg_report['reversed'])},"
        f" repaired {len(seg_report['repaired'])}, offset-consistent ends {len(seg_report['offset_consistent'])},"
        f" gap ends kept {len(seg_report['gap_kept'])}")
    router = Router(nodes, edges)

    # --- timetable pairs and station -> node mapping
    stations, pairs, tt_stats = load_timetable(args.rail_db)
    used = sorted({sid for pair in pairs for sid in pair})
    sx, sy = to_lv95.transform(np.array([stations[s]["lon"] for s in used], dtype=float),
                               np.array([stations[s]["lat"] for s in used], dtype=float))
    for s, x, y in zip(used, sx, sy):
        stations[s]["xy"] = (float(x), float(y))
    num_to_node = {n["num"]: i for i, n in enumerate(nodes) if n["num"] is not None}
    gtfs_numbers = {int(s) for s in stations if s.isdigit()}
    grid = Grid()
    for i, n in enumerate(nodes):
        grid.add(i, n["xy"])
    match, match_stats, far_matches = {}, collections.Counter(), []
    for sid in used:
        st = stations[sid]
        primary, how = None, None
        if sid.isdigit() and int(sid) in num_to_node:
            primary, how = num_to_node[int(sid)], "exact"
            off = dist(st["xy"], nodes[primary]["xy"])
            if off > 1000:
                far_matches.append(dict(station=sid, name=st["name"], node=nodes[primary]["name"], offM=round(off)))
        else:
            for dd, i in grid.near(st["xy"], MATCH_M):
                if names_match(st["name"], nodes[i]["name"]):
                    primary, how = i, "name"
                    break
        if primary is None:
            match_stats["unmatched"] += 1
            continue
        match_stats[how] += 1
        base, pnode = norm_name(nodes[primary]["name"]), nodes[primary]
        group = [(primary, 0.0)]
        for dd, i in grid.near(pnode["xy"], SIBLING_M):
            n = nodes[i]
            if i == primary or JUNCTION_RE.search(n["name"]):
                continue
            child = n["parent"] is not None and n["parent"] == pnode["oid"]
            if child or (norm_name(n["name"]).startswith(base + " ") and n["num"] not in gtfs_numbers):
                group.append((i, SIBLING_COST[0] * dd + SIBLING_COST[1]))
        if len(group) > 1:
            match_stats["with_sub_nodes"] += 1
        match[sid] = dict(how=how, primary=primary, group=group)
    log(f"{len(pairs)} station pairs (non-EV) over {len(used)} stations; matching {dict(match_stats)}")

    # --- shortest paths, one multi-source search per origin station
    by_source = collections.defaultdict(list)
    for (a, b) in pairs:
        by_source[a].append(b)
    results, reasons = {}, collections.Counter()
    for a, targets in by_source.items():
        straight = {b: dist(stations[a]["xy"], stations[b]["xy"]) for b in targets}
        routable = [b for b in targets if a in match and b in match]
        for b in targets:
            if b not in routable:
                results[(a, b)] = dict(quality="approx", reason="unmatched station", straight=straight[b])
        if a not in match or not routable:
            continue
        tmap = collections.defaultdict(list)
        for b in routable:
            for n, c in match[b]["group"]:
                tmap[n].append((b, c))
        max_cost = max(c for b in routable for n, c in match[b]["group"]) + max(c for n, c in match[a]["group"])
        bound = max(DETOUR_FACTOR * straight[b] + DETOUR_ADD_M for b in routable) + max_cost
        found, pred = router.search(match[a]["group"], tmap, bound)
        for b in routable:
            res = dict(quality="approx", straight=straight[b])
            results[(a, b)] = res
            if b not in found:
                res["reason"] = "no path"
                continue
            refs, start = router.unwind(pred, found[b][1])
            if not refs:
                res["reason"] = "same node"
                continue
            length = sum(edges[abs(r) - 1]["length"] for r in refs)
            min_t = pairs[(a, b)][0]
            kmh = length / max(min_t, MIN_RUN_S) * 3.6
            res.update(length=length, refs=refs, kmh=kmh, min_t=min_t,
                       ratio=length / max(straight[b], 1.0))
            if length > DETOUR_FACTOR * straight[b] + DETOUR_ADD_M:
                res["reason"] = "detour"
            elif kmh > MAX_KMH:
                res["reason"] = "too fast"
            else:
                res["quality"] = "bav"
    for res in results.values():
        if res["quality"] != "bav":
            reasons[res["reason"]] += 1
    n_bav = sum(1 for r in results.values() if r["quality"] == "bav")
    log(f"paths: {n_bav} bav, {len(results) - n_bav} approx {dict(reasons)}")

    # --- geometry out (WGS84, 6 decimals)
    lines = [douglas_peucker(s["pts"], SIMPLIFY_M) for s in segs if len(s["pts"]) >= 2]
    line_segs = [s for s in segs if len(s["pts"]) >= 2]
    flat = [n["xy"] for n in nodes] + [p for s in edges for p in s["pts"]] + [p for ln in lines for p in ln]
    arr = np.array(flat, dtype=float)
    lon, lat = to_wgs.transform(arr[:, 0], arr[:, 1])
    lonlat = [(round(float(x), 6), round(float(y), 6)) for x, y in zip(lon, lat)]
    pos = len(nodes)
    node_rows = [[str(n["num"]) if n["num"] is not None else None, n["name"], *lonlat[i]] for i, n in enumerate(nodes)]
    edge_rows = []
    for s in edges:
        coords = []
        for x, y in lonlat[pos:pos + len(s["pts"])]:
            coords += (x, y)
        pos += len(s["pts"])
        edge_rows.append([s["oid"], s["a"], s["b"], s["tracks"], round(s["length"], 1), coords])
    features = []
    for s, ln in zip(line_segs, lines):
        features.append(dict(type="Feature", properties=dict(id=s["oid"], tracks=s["tracks"]),
                             geometry=dict(type="LineString", coordinates=[list(p) for p in lonlat[pos:pos + len(ln)]])))
        pos += len(ln)

    out = args.out
    write_atomic(out / "network.json.gz", compact(dict(version=1, nodes=node_rows, edges=edge_rows)), gz=True)
    paths_out = {f"{a}>{b}": [round(r["length"], 1), "bav", r["refs"]]
                 for (a, b), r in sorted(results.items()) if r["quality"] == "bav"}
    write_atomic(out / "paths.json.gz", compact(paths_out), gz=True)
    write_atomic(out / "network-lines.geojson", compact(dict(type="FeatureCollection", features=features)))
    if args.skip_trips_meta and (out / "trips-meta.json.gz").exists():
        n_trips = n_rail_routes = None
    else:
        meta, n_rail_routes = load_trip_meta(args.gtfs)
        n_trips = len(meta)
        write_atomic(out / "trips-meta.json.gz", compact(meta), gz=True)
        log(f"trips-meta: {n_trips} rail trips on {n_rail_routes} routes")

    # --- sanity: jumps between consecutive edges of accepted paths
    jumps = []
    for (a, b), r in results.items():
        if r["quality"] != "bav":
            continue
        worst = 0.0
        for r1, r2 in zip(r["refs"], r["refs"][1:]):
            e1, e2 = edges[abs(r1) - 1], edges[abs(r2) - 1]
            p = e1["pts"][-1] if r1 > 0 else e1["pts"][0]
            q = e2["pts"][0] if r2 > 0 else e2["pts"][-1]
            worst = max(worst, dist(p, q))
        r["jump"] = worst
        jumps.append(worst)

    # --- Lake Zurich check
    legs, total, ids = [], 0.0, []
    for a, b in zip(LAKE_ZURICH, LAKE_ZURICH[1:]):
        r = results.get((a, b))
        leg = dict(pair=f"{a}>{b}", names=[stations[a]["name"], stations[b]["name"]] if a in stations and b in stations else None,
                   quality=r["quality"] if r else "missing pair")
        if r and r.get("refs"):
            leg["lengthM"] = round(r["length"], 1)
            leg["edges"] = [edges[abs(x) - 1]["oid"] + ("" if x > 0 else " (reversed)") for x in r["refs"]]
            leg["tracks"] = [edges[abs(x) - 1]["tracks"] for x in r["refs"]]
            total += r["length"]
            ids += [edges[abs(x) - 1]["oid"] for x in r["refs"] if x > 0]
        legs.append(leg)
    lake = dict(legs=legs, totalM=round(total, 1), expectedEdges=LAKE_ZURICH_EDGES,
                ok=ids == LAKE_ZURICH_EDGES and all(l["quality"] == "bav" for l in legs)
                and all(t >= 2 for l in legs for t in l.get("tracks", [0])))

    # --- coverage report
    def case(key, r):
        a, b = key
        return dict(pair=f"{a}>{b}", names=[stations[a]["name"], stations[b]["name"]], reason=r.get("reason"),
                    lengthKm=round(r["length"] / 1000, 2) if "length" in r else None,
                    straightKm=round(r["straight"] / 1000, 2), ratio=round(r["ratio"], 2) if "ratio" in r else None,
                    minRunMin=round(r["min_t"] / 60, 1) if "min_t" in r else None,
                    kmh=round(r["kmh"]) if "kmh" in r else None)

    swiss = [k for k in results if k[0].startswith("85") and k[1].startswith("85")]
    swiss_bav = sum(1 for k in swiss if results[k]["quality"] == "bav")
    rejected = [(k, r) for k, r in results.items() if r["quality"] != "bav" and "length" in r]
    accepted = [(k, r) for k, r in results.items() if r["quality"] == "bav"]
    unmatched_swiss = collections.Counter()
    for (a, b), (t, n) in pairs.items():
        for s in (a, b):
            if s.startswith("85") and s not in match:
                unmatched_swiss[s] += n
    coverage = dict(
        generated=time.strftime("%Y-%m-%dT%H:%M:%S"),
        inputs=dict(gpkg=str(args.gpkg), railDb=str(args.rail_db), gtfs=str(args.gtfs)),
        parameters=dict(nodeTolM=NODE_TOL_M, snapM=SNAP_M, gapMaxM=GAP_MAX_M, matchM=MATCH_M, siblingM=SIBLING_M,
                        siblingCost=SIBLING_COST, detour=[DETOUR_FACTOR, DETOUR_ADD_M], maxKmh=MAX_KMH,
                        minRunS=MIN_RUN_S, simplifyM=SIMPLIFY_M),
        network=dict(nodes=len(nodes), segments=len(segs), edgesKept=len(edges), edgesQuarantined=len(segs) - len(edges),
                     vertices=sum(len(s["pts"]) for s in edges), lengthKm=round(sum(s["length"] for s in edges) / 1000, 1),
                     reversed=seg_report["reversed"], repaired=seg_report["repaired"],
                     quarantined=seg_report["quarantined"],
                     endsOffsetConsistent=len(seg_report["offset_consistent"]),
                     endsGapKept=sorted(seg_report["gap_kept"], key=lambda x: -x["gapM"]),
                     gauges=dict(collections.Counter(s["gauge"] for s in edges))),
        stations=dict(inPairs=len(used), matchedExact=match_stats["exact"], matchedByName=match_stats["name"],
                      unmatched=match_stats["unmatched"], withSubNodes=match_stats["with_sub_nodes"],
                      unmatchedSwissByLegCount=[dict(id=s, name=stations[s]["name"], trips=n)
                                                for s, n in unmatched_swiss.most_common(25)],
                      exactMatchFarFromGtfsCoord=far_matches),
        pairs=dict(total=len(results), bav=n_bav, approx=len(results) - n_bav, approxReasons=dict(reasons),
                   swissTotal=len(swiss), swissBav=swiss_bav, swissBavShare=round(swiss_bav / max(len(swiss), 1), 4),
                   legsInTimetable=tt_stats["legs"], sameStationLegsSkipped=tt_stats["same_station_legs"],
                   evOnlyPairsSkipped=tt_stats["ev_only_pairs"],
                   maxJumpBetweenEdgesM=round(max(jumps or [0]), 1),
                   pathsWithJumpOver20M=sum(1 for j in jumps if j > 20)),
        plausibility=dict(
            worstRejectedDetour=[case(k, r) for k, r in sorted(
                [x for x in rejected if x[1]["reason"] == "detour"], key=lambda x: -x[1]["ratio"])[:15]],
            worstRejectedSpeed=[case(k, r) for k, r in sorted(
                [x for x in rejected if x[1]["reason"] == "too fast"], key=lambda x: -x[1]["kmh"])[:15]],
            highestAcceptedDetour=[case(k, r) for k, r in sorted(
                [x for x in accepted if x[1]["straight"] > 500], key=lambda x: -x[1]["ratio"])[:15]],
            fastestAccepted=[case(k, r) for k, r in sorted(accepted, key=lambda x: -x[1]["kmh"])[:10]]),
        lakeZurich=lake,
        tripsMeta=dict(trips=n_trips, railRoutes=n_rail_routes),
    )
    coverage["outputs"] = {p.name: p.stat().st_size for p in sorted(out.glob("*")) if p.suffix != ".tmp"}
    write_atomic(out / "coverage.json", json.dumps(coverage, ensure_ascii=False, indent=1).encode())
    coverage["outputs"]["coverage.json"] = (out / "coverage.json").stat().st_size

    # --- summary
    print()
    print("== rail-twin network summary ==")
    print(f"nodes {len(nodes)} | edges kept {len(edges)} / quarantined {len(segs) - len(edges)}"
          f" | {coverage['network']['lengthKm']} km | reversed {len(seg_report['reversed'])}, repaired {len(seg_report['repaired'])}")
    for q in seg_report["quarantined"]:
        print("   quarantined:", q)
    for q in seg_report["repaired"]:
        print("   repaired:", q)
    print(f"stations in pairs {len(used)}: exact {match_stats['exact']}, by name {match_stats['name']},"
          f" unmatched {match_stats['unmatched']} (with sub-nodes {match_stats['with_sub_nodes']})")
    print(f"pairs {len(results)}: bav {n_bav}, approx {len(results) - n_bav} {dict(reasons)}")
    print(f"swiss pairs {len(swiss)}: bav {swiss_bav} ({100 * swiss_bav / max(len(swiss), 1):.1f}%)")
    print(f"max jump between consecutive edges in a path: {coverage['pairs']['maxJumpBetweenEdgesM']} m"
          f" ({coverage['pairs']['pathsWithJumpOver20M']} paths > 20 m)")
    print("lake zurich:", "OK" if lake["ok"] else "FAILED", f"total {lake['totalM']} m")
    for leg in lake["legs"]:
        print("   ", leg["pair"], leg.get("names"), leg["quality"], leg.get("lengthM"), leg.get("edges"))
    print("worst rejected (detour):")
    for c in coverage["plausibility"]["worstRejectedDetour"][:6]:
        print("   ", c)
    print("worst rejected (speed):")
    for c in coverage["plausibility"]["worstRejectedSpeed"][:6]:
        print("   ", c)
    print("outputs:", coverage["outputs"])
    print(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
