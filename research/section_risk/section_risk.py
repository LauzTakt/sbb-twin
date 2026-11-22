#!/usr/bin/env python3
"""Section risk map: which stretches of the Swiss rail network concentrate disruptions, and does the ranking
learnt on one period predict where the disruptions of the next period happen?

Run (about a minute, one CPU):  /opt/venv/bin/python research/section_risk/section_risk.py
Writes, next to this script:     segments.geojson, scorecard.json  (every number in the scorecard comes from here)

Inputs (local, not committed):
  /workspace/sbb/Daten/extern-liveticker   VIA incidents (incident + incident_audit), 2024-03 .. 2026-10-12
  data/network.json.gz, data/paths.json.gz  the twin's BAV track graph and stop-to-stop track paths
  data/days/day-*.json.gz                   the twin's GTFS day files (served stations, trains per segment)

Method (README.md has the details):
  segments   the BAV track graph cut at every station served by a train (twin's GTFS day files), at every junction
             and track end, and at every station a training incident names; each segment is one stretch of track
             between two consecutive served stations (or a station and a junction). Ranked: segments with trains,
             plus any segment a training incident touched.
  exposure   km of track and trains per day (Monday 2026-11-23, every train run counted once per segment).
  incidents  each VIA incident "A - B" goes to the segments of the shortest track path from A to B ("A - B and C":
             both branches), spread evenly so it counts once; "A" alone: the segments at station A.
  model      Poisson regression of the training-period counts on log km, log(1 + trains per day), single-track
             share and the log of past incidents on other segments within ~h km, then Poisson-gamma empirical
             Bayes: rate = mu * (y + a) / (mu + a). h and a are chosen on 2024-03..2024-12 -> 2025.
  check      refit on 2024-03..2025-12, test once on 2026-01..2026-10-12: share of test incidents that fall in the
             top 5/10/20 % of segments (recall@k), against rankings by track length, trains per day, train-km and
             the raw training counts, with paired bootstrap 95 % intervals (incidents; weeks as a check).
"""
import gzip
import heapq
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from scipy.special import gammaln

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / 'data'
LT = Path('/workspace/sbb/Daten/extern-liveticker')
sys.path.insert(0, '/workspace/sbb/history')
from build_effects import KIND, norm  # noqa: E402  (same name normalisation as the history study)

TZ = 'Europe/Zurich'
EXPORT_END = '2026-10-12'                    # the liveticker export was taken on 2026-10-12
PERIODS = {'fit': ('2024-03-01', '2025-01-01'), 'val': ('2025-01-01', '2026-01-01'),
           'train': ('2024-03-01', '2026-01-01'), 'test': ('2026-01-01', EXPORT_END)}
TRAFFIC_DAY = 'day-2026-11-23.json.gz'       # a Monday of the twin's timetable
KS = (0.05, 0.10, 0.20)
NBOOT = 2000
SEED = 20261122
SIMPLIFY_M = 15.0

# Contract cause groups (research/forecast-contract.md, section 1), the same EG codes as research/duration/model.json.
CAUSE = {
    'planned': ['EG_004', 'EG_158'],
    'infrastructure': ['EG_001', 'EG_006', 'EG_008', 'EG_010', 'EG_011', 'EG_028', 'EG_034', 'EG_196'],
    'rolling_stock': ['EG_013', 'EG_014', 'EG_111', 'EG_117', 'EG_119', 'EG_125', 'EG_191', 'EG_197'],
    'person': ['EG_046', 'EG_047', 'EG_122', 'EG_194', 'EG_199'],
    'external': ['EG_015', 'EG_016', 'EG_017', 'EG_018', 'EG_019', 'EG_020', 'EG_021', 'EG_022', 'EG_023',
                 'EG_025', 'EG_026', 'EG_030', 'EG_039', 'EG_049', 'EG_050', 'EG_052', 'EG_070', 'EG_100',
                 'EG_101', 'EG_102', 'EG_104', 'EG_110', 'EG_112', 'EG_113', 'EG_114', 'EG_135', 'EG_190', 'EG_192', 'EG_193',
                 'EG_195', 'EG_198', 'EG_200'],
}
CAUSE_OF = {code: g for g, codes in CAUSE.items() for code in codes}


def cause_group(code):
    return CAUSE_OF.get(code, 'other')


def metres(lon1, lat1, lon2, lat2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6_371_008.8


# ---------------------------------------------------------------- network and segments
class Net:
    def __init__(self):
        net = json.load(gzip.open(DATA / 'network.json.gz'))
        self.nodes, self.edges = net['nodes'], net['edges']
        self.node_of = {n[0]: i for i, n in enumerate(self.nodes)}
        self.by_name = defaultdict(list)
        for i, n in enumerate(self.nodes):
            self.by_name[norm(n[1])].append(i)
        self.adj = defaultdict(list)                       # node -> [(edge, other node)]
        for i, e in enumerate(self.edges):
            self.adj[e[1]].append((i, e[2]))
            self.adj[e[2]].append((i, e[1]))
        self.paths = json.load(gzip.open(DATA / 'paths.json.gz'))

    def route(self, src, dst, allowed=None, cap=150_000.0):
        """Shortest track path (edge list) from any node in src to any node in dst, or None."""
        dist, prev, dst = {}, {}, set(dst)
        heap = [(0.0, s) for s in src]
        for s in src:
            dist[s] = 0.0
        heapq.heapify(heap)
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist.get(u, math.inf):
                continue
            if u in dst:
                out = []
                while u in prev:
                    u, ei = prev[u]
                    out.append(ei)
                return d, out[::-1]
            if d > cap:
                return None
            for ei, w in self.adj[u]:
                if allowed is not None and not allowed[ei]:
                    continue
                nd = d + self.edges[ei][4]
                if nd < dist.get(w, math.inf):
                    dist[w], prev[w] = nd, (u, ei)
                    heapq.heappush(heap, (nd, w))
        return None


def rail_trips(day):
    d = json.load(gzip.open(DATA / 'days' / day))
    stops = d['stops']
    for t in d['trips']:
        if t[1] == 'EV':                                    # replacement buses run on roads
            continue
        s = t[4]
        yield [stops[s[i]][0] for i in range(0, len(s), 3)]


def build_segments(net, named=()):
    served = set()
    for f in sorted((DATA / 'days').glob('day-*.json.gz')):
        for ids in rail_trips(f.name):
            served.update(net.node_of[x] for x in ids if x in net.node_of)
    deg = Counter()
    for e in net.edges:
        deg[e[1]] += 1
        deg[e[2]] += 1
    cut = served | set(named) | {i for i in range(len(net.nodes)) if deg[i] != 2}
    seg_of = np.full(len(net.edges), -1)
    segs = []

    def walk(u, ei, w):
        sid = len(segs)
        seq, cur = [(ei, net.edges[ei][1] == u)], w
        seg_of[ei] = sid
        while cur not in cut:
            nxt = [(ej, x) for ej, x in net.adj[cur] if seg_of[ej] < 0]
            if not nxt:
                break
            ej, x = nxt[0]
            seq.append((ej, net.edges[ej][1] == cur))
            seg_of[ej] = sid
            cur = x
        segs.append({'u': u, 'v': cur, 'seq': seq})

    for u in sorted(cut):
        for ei, w in net.adj[u]:
            if seg_of[ei] < 0:
                walk(u, ei, w)
    for ei, e in enumerate(net.edges):                    # closed loops without a cut node
        if seg_of[ei] < 0:
            walk(e[1], ei, e[2])
    for s in segs:
        lens = np.array([net.edges[ei][4] for ei, _ in s['seq']])
        single = np.array([net.edges[ei][3] == 1 for ei, _ in s['seq']])
        s['km'] = lens.sum() / 1000
        s['single'] = float((lens * single).sum() / max(lens.sum(), 1e-9))
    return segs, seg_of, served


def traffic(net, seg_of, nseg, day, cache):
    """Trains per day on each segment: every train run counted once per segment it uses."""
    count = np.zeros(nseg)
    missing = 0
    for ids in rail_trips(day):
        seq = [net.node_of[x] for x in ids if x in net.node_of]
        used = set()
        for a, b in zip(seq, seq[1:]):
            if a == b:
                continue
            key = (a, b)
            if key not in cache:
                p = net.paths.get(f'{net.nodes[a][0]}>{net.nodes[b][0]}') or net.paths.get(f'{net.nodes[b][0]}>{net.nodes[a][0]}')
                if p:
                    cache[key] = [abs(r) - 1 for r in p[2]]
                else:                                      # a leg over a stop the network lacks: route it
                    na, nb = net.nodes[a], net.nodes[b]
                    straight = metres(na[2], na[3], nb[2], nb[3])
                    r = net.route([a], [b], cap=3 * straight + 5000)
                    cache[key] = r[1] if r else []
                    missing += not r
            used.update(seg_of[ei] for ei in cache[key])
        for s in used:
            count[s] += 1
    return count, missing


# ---------------------------------------------------------------- incidents
def parse_section(text):
    """'A - B' -> [(A, B)]; 'A - B and C' -> [(A, B), (A, C)]; 'A' -> [(A, None)]."""
    text = text.strip()
    if ' - ' not in text:
        return [(text, None)]
    a, rest = text.split(' - ', 1)
    out = []
    for part in rest.split(' and '):
        if ' - ' in part:
            x, y = part.split(' - ', 1)
            out.append((x.strip(), y.strip()))
        else:
            out.append((a.strip(), part.strip()))
    return out


def load_incidents():
    cur = pd.read_csv(LT / 'incident_202610121914.csv')
    aud = pd.read_csv(LT / 'incident_audit_202610121914.csv')
    v = pd.concat([aud, cur], ignore_index=True)
    v['t'] = pd.to_datetime(v.last_modified_date, utc=True, format='mixed').dt.tz_convert(TZ)
    pre = v.summary_en.fillna('').str.extract(r'^([^:]+):\s*(.*)$', expand=True)
    v['kind'], v['sect'] = pre[0].map(KIND), pre[1]
    out, withdrawn = [], 0
    for iid, g in v.groupby('id'):
        g = g.sort_values('t')
        act = g[g.kind.isin(['interrupted', 'limited'])]
        if act.empty:
            continue
        ended = ((g.kind == 'resumed') | (g.lifecycle == 'ENDED')).any()
        if g.lifecycle.iloc[-1] == 'DELETED' and not ended:   # withdrawn (entered by mistake)
            withdrawn += 1
            continue
        reasons = act.reason_id_fk.dropna()
        # the location label: the last active version (most refined), then the earlier ones as fallbacks
        texts = list(dict.fromkeys(act.sect.iloc[::-1].dropna().str.strip()))
        out.append({'id': str(iid), 't': act.t.iloc[0], 'texts': texts,
                    'cause': cause_group(reasons.iloc[0] if len(reasons) else None),
                    'lang': act.origin_language.iloc[0],
                    'title': act.summary_en.iloc[-1]})
    return out, withdrawn


class Mapper:
    def __init__(self, net, segs, seg_of, ranked):
        self.net, self.segs, self.seg_of = net, segs, seg_of
        self.allowed = np.array([ranked[seg_of[ei]] for ei in range(len(net.edges))])
        self.ranked = ranked
        self.foreign = {}
        for f in sorted((DATA / 'days').glob('day-*.json.gz')):
            for s in json.load(gzip.open(f))['stops']:
                self.foreign.setdefault(norm(s[1]), (s[2], s[3]))
        self.ranked_nodes = sorted({x for s, ok in zip(segs, ranked) if ok for x in (s['u'], s['v'])})

    def nodes(self, name):
        return self.net.by_name.get(norm(name), [])

    def adjacent(self, nodes):
        """Segments at a station: those with trains, else all of them (a line closed in the twin's timetable)."""
        at = {self.seg_of[ei] for u in nodes for ei, _ in self.net.adj[u]}
        return sorted({x for x in at if self.ranked[x]} or at)

    def toward(self, swiss, foreign_name):
        """Swiss part of a cross-border section: route to the ranked node nearest the foreign station."""
        xy = self.foreign.get(norm(foreign_name))
        if xy is None:
            return None
        own = min(metres(*self.net.nodes[u][2:4], *xy) for u in swiss)
        best = min((metres(*self.net.nodes[u][2:4], *xy), u) for u in self.ranked_nodes if u not in swiss)
        if best[0] > 40_000 or best[0] >= own:
            return None
        return [best[1]]

    def branch(self, a, b):
        na = self.nodes(a)
        nb = self.nodes(b) if b else []
        kind = 'section'
        if na and b and not nb:
            nb, kind = self.toward(na, b) or [], 'cross_border'
        elif nb and not na:
            na, nb, kind = nb, self.toward(nb, a) or [], 'cross_border'
        if not na:
            return None, 'unmatched'
        if not nb:
            segs = self.adjacent(na)
            return (segs, 'station' if not b else 'station_fallback') if segs else (None, 'unmatched')
        straight = min(metres(*self.net.nodes[x][2:4], *self.net.nodes[y][2:4]) for x in na for y in nb)
        cap = 3 * straight + 15_000
        r = self.net.route(na, nb, self.allowed, cap=cap) or self.net.route(na, nb, None, cap=cap)
        if r is None:
            return None, 'no_path'
        if not r[1]:                                       # A and B are the same node
            segs = self.adjacent(na)
            return (segs, 'station') if segs else (None, 'unmatched')
        return list(dict.fromkeys(self.seg_of[ei] for ei in r[1])), kind

    def map(self, inc):
        """Segment weights (summing to 1) for an incident, trying its section texts in turn."""
        for text in inc['texts']:
            parts = [self.branch(a, b) for a, b in parse_section(text)]
            ok = [p for p in parts if p[0]]
            if ok:
                w = defaultdict(float)
                for segs, _ in ok:
                    for s in segs:
                        w[s] += 1 / len(segs) / len(ok)
                return dict(w), ok[0][1], text
        return None, parts[0][1] if inc['texts'] else 'unmatched', inc['texts'][0] if inc['texts'] else ''


# ---------------------------------------------------------------- model
def fit_poisson(X, y, offset, l2=1e-3):
    beta = np.zeros(X.shape[1])
    beta[0] = math.log(max(y.sum(), 1e-9) / np.exp(offset).sum())
    pen = l2 * np.eye(X.shape[1])
    pen[0, 0] = 0
    for _ in range(100):
        eta = X @ beta + offset
        mu = np.exp(eta)
        z = eta - offset + (y - mu) / mu
        new = np.linalg.solve(X.T @ (mu[:, None] * X) + pen, X.T @ (mu * z))
        if np.max(np.abs(new - beta)) < 1e-9:
            beta = new
            break
        beta = new
    return beta


def nb_alpha(y, mu):
    def nll(la):
        a = math.exp(la)
        return -np.sum(gammaln(y + a) - gammaln(a) + a * np.log(a / (a + mu)) + y * np.log(mu / (a + mu)))
    return math.exp(minimize_scalar(nll, bounds=(-6, 8), method='bounded').x)


def years(period):
    a, b = (pd.Timestamp(x) for x in PERIODS[period])
    return (b - a).days / 365.25


def top_masks(score, tiebreak):
    order = np.lexsort((tiebreak, -score))
    n = len(score)
    masks = []
    for k in KS:
        m = np.zeros(n, bool)
        m[order[:int(round(k * n))]] = True
        masks.append(m)
    return order, masks


def hits(W, masks):
    """Per incident, the share of its weight inside each top set: (incidents, len(KS))."""
    return np.column_stack([W[:, m].sum(1) for m in masks])


# ---------------------------------------------------------------- geometry
def simplify(pts, tol):
    n = len(pts)
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = pts[j] - pts[i]
        d = pts[i + 1:j] - pts[i]
        L = math.hypot(*seg)
        dist = np.hypot(d[:, 0], d[:, 1]) if L == 0 else np.abs(seg[0] * d[:, 1] - seg[1] * d[:, 0]) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack += [(i, m), (m, j)]
    return keep


def seg_coords(net, s):
    coords = []
    for ei, fwd in s['seq']:
        c = net.edges[ei][5]
        pts = [(c[i], c[i + 1]) for i in range(0, len(c), 2)]
        if not fwd:
            pts = pts[::-1]
        coords += pts[1:] if coords and coords[-1] == pts[0] else pts
    a = np.array(coords)
    lat0 = math.radians(a[:, 1].mean())
    xy = np.column_stack([a[:, 0] * 111_320 * math.cos(lat0), a[:, 1] * 110_540])
    a = a[simplify(xy, SIMPLIFY_M)]
    return [[round(x, 5), round(y, 5)] for x, y in a]


# ---------------------------------------------------------------- main
BANDWIDTHS_KM = (None, 5, 10, 20, 40)   # regional covariate: past incidents within ~h km (None: not used)
ALPHAS = (None, 0.03, 0.1, 0.3, 1.0, 3.0, math.inf)   # gamma shape; None = negative-binomial ML, inf = prior only


def midpoints(net, segs, idx):
    out = []
    for s in idx:
        ei, _ = segs[s]['seq'][len(segs[s]['seq']) // 2]
        c = net.edges[ei][5]
        k = (len(c) // 4) * 2
        out.append((c[k], c[k + 1]))
    a = np.array(out)
    return np.column_stack([a[:, 0] * 111.32 * math.cos(math.radians(46.8)), a[:, 1] * 110.54])


def main():
    rng = np.random.default_rng(SEED)
    net = Net()
    incs, withdrawn = load_incidents()

    def in_period(i, p):
        a, b = (pd.Timestamp(x, tz=TZ) for x in PERIODS[p])
        return a <= i['t'] < b

    # stations named by training incidents also cut the network (lines without trains in the twin's timetable)
    named = {u for i in incs if in_period(i, 'train') for t in i['texts'] for ab in parse_section(t)
             for x in ab if x for u in net.by_name.get(norm(x), [])}
    segs, seg_of, served = build_segments(net, named)
    cache, unrouted, per_day = {}, 0, {}
    for f in sorted((DATA / 'days').glob('day-*.json.gz')):
        per_day[f.name], miss = traffic(net, seg_of, len(segs), f.name, cache)
        unrouted += miss
    trains = per_day[TRAFFIC_DAY].copy()
    other = np.max([v for k, v in per_day.items() if k != TRAFFIC_DAY], axis=0)
    trains[trains == 0] = other[trains == 0]               # lines without trains that Monday: busiest other day
    served_seg = trains > 0

    mapper = Mapper(net, segs, seg_of, served_seg)
    kinds, unmatched = Counter(), []
    for inc in incs:
        w, kind, text = mapper.map(inc)
        inc['w'], inc['kind'], inc['text'] = w, kind, text
        kinds[kind] += 1
        if w is None:
            unmatched.append(text)
    mapped = [i for i in incs if i['w']]
    # ranked universe: segments with trains, plus any segment a training incident touched
    universe = served_seg.copy()
    for i in mapped:
        if in_period(i, 'train'):
            universe[list(i['w'])] = True
    idx = np.flatnonzero(universe)
    pos = {s: j for j, s in enumerate(idx)}
    km = np.array([segs[s]['km'] for s in idx]).clip(min=0.05)
    tr = trains[idx]
    single = np.array([segs[s]['single'] for s in idx])
    xy = midpoints(net, segs, idx)
    D2 = ((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1)
    np.fill_diagonal(D2, np.inf)                           # leave the segment itself out of its region
    print(f'{len(segs)} segments, {len(idx)} ranked ({km.sum():.0f} km), {len(served)} served nodes, '
          f'{unrouted} legs not routed')
    print(f'{len(incs)} incidents ({withdrawn} withdrawn left out), mapped {len(mapped)}: {dict(kinds)}')

    def matrix(period):
        rows = [i for i in mapped if in_period(i, period)]
        W = np.zeros((len(rows), len(idx)))
        for r, i in enumerate(rows):
            for s, x in i['w'].items():
                if s in pos:                               # weight off the ranked universe is a miss for all
                    W[r, pos[s]] += x
        return rows, W

    tiebreak = rng.random(len(idx))                        # fixed random order among equal scores

    def model_rates(y, period, h, a):
        """Expected incidents per year per segment for bandwidth h and gamma shape a."""
        cols = [np.ones(len(idx)), np.log(km), np.log1p(tr), single]
        if h is not None:
            region = (np.exp(-D2 / (2 * h * h)) * y[None, :]).sum(1)
            cols.append(np.log(region + 0.01))
        X = np.column_stack(cols)
        T = years(period)
        beta = fit_poisson(X, y, np.full(len(y), math.log(T)))
        mu = np.exp(X @ beta) * T
        a_used = nb_alpha(y, mu) if a is None else a
        rate = mu / T if a_used == math.inf else mu * (y + a_used) / (mu + a_used) / T
        return rate, beta, a_used

    def baselines(y):
        return {'km': km, 'trains': tr, 'train_km': tr * km, 'history': y + 1e-9 * tr / tr.max()}

    # 1) choose bandwidth and shrinkage out of time inside the training period: fit 2024-03..12, validate 2025
    fit_rows, W_fit = matrix('fit')
    val_rows, W_val = matrix('val')
    y_fit = W_fit.sum(0)
    grid = []
    for h in BANDWIDTHS_KM:
        for a in ALPHAS:
            rate, _, a_used = model_rates(y_fit, 'fit', h, a)
            r = hits(W_val, top_masks(rate, tiebreak)[1]).mean(0)
            grid.append({'bandwidthKm': h, 'gammaShape': 'ML' if a is None else ('prior only' if a == math.inf else a),
                         'gammaShapeUsed': round(float(a_used), 3) if a_used != math.inf else None,
                         'recall': [round(float(x), 3) for x in r], 'mean': float(r.mean())})
    base_val = {m: hits(W_val, top_masks(sc, tiebreak)[1]).mean(0) for m, sc in baselines(y_fit).items()}
    best = max(grid, key=lambda g: g['mean'])
    h_best = best['bandwidthKm']
    a_best = {'ML': None, 'prior only': math.inf}.get(best['gammaShape'], best['gammaShape'])
    for g in sorted(grid, key=lambda g: -g['mean'])[:8]:
        print('validation 2025', g)
    for m, r in base_val.items():
        print(f'validation 2025  {m:8s} {np.round(r, 3)} mean {r.mean():.3f}')

    # 2) refit on the whole training period with the chosen settings, test once on 2026
    train_rows, W_train = matrix('train')
    test_rows, W_test = matrix('test')
    y_train = W_train.sum(0)
    rate, beta, a_used = model_rates(y_train, 'train', h_best, a_best)
    methods = {'model': rate, **baselines(y_train)}
    masks = {m: top_masks(sc, tiebreak)[1] for m, sc in methods.items()}
    H = {m: hits(W_test, mk) for m, mk in masks.items()}
    rec = {m: h.mean(0) for m, h in H.items()}
    km_share = {m: np.array([km[mk].sum() / km.sum() for mk in masks[m]]) for m in methods}

    n = len(test_rows)
    bi = rng.integers(0, n, (NBOOT, n))
    boot = {m: h[bi].mean(1) for m, h in H.items()}        # (NBOOT, len(KS))
    weeks = pd.Series([i['t'].strftime('%G-%V') for i in test_rows])
    wk = sorted(weeks.unique())
    wsum = {m: np.array([H[m][(weeks == w).values].sum(0) for w in wk]) for m in methods}
    wn = np.array([(weeks == w).sum() for w in wk])
    bw = rng.integers(0, len(wk), (NBOOT, len(wk)))
    wboot = {m: wsum[m][bw].sum(1) / wn[bw].sum(1)[:, None] for m in methods}

    def ci(a):
        return [round(float(x), 3) for x in np.quantile(a, [0.025, 0.975])]

    for m in methods:
        print(f'test 2026  {m:8s} ' + '  '.join(f'@{int(k*100)}% {x:.3f} (km {s:.2f})'
                                                for k, x, s in zip(KS, rec[m], km_share[m])))

    # outputs per segment
    order = np.lexsort((tiebreak, -rate))
    rank = np.empty(len(idx), int)
    rank[order] = np.arange(1, len(idx) + 1)
    n_train = np.zeros(len(idx), int)
    n_test = np.zeros(len(idx), int)
    causes = [Counter() for _ in idx]
    for rows, W, cnt in ((train_rows, W_train, n_train), (test_rows, W_test, n_test)):
        for r, i in enumerate(rows):
            nz = np.flatnonzero(W[r])
            cnt[nz] += 1
            if cnt is n_train:
                for s in nz:
                    causes[s][i['cause']] += W[r, s]
    names = [f"{net.nodes[segs[s]['u']][1]} - {net.nodes[segs[s]['v']][1]}" for s in idx]
    ids, seen = [], Counter()
    for s in idx:
        base = f"{net.nodes[segs[s]['u']][0]}-{net.nodes[segs[s]['v']][0]}"
        seen[base] += 1
        ids.append(base if seen[base] == 1 else f'{base}-{seen[base]}')
    feats = []
    for j in order:
        s = idx[j]
        feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': seg_coords(net, segs[s])},
                      'properties': {
                          'id': ids[j], 'name': names[j], 'km': round(float(km[j]), 2),
                          'risk': round(float(rate[j] / rate.max()), 4), 'rank': int(rank[j]),
                          'perYear': round(float(rate[j]), 4), 'trainsPerDay': int(tr[j]),
                          'incidentsTrain': int(n_train[j]), 'incidentsTest': int(n_test[j]),
                          'topCauses': [c for c, _ in causes[j].most_common(3)],
                          'edges': [net.edges[ei][0] for ei, _ in segs[s]['seq']]}})
    model_type = 'poisson_regression' + ('' if a_used == math.inf else '_empirical_bayes')
    gj = {'type': 'FeatureCollection',
          'properties': {'model': 'section_risk', 'trainedOn': '2024-03..2025-12', 'testedOn': '2026-01..2026-10',
                         'type': model_type, 'segments': len(feats)},
          'features': feats}
    (HERE / 'segments.geojson').write_text(json.dumps(gj, ensure_ascii=False, separators=(',', ':')))

    # calibration: expected vs observed test incidents by model rank band
    T_test = years('test')
    obs = W_test.sum(0)
    calib = []
    for lo, hi, lab in [(0, .05, 'top 5%'), (.05, .10, '5-10%'), (.10, .20, '10-20%'), (.20, .50, '20-50%'),
                        (.50, 1, '50-100%')]:
        sel = (rank > lo * len(idx)) & (rank <= hi * len(idx))
        calib.append({'bin': f'segments ranked {lab}', 'predicted': round(float(rate[sel].sum() * T_test), 1),
                      'observed': round(float(obs[sel].sum()), 1), 'n': int(sel.sum())})

    label = {'km': 'track length', 'trains': 'trains per day', 'train_km': 'train-km', 'history': 'raw training counts'}
    metrics = []
    for j, k in enumerate(KS):
        metrics.append({
            'name': f'Share of 2026 incidents in the top {int(k*100)}% of segments', 'lowerIsBetter': False,
            'values': {m: round(float(rec[m][j]), 3) for m in methods},
            'ci95': {'model': ci(boot['model'][:, j]),
                     **{f'model_vs_{m}': ci(boot['model'][:, j] - boot[m][:, j]) for m in methods if m != 'model'},
                     **{f'model_vs_{m}_weekblock': ci(wboot['model'][:, j] - wboot[m][:, j])
                        for m in methods if m != 'model'}}})
    for j, k in enumerate(KS):
        metrics.append({'name': f'Share of network km in the top {int(k*100)}% of segments', 'lowerIsBetter': True,
                        'values': {m: round(float(km_share[m][j]), 3) for m in methods}})
    metrics.append({'name': 'Validation 2025 (fit 2024-03..12): mean share in the top 5/10/20% of segments',
                    'lowerIsBetter': False,
                    'values': {'model': round(best['mean'], 3), **{m: round(float(r.mean()), 3) for m, r in base_val.items()}}})

    j10 = KS.index(0.10)
    beats = {m: all(ci(boot['model'][:, j] - boot[m][:, j])[0] > 0 for j in range(len(KS))) for m in label}
    ties = {m: not beats[m] and all(ci(boot['model'][:, j] - boot[m][:, j])[1] >= 0 for j in range(len(KS)))
            for m in label}
    headline = (f"The 10% of segments ranked riskiest on 2024-03..2025-12 drew {rec['model'][j10]:.0%} of the {n} "
                f"disruptions of Jan-Oct 2026, against {rec['trains'][j10]:.0%} when ranking by trains per day and "
                f"{rec['km'][j10]:.0%} by track length")
    strong = [label[m] for m in label if beats[m]]
    level = [label[m] for m in label if ties[m]]
    worse = [label[m] for m in label if not beats[m] and not ties[m]]
    parts = []
    if strong:
        parts.append('it beats ' + ', '.join(strong) + ' at every cut-off')
    if level:
        parts.append('it is level with ' + ', '.join(level) + ' (interval includes zero)')
    if worse:
        parts.append('it does worse than ' + ', '.join(worse))
    headline += '; ' + '; '.join(parts) + '.'

    examples = []
    for j in order[:8]:
        examples.append({'id': ids[j], 'title': names[j],
                         'announced': f'{km[j]:.1f} km, {int(tr[j])} trains per day',
                         'predicted': f'{rate[j]:.2f} disruptions per year (rank {rank[j]})',
                         'actual': f'{n_train[j]} in 2024-03..2025-12, {n_test[j]} in 2026-01..10'})

    lost = float(1 - W_test.sum() / max(n, 1))
    notes = [
        f"Units: {len(idx)} ranked segments ({km.sum():.0f} km of the BAV graph's "
        f"{sum(e[4] for e in net.edges) / 1000:.0f} km): the track between two consecutive served stations (or a "
        "station and a junction) with trains in the twin's timetable, plus any segment a training incident touched.",
        f"Incidents: {len(incs)} VIA incidents with an active version ({withdrawn} withdrawn ones left out); "
        f"{len(mapped)} placed on the network ({kinds.get('section', 0)} sections, {kinds.get('cross_border', 0)} "
        f"cross-border sections by their Swiss part, {kinds.get('station', 0) + kinds.get('station_fallback', 0)} at "
        f"one station), {len(incs) - len(mapped)} not placed (stations abroad). Training {len(train_rows)} "
        f"(2024-03..2025-12), test {n} (2026-01-01..2026-10-12, the export date); {lost:.1%} of the test weight "
        "fell on segments outside the ranked set and counts as a miss for every ranking.",
        "Each incident counts once, spread evenly over the segments of its section (a one-station incident over the "
        "segments at that station); the top sets are by number of segments, the km rows show how much track each is.",
        f"Model: Poisson regression of the training counts on log km ({beta[1]:.2f}), log(1 + trains per day) "
        f"({beta[2]:.2f}), single-track share ({beta[3]:.2f})"
        + (f" and log past incidents within ~{h_best} km, leaving the segment itself out ({beta[4]:.2f})" if h_best else '')
        + (f", then empirical-Bayes shrinkage of each segment's own count (gamma shape {a_used:.2f})"
           if a_used != math.inf else '')
        + ". Bandwidth and shrinkage chosen on 2024-03..12 -> 2025; rates only from the training period.",
        "Intervals: paired bootstrap over test incidents (2000 resamples); '_weekblock' resamples whole ISO weeks "
        "(storms that hit several segments at once).",
        "Exposure is the twin's November 2026 timetable (a Monday; the busiest other day for lines without trains "
        "that Monday) applied to the whole period; a train passing without stopping counts too.",
        "The liveticker holds about 200 published, service-interrupting incidents a year, not every SBB disruption, and "
        f"{np.mean([i['lang'] == 'FR' for i in incs]):.0%} of them were first written in French (western Switzerland): "
        "the map ranks where such published incidents happen; exposure explains little of it, the place's own "
        "history explains most.",
    ]
    if worse or level:
        notes.append('Not better than: ' + ', '.join(worse + level) + '. Said plainly: the raw count of past '
                     'incidents per segment is as good a ranking as the model at these cut-offs.'
                     if 'raw training counts' in worse + level else 'Not better than: ' + ', '.join(worse + level))

    score = {
        'model': 'section_risk', 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'data': {'incidentsTrain': len(train_rows), 'incidentsTest': n, 'segments': len(idx),
                 'source': 'VIA liveticker export 2024-03..2026-10-12 (incident + incident_audit); BAV track graph '
                           'and GTFS timetable of sbb-twin'},
        'headline': headline, 'metrics': metrics, 'calibration': calib, 'examples': examples, 'notes': notes,
        'fit': {'type': model_type, 'bandwidthKm': h_best, 'gammaShape': round(float(a_used), 4) if a_used != math.inf else None,
                'coef': dict(zip(['intercept', 'log_km', 'log1p_trains_per_day', 'single_track_share', 'log_region'],
                                 [round(float(b), 4) for b in beta]))},
        'validationGrid': sorted(grid, key=lambda g: -g['mean']),
        'unplaced': sorted(Counter(unmatched).items(), key=lambda kv: -kv[1]),
    }
    (HERE / 'scorecard.json').write_text(json.dumps(score, indent=1, ensure_ascii=False) + '\n')
    print(headline)
    print(f"segments.geojson {(HERE / 'segments.geojson').stat().st_size / 1e6:.2f} MB")


if __name__ == '__main__':
    main()
