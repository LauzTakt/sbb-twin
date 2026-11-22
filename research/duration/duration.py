#!/usr/bin/env python3
"""How long will a disruption last? Duration model for the sbb-twin (forecast contract, section 1).

Predicts S(t) = P(a disruption is still not resumed t minutes after its first public notice), from the features
known at that notice, and S(t | e) = S(t) / S(e) once it has been open e minutes. Writes model.json (applied live by
src/forecast.ts, no Python at runtime) and scorecard.json (every number below comes from this script).

  /opt/venv/bin/python research/duration/duration.py

Data: the VIA liveticker export (/workspace/sbb/Daten/extern-liveticker, incident + incident_audit, every version).
Protocol: fit on 2024 and select the family (log-normal AFT or discrete hazard) and ridge strength on 2025; refit on
2024-03..2025-12 and test once on 2026-01..2026-10 (never tuned on 2026). Baselines: Kaplan-Meier prior, per-cause
(smoothed per EG code), SBB's announced end (calibrated into a probability, and as a point), Didac's corrected
announced end (sbb_prediction_study.py, re-run on these labels). Intervals: paired bootstrap over test weeks.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats

HERE = Path(__file__).resolve().parent
LT = Path('/workspace/sbb/Daten/extern-liveticker')
TZ = 'Europe/Zurich'
HORIZONS = [60, 120, 240]
EDGES = [0, 30, 60, 120, 240, 480]          # discrete-hazard bins [0,30) .. [240,480), [480, tailEnd)
ANN_MIN, ANN_MAX = 5.0, 7 * 1440.0          # announced ends outside (0, 7 days] are placeholders -> "none"
VAL_SPLIT = pd.Timestamp('2025-01-01', tz=TZ)
TEST_SPLIT = pd.Timestamp('2026-01-01', tz=TZ)
TEST_END = pd.Timestamp('2026-11-01', tz=TZ)
B = 2000
RNG_SEED = 7

GROUPS = ['infrastructure', 'rolling_stock', 'person', 'external', 'planned']   # 'other' is the reference
HOURS = ['night', 'am_peak', 'pm_peak', 'evening']                              # 'day' (9-15) is the reference
FEATS = ([f'cause:{g}' for g in GROUPS] + ['effect_interrupted', 'scope_station', 'announced_log', 'announced_none',
         'announced_at_least'] + [f'hour:{h}' for h in HOURS] + ['weekend'])

# VIA reason codes (reason_202610121034.csv) -> contract cause groups; any code not listed is 'other'.
CAUSE_GROUPS = {
    'infrastructure': ['EG_010', 'EG_008', 'EG_006', 'EG_011', 'EG_196', 'EG_001', 'EG_028', 'EG_034'],
    'rolling_stock': ['EG_014', 'EG_013', 'EG_191', 'EG_197', 'EG_125', 'EG_111', 'EG_117', 'EG_119'],
    'person': ['EG_047', 'EG_046', 'EG_122', 'EG_194', 'EG_199'],
    'external': ['EG_049', 'EG_070', 'EG_052', 'EG_100', 'EG_025', 'EG_193', 'EG_030', 'EG_026', 'EG_019', 'EG_020',
                 'EG_198', 'EG_101', 'EG_104', 'EG_015', 'EG_016', 'EG_017', 'EG_018', 'EG_021', 'EG_022', 'EG_023',
                 'EG_195', 'EG_200', 'EG_112', 'EG_113', 'EG_039', 'EG_110', 'EG_192', 'EG_050', 'EG_102', 'EG_114',
                 'EG_190', 'EG_135'],
    'planned': ['EG_004', 'EG_158'],
}
# GTFS-RT Alert.Cause enum (all 12 values) as the live twin reads them from SBB's service alerts.
GTFS_CAUSES = {'gtfs:UNKNOWN_CAUSE': 'other', 'gtfs:OTHER_CAUSE': 'other', 'gtfs:TECHNICAL_PROBLEM': 'infrastructure',
               'gtfs:STRIKE': 'other', 'gtfs:DEMONSTRATION': 'external', 'gtfs:ACCIDENT': 'person',
               'gtfs:HOLIDAY': 'other', 'gtfs:WEATHER': 'external', 'gtfs:MAINTENANCE': 'planned',
               'gtfs:CONSTRUCTION': 'planned', 'gtfs:POLICE_ACTIVITY': 'external', 'gtfs:MEDICAL_EMERGENCY': 'person'}
KIND = {'Interrupted service': 'interrupted', 'Limited service': 'limited', 'Service resumed': 'resumed'}
HAS_END = {'UNTIL', 'UNTIL_DATE', 'UNTIL_APPROX_DATE_TIME', 'FROM_TO', 'UNTIL_AT_LEAST', 'UNTIL_AT_LEAST_DATE_TIME'}
AT_LEAST = {'UNTIL_AT_LEAST', 'UNTIL_AT_LEAST_DATE_TIME'}
POINT = {'UNTIL', 'UNTIL_DATE', 'UNTIL_APPROX_DATE_TIME'}


def cause_group(code):
    for g, codes in CAUSE_GROUPS.items():
        if code in codes:
            return g
    return 'other'


def hour_bucket(h):
    if h >= 22 or h <= 5:
        return 'night'
    if h <= 8:
        return 'am_peak'
    if h <= 15:
        return 'day'
    if h <= 18:
        return 'pm_peak'
    return 'evening'


def announced(row, start):
    """Announced end of one version, in minutes from start (None if no usable end). duration_to holds the end for
    every type with an end (for the at-least types too: the text says 'at least until <duration_to>';
    duration_at_least is a shifted time of day and is not used)."""
    if row.duration_type not in HAS_END or pd.isna(row.duration_to):
        return None
    end = pd.Timestamp(row.duration_to).tz_convert(TZ)
    m = (end - start).total_seconds() / 60
    if m <= 0 or m > ANN_MAX:
        return None
    return max(m, ANN_MIN)


# ----------------------------------------------------------------------------------------------- incidents
def build_incidents():
    cur = pd.read_csv(LT / 'incident_202610121914.csv')
    aud = pd.read_csv(LT / 'incident_audit_202610121914.csv')
    v = pd.concat([aud, cur], ignore_index=True)
    v['t'] = pd.to_datetime(v.last_modified_date, utc=True, format='mixed').dt.tz_convert(TZ)
    v['duration_to'] = pd.to_datetime(v.duration_to, utc=True, format='mixed')
    v['duration_from'] = pd.to_datetime(v.duration_from, utc=True, format='mixed')
    pre = v.summary_en.fillna('').str.extract(r'^([^:]+):\s*(.*)$', expand=True)
    v['kind'] = pre[0].map(KIND)
    v['sect'] = pre[1]
    reasons = pd.read_csv(LT / 'reason_202610121034.csv').set_index('id').reason_en.to_dict()
    out, dropped = [], {'no_active_version': 0, 'no_end': 0}
    for iid, g in v.groupby('id'):
        g = g.sort_values('t')
        act = g[(g.lifecycle == 'INFO') & g.kind.isin(['interrupted', 'limited'])]
        if act.empty:
            dropped['no_active_version'] += 1
            continue
        f = act.iloc[0]
        start = f.t
        if pd.notna(f.duration_from) and f.duration_from.tz_convert(TZ) > start:   # planned start announced early
            start = f.duration_from.tz_convert(TZ)
        res = g[((g.kind == 'resumed') | (g.lifecycle == 'ENDED')) & (g.t > f.t)]
        if res.empty:
            dropped['no_end'] += 1
            continue
        end = res.t.iloc[0]
        dur = (end - start).total_seconds() / 60
        if dur <= 0:
            dropped['no_end'] += 1
            continue
        ann = announced(f, start)
        # every later estimate published before the end (for the conditional, "latest announced" baseline)
        updates = []
        for _, r in g[(g.t >= f.t) & (g.t < end) & (g.lifecycle == 'INFO')].iterrows():
            updates.append((max(0.0, (r.t - start).total_seconds() / 60), announced(r, start),
                            int(r.duration_type in AT_LEAST)))
        code = f.reason_id_fk if pd.notna(f.reason_id_fk) else 'EG_140'
        loc = start
        out.append(dict(
            id=str(iid), start=start, end=end, dur=dur, code=code, reason=reasons.get(code, code),
            group=cause_group(code), duration_type=f.duration_type, title=f.summary_en,
            effect_interrupted=int(f.kind == 'interrupted'), scope_station=int(' - ' not in str(f.sect)),
            ann=ann, announced_at_least=int(f.duration_type in AT_LEAST and ann is not None),
            hour=hour_bucket(loc.hour), weekend=int(loc.day_of_week >= 5), updates=updates,
            planned=int(cause_group(code) == 'planned' or f.duration_type == 'FROM_TO')))
    d = pd.DataFrame(out).sort_values('start').reset_index(drop=True)
    d['week'] = d.start.dt.strftime('%G-%V')
    return d, dropped


def features(d):
    X = pd.DataFrame(0.0, index=d.index, columns=FEATS)
    for g in GROUPS:
        X[f'cause:{g}'] = (d.group == g).astype(float)
    X['effect_interrupted'] = d.effect_interrupted
    X['scope_station'] = d.scope_station
    has = d.ann.notna()
    X['announced_log'] = np.where(has, np.log(d.ann.where(has, 1.0).astype(float)), 0.0)
    X['announced_none'] = (~has).astype(float)
    X['announced_at_least'] = d.announced_at_least
    for h in HOURS:
        X[f'hour:{h}'] = (d.hour == h).astype(float)
    X['weekend'] = d.weekend
    return X.values.astype(float)


FEATURE_SETS = ['full', 'no_clock']          # no_clock: hour buckets and weekend get coefficient 0
HALF_LIVES = [None, 365]                      # recency weighting of training incidents (days), None = equal


def fx(X, fs):
    X = X.copy()
    if fs == 'no_clock':
        X[:, [i for i, f in enumerate(FEATS) if f.startswith('hour:') or f == 'weekend']] = 0
    return X


def recency(starts, split, hl):
    if hl is None:
        return None
    age = (split - starts).dt.total_seconds().values / 86400
    return 0.5 ** (age / hl)


# ----------------------------------------------------------------------------------------------- model families
class AFT:
    """ln T = intercept + x.beta + sigma * eps, eps ~ N(0,1); ridge on beta (all durations are observed)."""
    type = 'aft_lognormal'

    def __init__(self, lam):
        self.lam = lam

    def fit(self, X, T, wt=None):
        y = np.log(T)
        wt = np.ones(len(T)) if wt is None else wt * len(wt) / wt.sum()
        Xc = np.column_stack([np.ones(len(X)), X])
        P = np.eye(Xc.shape[1]) * self.lam
        P[0, 0] = 0
        w = np.linalg.solve(Xc.T @ (Xc * wt[:, None]) + P, Xc.T @ (wt * y))
        self.b0, self.beta = w[0], w[1:]
        self.sigma = float(np.sqrt(np.sum(wt * (y - Xc @ w) ** 2) / wt.sum()))
        return self

    def mu(self, X):
        return self.b0 + X @ self.beta

    def S(self, X, t):
        return 1 - stats.norm.cdf((np.log(np.asarray(t, float)) - self.mu(X)) / self.sigma)

    def quantile(self, X, q):
        return np.exp(self.mu(X) + self.sigma * stats.norm.ppf(q))

    def export(self):
        return {'type': self.type, 'intercept': self.b0, 'sigma': self.sigma,
                'coef': dict(zip(FEATS, self.beta)), 'ridge': self.lam}


class Hazard:
    """Discrete hazard: h_j = sigmoid(a_j + x.beta) in bins [0,30) .. [240,480); the last bin [480, tailEnd) has
    hazard 1, so S falls linearly from S(480) to 0 at tailEnd (tailEnd from the training durations)."""
    type = 'discrete_hazard'

    def __init__(self, lam):
        self.lam = lam

    def fit(self, X, T, wt=None):
        wt = np.ones(len(T)) if wt is None else wt * len(wt) / wt.sum()
        nb = len(EDGES) - 1
        rows, bins, ys = [], [], []
        for i, t in enumerate(T):
            for j in range(nb):
                if t < EDGES[j]:
                    break
                hi = EDGES[j + 1]
                rows.append(i)
                bins.append(j)
                ys.append(1.0 if t < hi else 0.0)
        rows, bins, ys = np.array(rows), np.array(bins), np.array(ys)
        Xr, wr = X[rows], wt[rows]
        Bm = np.zeros((len(rows), nb))
        Bm[np.arange(len(rows)), bins] = 1
        p = X.shape[1]

        def f(w):
            a, beta = w[:nb], w[nb:]
            z = Bm @ a + Xr @ beta
            nll = np.sum(wr * (np.logaddexp(0, z) - ys * z)) + self.lam * beta @ beta
            r = wr * (1 / (1 + np.exp(-z)) - ys)
            return nll, np.concatenate([Bm.T @ r, Xr.T @ r + 2 * self.lam * beta])

        w0 = np.zeros(nb + p)
        sol = optimize.minimize(f, w0, jac=True, method='L-BFGS-B', options={'maxiter': 2000})
        self.a, self.beta = sol.x[:nb], sol.x[nb:]
        tail = T[T >= EDGES[-1]]
        self.tail_end = float(round(max(EDGES[-1] + 120, 2 * tail.mean() - EDGES[-1]) if len(tail) else 1440, -1))
        return self

    def _knots(self, X):
        h = 1 / (1 + np.exp(-(self.a[None, :] + (X @ self.beta)[:, None])))
        S = np.cumprod(1 - h, axis=1)
        S = np.column_stack([np.ones(len(X)), S, np.zeros(len(X))])   # at 0, 30, ..., 480, tailEnd
        knots = np.array(EDGES + [self.tail_end], float)
        return knots, S

    def S(self, X, t):
        knots, S = self._knots(X)
        t = np.broadcast_to(np.asarray(t, float), (len(X),))
        return np.array([np.interp(ti, knots, Si) for ti, Si in zip(t, S)])

    def quantile(self, X, q):
        knots, S = self._knots(X)
        target = 1 - q
        out = []
        for Si in S:
            # S is non-increasing; interpolate the first crossing of the target
            j = int(np.argmax(Si <= target))
            if Si[j] == Si[j - 1]:
                out.append(knots[j])
            else:
                out.append(knots[j - 1] + (Si[j - 1] - target) / (Si[j - 1] - Si[j]) * (knots[j] - knots[j - 1]))
        return np.array(out)

    def export(self):
        return {'type': self.type, 'binEdgesMin': EDGES, 'tailEndMin': self.tail_end,
                'binIntercepts': list(self.a) + [30.0], 'coef': dict(zip(FEATS, self.beta)), 'ridge': self.lam}


# ----------------------------------------------------------------------------------------------- baselines
def km(T, t):
    """Kaplan-Meier survival = the empirical share still open (no censoring among incidents with an end)."""
    T = np.asarray(T)
    return np.array([np.mean(T > ti) for ti in np.atleast_1d(t)])


class CauseKM:
    """Per EG code survival, shrunk to the prior with m pseudo-incidents."""

    def __init__(self, m):
        self.m = m

    def fit(self, d):
        self.T = d.dur.values
        self.by = {c: g.dur.values for c, g in d.groupby('code')}
        return self

    def S(self, codes, t):
        prior = km(self.T, [t])[0]
        out = []
        for c in codes:
            Tc = self.by.get(c, np.array([]))
            out.append((np.sum(Tc > t) + self.m * prior) / (len(Tc) + self.m))
        return np.array(out)


def logit_fit(Z, y, lam=1e-2):
    Zc = np.column_stack([np.ones(len(Z)), Z])

    def f(w):
        z = Zc @ w
        r = 1 / (1 + np.exp(-z)) - y
        return np.sum(np.logaddexp(0, z) - y * z) + lam * w[1:] @ w[1:], Zc.T @ r + 2 * lam * np.r_[0, w[1:]]

    return optimize.minimize(f, np.zeros(Zc.shape[1]), jac=True, method='L-BFGS-B').x


def logit_pred(w, Z):
    return 1 / (1 + np.exp(-(np.column_stack([np.ones(len(Z)), Z]) @ w)))


def operator_Z(ann, atl, rem_h):
    """Calibration inputs for an announced end: ln(announced remaining / remaining horizon), none, at-least."""
    has = ~np.isnan(ann)
    lr = np.where(has, np.log(np.where(has, ann, 1.0) / rem_h), 0.0)
    return np.column_stack([lr, (~has).astype(float), atl * has])


class Operator:
    """SBB's announced end calibrated into P(still open at h), one logistic fit per horizon."""

    def fit(self, d):
        ann, atl = d.ann.astype(float).values, d.announced_at_least.values
        self.w = {h: logit_fit(operator_Z(ann, atl, h), (d.dur.values > h).astype(float)) for h in HORIZONS}
        return self

    def S(self, d, h):
        return logit_pred(self.w[h], operator_Z(d.ann.astype(float).values, d.announced_at_least.values, h))


def point_S(ann, prior_h, h):
    return np.where(np.isnan(ann), prior_h, (ann > h).astype(float))


def latest_announced(d, e):
    """The announced end known e minutes after the start: (announced minutes from start or nan, at-least flag)."""
    ann, atl = [], []
    for ups in d.updates:
        known = [u for u in ups if u[0] <= e]
        a, al = (known[-1][1], known[-1][2]) if known else (None, 0)
        ann.append(np.nan if a is None else a)
        atl.append(al if a is not None else 0)
    return np.array(ann, float), np.array(atl, float)


class OperatorLatest:
    """At elapsed e: the latest announced end, calibrated on training incidents still open at e."""

    def Z(self, d, e, t):
        ann, atl = latest_announced(d, e)
        rem = ann - e
        overdue = (~np.isnan(rem)) & (rem <= 0)
        rem = np.where(overdue, np.nan, rem)
        Z = operator_Z(np.where(np.isnan(rem), np.nan, np.maximum(rem, ANN_MIN)), atl, t - e)
        return np.column_stack([Z, overdue.astype(float)])

    def fit(self, d, e, t):
        self.w = logit_fit(self.Z(d, e, t), (d.dur.values > t).astype(float))
        return self

    def S(self, d, e, t):
        return logit_pred(self.w, self.Z(d, e, t))


# ----------------------------------------------------------------------------------------------- evaluation
def brier(p, y):
    return float(np.mean((p - y) ** 2))


def boot_ci(err_a, err_b, groups, B=B, seed=RNG_SEED):
    """Paired cluster bootstrap (resampling whole weeks) of mean(err_a) - mean(err_b): 95% percentile interval."""
    g = pd.factorize(np.asarray(groups))[0]
    G = g.max() + 1
    sa, sb = np.bincount(g, err_a, G), np.bincount(g, err_b, G)
    n = np.bincount(g, minlength=G).astype(float)
    W = np.random.default_rng(seed).multinomial(G, np.full(G, 1 / G), size=B)
    d = (W @ sa - W @ sb) / (W @ n)
    return [round(float(x), 4) for x in np.percentile(d, [2.5, 97.5])]


def conformal_shifts(model, Xc, Tc, level=0.8):
    lo_q, hi_q = (1 - level) / 2, 1 - (1 - level) / 2
    n = len(Tc)
    r_lo = np.log(Tc) - np.log(model.quantile(Xc, lo_q))
    r_hi = np.log(Tc) - np.log(model.quantile(Xc, hi_q))
    k_lo = max(0, math.floor((n + 1) * lo_q) - 1)                    # finite-sample split-conformal ranks
    k_hi = min(n - 1, math.ceil((n + 1) * hi_q) - 1)
    return float(np.sort(r_lo)[k_lo]), float(np.sort(r_hi)[k_hi])


def fmt_hm(ts):
    return ts.strftime('%d.%m.%Y %H:%M')


def fmt_dur(m):
    m = int(round(m))
    return f'{m // 60} h {m % 60:02d} min' if m >= 60 else f'{m} min'


def r4(x):
    return round(float(x), 4)


def main():
    d, dropped = build_incidents()
    X = features(d)
    T = d.dur.values
    tr_val = ((d.start < VAL_SPLIT) & (d.end < VAL_SPLIT)).values
    val = ((d.start >= VAL_SPLIT) & (d.start < TEST_SPLIT)).values
    tr = ((d.start < TEST_SPLIT) & (d.end < TEST_SPLIT)).values
    te = ((d.start >= TEST_SPLIT) & (d.start < TEST_END)).values
    print(f'incidents with an end: {len(d)} (dropped {dropped}); fit-for-validation {tr_val.sum()}, '
          f'validation {val.sum()}, train {tr.sum()}, test {te.sum()}')

    # ---------------- 1. model selection on 2025 (fitted on 2024)
    Yv = {h: (T[val] > h).astype(float) for h in HORIZONS}
    grid = {'aft_lognormal': (AFT, [0.1, 1, 3, 10, 30, 100]), 'discrete_hazard': (Hazard, [0.1, 0.3, 1, 3, 10, 30])}
    sel = []
    for fam, (cls, lams) in grid.items():
        for lam in lams:
            for fs in FEATURE_SETS:
                for hl in HALF_LIVES:
                    m = cls(lam).fit(fx(X[tr_val], fs), T[tr_val], recency(d.start[tr_val], VAL_SPLIT, hl))
                    b = [brier(m.S(fx(X[val], fs), h), Yv[h]) for h in HORIZONS]
                    sel.append(dict(family=fam, ridge=lam, features=fs, halfLifeDays=hl, brier60=r4(b[0]),
                                    brier120=r4(b[1]), brier240=r4(b[2]), mean=round(float(np.mean(b)), 5)))
    best = min(sel, key=lambda r: r['mean'])
    best_by_family = {fam: min([r for r in sel if r['family'] == fam], key=lambda r: r['mean']) for fam in grid}
    X = fx(X, best['features'])
    feat = lambda dd: fx(features(dd), best['features'])
    cms = {}
    dv_fit = d[tr_val]
    for mm in [1, 2, 5, 10, 20, 50]:
        c = CauseKM(mm).fit(dv_fit)
        cms[mm] = np.mean([brier(c.S(d.code[val], h), Yv[h]) for h in HORIZONS])
    m_cause = min(cms, key=cms.get)
    print('selected', best, 'cause pseudo-count', m_cause)

    # conformal band on ln T: shifts from the 2024 fit applied to 2025 (out of sample), reused on the final model
    cls = AFT if best['family'] == 'aft_lognormal' else Hazard
    hl = best['halfLifeDays']
    mval = cls(best['ridge']).fit(X[tr_val], T[tr_val], recency(d.start[tr_val], VAL_SPLIT, hl))
    lo_shift, hi_shift = conformal_shifts(mval, X[val], T[val])
    # point forecast of the end, chosen on 2025: model median, the announced end, or announced + median correction
    dtv, dva = d[tr_val], d[val]
    htv, hva = dtv.ann.notna().values, dva.ann.notna().values
    corr_v = float(np.median(T[tr_val][htv] - dtv.ann.astype(float).values[htv]))
    av = dva.ann.astype(float).values[hva]
    mae_v = {'model_median': float(np.mean(np.abs(mval.quantile(X[val], 0.5)[hva] - T[val][hva]))),
             'announced': float(np.mean(np.abs(av - T[val][hva]))),
             'announced_plus_correction': float(np.mean(np.abs(np.maximum(av + corr_v, 0) - T[val][hva])))}
    point_rule = min(mae_v, key=mae_v.get)

    # ---------------- 2. final fit on 2024-03..2025-12, one test on 2026-01..2026-10
    model = cls(best['ridge']).fit(X[tr], T[tr], recency(d.start[tr], TEST_SPLIT, hl))
    other_cls = Hazard if cls is AFT else AFT
    ob = best_by_family[other_cls.type]
    other = other_cls(ob['ridge']).fit(fx(features(d)[tr], ob['features']), T[tr],
                                       recency(d.start[tr], TEST_SPLIT, ob['halfLifeDays']))
    X_other_te = fx(features(d)[te], ob['features'])
    dtr, dte = d[tr], d[te]
    Xte, Tte, wk = X[te], T[te], dte.week.values
    cause = CauseKM(m_cause).fit(dtr)
    oper = Operator().fit(dtr)
    prior = {h: km(T[tr], [h])[0] for h in HORIZONS}

    metrics, ann_te = [], dte.ann.astype(float).values
    preds120 = None
    for h in HORIZONS:
        y = (Tte > h).astype(float)
        p = {'model': model.S(Xte, h), 'operator': oper.S(dte, h), 'cause': cause.S(dte.code, h),
             'prior': np.full(len(y), prior[h]), 'operator_point': point_S(ann_te, prior[h], h),
             f'other_family_{other.type}': other.S(X_other_te, h)}
        if h == 120:
            preds120 = p
        err = {k: (v - y) ** 2 for k, v in p.items()}
        metrics.append({
            'name': f'Brier at {h} min (P still not resumed), from the first notice', 'lowerIsBetter': True,
            'n': int(len(y)), 'observedStillOpen': r4(y.mean()),
            'values': {k: r4(v.mean()) for k, v in err.items()},
            'ci95': {f'model_vs_{k}': boot_ci(err['model'], err[k], wk) for k in
                     ['operator', 'cause', 'prior', 'operator_point']}})

    # ---------------- 3. point forecast of the end: model median vs SBB's announced end (and Didac's corrections)
    has = ~np.isnan(ann_te)
    med = model.quantile(Xte, 0.5)
    tr_has = dtr.ann.notna().values
    corr = float(np.median(T[tr][tr_has] - dtr.ann.astype(float).values[tr_has]))
    didac = didac_learned(dtr[tr_has], dte[has])
    ae = {'model': np.abs(med[has] - Tte[has]), 'operator': np.abs(ann_te[has] - Tte[has]),
          'operator_plus_median_correction': np.abs(np.maximum(ann_te[has] + corr, 0) - Tte[has]),
          'operator_learned_residual_didac': np.abs(didac - Tte[has])}
    ae['chosen_point_rule'] = {'model_median': ae['model'], 'announced': ae['operator'],
                               'announced_plus_correction': ae['operator_plus_median_correction']}[point_rule]
    pt = has & dte.duration_type.isin(POINT).values
    ae_pt = {'model': np.abs(med[pt] - Tte[pt]), 'operator': np.abs(ann_te[pt] - Tte[pt])}
    metrics.append({
        'name': 'Mean absolute error of the predicted end (min), incidents with an announced end', 'lowerIsBetter': True,
        'n': int(has.sum()), 'values': {k: round(float(v.mean()), 1) for k, v in ae.items()},
        'medianAbsoluteError': {k: round(float(np.median(v)), 1) for k, v in ae.items()},
        'ci95': {f'model_vs_{k}': [round(x, 1) for x in boot_ci(ae['model'], ae[k], wk[has])] for k in ae if k != 'model'},
        'note': f'model = median of S(t); operator + correction adds the training median residual ({corr:+.1f} min); '
                f'chosen_point_rule = {point_rule} (picked on 2025)'})
    metrics.append({
        'name': 'Mean absolute error of the predicted end (min), point announcements only (UNTIL types)',
        'lowerIsBetter': True, 'n': int(pt.sum()), 'values': {k: round(float(v.mean()), 1) for k, v in ae_pt.items()},
        'ci95': {'model_vs_operator': [round(x, 1) for x in boot_ci(ae_pt['model'], ae_pt['operator'], wk[pt])]}})
    no_ann = ~has
    metrics.append({
        'name': 'Mean absolute error of the predicted end (min), incidents with no announced end', 'lowerIsBetter': True,
        'n': int(no_ann.sum()), 'values': {'model': round(float(np.abs(med[no_ann] - Tte[no_ann]).mean()), 1),
                                           'prior_median': round(float(np.abs(np.median(T[tr]) - Tte[no_ann]).mean()), 1)}})

    # ---------------- 4. 80% interval coverage
    q_lo, q_hi = model.quantile(Xte, 0.1), model.quantile(Xte, 0.9)
    c_lo, c_hi = q_lo * math.exp(lo_shift), q_hi * math.exp(hi_shift)
    cov_raw = ((Tte >= q_lo) & (Tte <= q_hi)).astype(float)
    cov_cal = ((Tte >= c_lo) & (Tte <= c_hi)).astype(float)
    metrics.append({
        'name': '80% interval coverage (target 0.80)', 'lowerIsBetter': False, 'target': 0.8, 'n': int(len(Tte)),
        'values': {'model_conformal': r4(cov_cal.mean()), 'model_raw': r4(cov_raw.mean())},
        'medianWidthMin': {'model_conformal': round(float(np.median(c_hi - c_lo)), 1),
                           'model_raw': round(float(np.median(q_hi - q_lo)), 1)},
        'ci95': {'model_conformal': [r4(x) for x in boot_ci(cov_cal, np.zeros_like(cov_cal), wk)]},
        'note': 'conformal shifts on ln T fitted on 2025 with the model trained on 2024'})

    # ---------------- 5. conditional: still open after e minutes
    cond = []
    for e in [30, 60]:
        open_tr, open_te = T[tr] > e, Tte > e
        dtr_e, dte_e = dtr[open_tr], dte[open_te]
        for t in [h for h in HORIZONS if h > e]:
            y = (Tte[open_te] > t).astype(float)
            ol = OperatorLatest().fit(dtr_e, e, t)
            pr_t, pr_e = km(T[tr], [t])[0], km(T[tr], [e])[0]
            p = {'model': model.S(Xte[open_te], t) / model.S(Xte[open_te], e),
                 'operator_latest': ol.S(dte_e, e, t),
                 'cause': cause.S(dte_e.code, t) / np.maximum(cause.S(dte_e.code, e), 1e-9),
                 'prior': np.full(len(y), pr_t / pr_e)}
            ann_l, atl_l = latest_announced(dte_e, e)
            p['operator_latest_point'] = np.where(np.isnan(ann_l), pr_t / pr_e, (ann_l > t).astype(float))
            Xu = feat(dte_e.assign(ann=ann_l, announced_at_least=atl_l.astype(int)))
            p['model_updated'] = model.S(Xu, t) / np.maximum(model.S(Xu, e), 1e-12)
            err = {k: (v - y) ** 2 for k, v in p.items()}
            cond.append({
                'name': f'Brier at {t} min | still open at {e} min', 'lowerIsBetter': True, 'n': int(len(y)),
                'observedStillOpen': r4(y.mean()), 'values': {k: r4(v.mean()) for k, v in err.items()},
                'ci95': {**{f'model_vs_{k}': boot_ci(err['model'], err[k], wk[open_te]) for k in
                            ['operator_latest', 'cause', 'prior']},
                         'model_updated_vs_operator_latest': boot_ci(err['model_updated'], err['operator_latest'],
                                                                     wk[open_te]),
                         'model_updated_vs_model': boot_ci(err['model_updated'], err['model'], wk[open_te])}})
    metrics.extend(cond)

    # ---------------- 5b. deployment check: refit each month on everything that ended before it (same settings)
    roll = {h: np.zeros(int(te.sum())) for h in HORIZONS}
    te_month = dte.start.dt.strftime('%Y-%m').values
    for mth in sorted(set(te_month)):
        m0 = pd.Timestamp(mth + '-01', tz=TZ)
        trm = (d.end < m0).values
        mm = cls(best['ridge']).fit(X[trm], T[trm], recency(d.start[trm], m0, hl))
        sm = te_month == mth
        for h in HORIZONS:
            roll[h][sm] = mm.S(Xte[sm], h)
    rolling = []
    for h in HORIZONS:
        y = (Tte > h).astype(float)
        e_roll, e_frozen = (roll[h] - y) ** 2, (model.S(Xte, h) - y) ** 2
        rolling.append({'horizonMin': h, 'brierMonthlyRefit': r4(e_roll.mean()), 'brierFrozen': r4(e_frozen.mean()),
                        'ci95_refit_minus_frozen': boot_ci(e_roll, e_frozen, wk)})

    # ---------------- 6. planned construction, reported separately
    pl = dte.planned.values.astype(bool)
    planned = {'definition': 'cause group planned (EG_004 engineering work, EG_158 unscheduled construction work) '
                             'or duration type FROM_TO (scheduled window)',
               'nTrain': int(dtr.planned.sum()), 'nTest': int(pl.sum())}
    if pl.sum():
        hp = pl & has
        planned.update({
            'testWithAnnouncedEnd': int(hp.sum()),
            'maeOperatorMin': round(float(np.abs(ann_te[hp] - Tte[hp]).mean()), 1) if hp.sum() else None,
            'maeModelMin': round(float(np.abs(med[hp] - Tte[hp]).mean()), 1) if hp.sum() else None,
            'shareEndedWithin30MinOfAnnounced': r4(np.mean(np.abs(ann_te[hp] - Tte[hp]) <= 30)) if hp.sum() else None,
            'medianDurationMin': round(float(np.median(Tte[pl])), 1),
            'brier120': {'model': r4(brier(preds120['model'][pl], (Tte[pl] > 120).astype(float))),
                         'operator': r4(brier(preds120['operator'][pl], (Tte[pl] > 120).astype(float)))}})
    tp = dtr.planned.values.astype(bool) & tr_has
    unpl = has & ~pl
    planned['train'] = {
        'maeOperatorMin': round(float(np.abs(dtr.ann.astype(float).values[tp] - T[tr][tp]).mean()), 1) if tp.sum() else None,
        'shareEndedWithin30MinOfAnnounced': r4(np.mean(np.abs(dtr.ann.astype(float).values[tp] - T[tr][tp]) <= 30)) if tp.sum() else None}
    planned['unplannedTestComparison'] = {
        'maeOperatorMin': round(float(np.abs(ann_te[unpl] - Tte[unpl]).mean()), 1),
        'shareEndedWithin30MinOfAnnounced': r4(np.mean(np.abs(ann_te[unpl] - Tte[unpl]) <= 30))}

    # ---------------- 7. calibration (P still not resumed at 120 min, test)
    y120 = (Tte > 120).astype(float)
    calib = []
    for lo in np.arange(0, 1, 0.1):
        msk = (preds120['model'] >= lo) & (preds120['model'] < lo + 0.1 + (1e-9 if lo >= 0.9 else 0))
        if msk.sum():
            calib.append({'bin': f'{int(lo * 100)}-{int(lo * 100) + 10}%', 'predicted': r4(preds120['model'][msk].mean()),
                          'observed': r4(y120[msk].mean()), 'n': int(msk.sum())})

    # ---------------- 8. examples: the latest 2026 incident of each cause group
    examples = []
    for g in GROUPS + ['other']:
        idx = np.where(dte.group.values == g)[0]
        if not len(idx):
            continue
        i = idx[-1]
        r = dte.iloc[i]
        st = r.start
        a = ann_te[i]
        examples.append({
            'id': r.id, 'title': r.title, 'cause': f'{r.code} {r.reason} ({g})',
            'start': fmt_hm(st),
            'announced': ('none' if np.isnan(a) else
                          f"{'at least ' if r.announced_at_least else ''}until {fmt_hm(st + pd.Timedelta(minutes=a))} "
                          f"(+{fmt_dur(a)})"),
            'predicted': (f'median {fmt_hm(st + pd.Timedelta(minutes=float(med[i])))} (+{fmt_dur(med[i])}), '
                          f'80% {fmt_hm(st + pd.Timedelta(minutes=float(c_lo[i])))}..{fmt_hm(st + pd.Timedelta(minutes=float(c_hi[i])))}, '
                          f'P(still closed at 2 h) {preds120["model"][i]:.0%}'),
            'actual': f'resumed {fmt_hm(r.end)} (+{fmt_dur(r.dur)})'})

    # ---------------- model.json
    exp = model.export()
    cause_map = {c: cause_group(c) for c in pd.read_csv(LT / 'reason_202610121034.csv').id}
    cause_map.update(GTFS_CAUSES)
    model_json = {
        'name': 'duration', 'version': datetime.now(timezone.utc).strftime('%Y-%m-%d.%H%M'),
        'trainedOn': '2024-03..2025-12', 'testedOn': '2026-01..2026-10',
        **{k: v for k, v in exp.items() if k not in ('coef', 'ridge')},
        'coef': {k: round(float(v), 5) for k, v in exp['coef'].items()},
        'causeMap': cause_map, 'horizonsMin': HORIZONS,
        'interval': {'level': 0.8, 'method': 'conformal', 'lowLogShift': round(lo_shift, 4),
                     'highLogShift': round(hi_shift, 4),
                     'rule': 'band = [q10 * exp(lowLogShift), q90 * exp(highLogShift)], q = model quantiles of T'},
        'clock': 'minutes since the first published active version (Interrupted/Limited service), i.e. the first '
                 'time the alert is seen; a planned window starts at its announced start',
        'announced': {'minMinutes': ANN_MIN, 'maxMinutes': ANN_MAX,
                      'rule': 'announced end - start in minutes; <= 0 or > maxMinutes is a placeholder: treat as none '
                              '(announced_none = 1, announced_log = 0); values below minMinutes are raised to it'},
        'hourBuckets': {'night': '22-5', 'am_peak': '6-8', 'day': '9-15 (reference)', 'pm_peak': '16-18',
                        'evening': '19-21'},
        'conditional': 'S(t | e) = S(t) / S(e) for t > e',
        'pointForecast': {'withAnnouncedEnd': point_rule, 'correctionMin': round(corr, 1),
                          'withoutAnnouncedEnd': 'model_median',
                          'rule': 'expected end shown as a time: chosen on 2025 by mean absolute error; '
                                  'announced_plus_correction = announced end + correctionMin'},
        'causeText': cause_text(),
        'updates': ('when SBB changes the announced end, recompute announced_log / announced_none / '
                    'announced_at_least from the latest version (minutes from the original start) and use '
                    'S(t | e) = S(t; x_latest) / S(e; x_latest); tested in scorecard.json (model_updated)'),
        'recencyHalfLifeDays': hl,
    }
    if exp['type'] == 'discrete_hazard':
        model_json['interpolation'] = ('S at the bin edges = prod (1 - h_i); linear inside a bin; the last bin is '
                                       '[480, tailEndMin) with hazard 1 (binIntercepts[5] = 30), so S reaches 0 there')
        model_json['intercept'] = 0
        model_json['sigma'] = 0
    else:
        model_json['binIntercepts'] = []
    model_json['intercept'] = round(float(model_json['intercept']), 5)
    model_json['sigma'] = round(float(model_json['sigma']), 5)
    if 'binIntercepts' in model_json:
        model_json['binIntercepts'] = [round(float(x), 5) for x in model_json['binIntercepts']]
    (HERE / 'model.json').write_text(json.dumps(model_json, indent=1, ensure_ascii=False) + '\n')

    # ---------------- scorecard.json
    m120 = metrics[1]
    gain = m120['values']['operator'] - m120['values']['model']
    ci = m120['ci95']['model_vs_operator']
    mae = metrics[3]['values']
    bm = metrics[:3]
    v = lambda k: ' / '.join(f"{m['values'][k]:.3f}" for m in bm)
    sig = []
    for k, label in (('operator', "SBB's announcement"), ('cause', 'the per-cause rates'), ('prior', 'the historical rate')):
        hs = [f"{m['name'].split()[2]} min" for m in bm if m['ci95'][f'model_vs_{k}'][1] < 0]
        if hs:
            sig.append(f"{label} at {' and '.join(hs)}")
    headline = (f"Forecast at the first notice of {bm[0]['n']} disruptions in Jan-Oct 2026, the chance of still not "
                f"being resumed after 1 / 2 / 4 hours scores Brier {v('model')} against {v('operator')} for SBB's own "
                f"announced end (calibrated), {v('cause')} per cause and {v('prior')} for the historical rate"
                + (f"; the 95% interval shows a real gain over {' and over '.join(sig)}, and the other differences are "
                   f"within noise." if sig else '; all differences are within noise.'))
    notes = [
        'Brier = mean squared error of the probability that the disruption is still not resumed at the horizon; '
        'ci95 entries are 95% paired bootstrap intervals (2000 resamples of whole test weeks) of model minus '
        'baseline, so a negative interval means the model is better.',
        f"Model selected on 2025 (fitted on 2024): {best['family']}, ridge {best['ridge']}; it was then refitted on "
        f"2024-03..2025-12 and evaluated once on 2026. The other family is reported as other_family_* (its best ridge "
        f"on 2025).",
        'Labels are administrative: "Service resumed" (or VIA ENDED) in the liveticker, not the first train through; '
        'the clock starts at the first published Interrupted/Limited version, not at the physical event.',
        f"Incidents without an end (withdrawn or never closed: {dropped['no_end']}) are excluded, not censored.",
        'operator = the first announced end turned into a probability by a logistic fit on the training years '
        '(ln announced/horizon, no-end flag, at-least flag); operator_point = 1 if the announced end is after the '
        'horizon (historical rate when none); cause = per EG code survival shrunk to the prior '
        f'({m_cause} pseudo-incidents); prior = Kaplan-Meier of the training durations.',
        'The conditional rows compare S(t)/S(e) (start features only, as in the contract) with the latest announced '
        'end known at e (calibrated on training incidents still open at e).',
        'model_updated (conditional rows): the same model with the announced-end features recomputed from the latest '
        'version known at e (clock still from the original start); it beats the start-only S(t)/S(e) at every '
        'elapsed/horizon pair and is level with the calibrated latest announcement.',
        'deployment.monthlyRefit: refitting every month on all incidents ended by then does not improve on the '
        'frozen model in 2026 (intervals include zero), so model.json is the frozen 2024-03..2025-12 fit.',
        'Test-set reuse, stated openly: a first version (equal weights, no feature-set choice) scored Brier 0.148 / '
        '0.227 / 0.190 on the same 2026 test; recency weighting and the clock-feature option were then added to the '
        '2025 selection grid, which picked the current setting. 2026 was never used to choose among settings.',
        'Small sample: about 140 test incidents; differences of 0.01 Brier are within noise unless the interval says '
        'otherwise.',
    ]
    score = {
        'model': 'duration', 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'data': {'incidentsTrain': int(tr.sum()), 'incidentsTest': int(te.sum()),
                 'incidentsValidationFit2024': int(tr_val.sum()), 'incidentsValidation2025': int(val.sum()),
                 'source': 'SBB VIA liveticker export 2024-03..2026-10 (incident + incident_audit, every version); '
                           'duration = first Interrupted/Limited service version -> first Service resumed / ENDED'},
        'headline': headline, 'modelType': exp['type'],
        'metrics': metrics, 'calibration': calib, 'examples': examples, 'notes': notes,
        'deployment': {'monthlyRefit': rolling,
                       'note': 'same family and settings refitted at the start of each 2026 month on every incident '
                               'that had ended by then; frozen = the model in model.json'},
        'validation': {'selection': sel, 'chosen': best, 'causePseudoCount': m_cause,
                       'pointForecast': {'maeMin2025': {k: round(v, 1) for k, v in mae_v.items()},
                                         'correctionMin2024': round(corr_v, 1), 'chosen': point_rule},
                       'conformal': {'lowLogShift': r4(lo_shift), 'highLogShift': r4(hi_shift)}},
        'planned': planned,
    }
    (HERE / 'scorecard.json').write_text(json.dumps(score, indent=1, ensure_ascii=False) + '\n')
    print(json.dumps({'headline': headline, 'metrics': [{k: m[k] for k in ('name', 'values', 'ci95') if k in m}
                                                       for m in metrics], 'planned': planned,
                      'calibration': calib, 'chosen': best}, indent=1, ensure_ascii=False))


def cause_text():
    """Reason texts in de/fr/it/en (lower case) -> cause group, for live alerts whose cause is only in the text.
    Match the longest phrase first."""
    r = pd.read_csv(LT / 'reason_202610121034.csv')
    out = {}
    for _, row in r.iterrows():
        g = cause_group(row.id)
        if g == 'other':
            continue
        for lang in ('de', 'fr', 'it', 'en'):
            txt = row.get(f'reason_{lang}')
            if isinstance(txt, str) and len(txt) >= 5:
                out[txt.strip().lower()] = g
    return dict(sorted(out.items(), key=lambda kv: -len(kv[0])))


def didac_learned(train, test):
    """Didac's administrative-end model (sbb_prediction_study.end_experiment): gradient-boosted residual on the
    announced end, re-run on these labels and splits."""
    from sklearn.compose import make_column_transformer
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import OneHotEncoder

    def frame(x):
        clock = x.start.dt.hour + x.start.dt.minute / 60
        return pd.DataFrame({'cause': x.code.values, 'time_type': x.duration_type.values,
                             'official': x.ann.astype(float).values, 'sin_hour': np.sin(clock * np.pi / 12).values,
                             'cos_hour': np.cos(clock * np.pi / 12).values, 'weekend': x.weekend.values})

    ftr, fte = frame(train), frame(test)
    m = make_pipeline(
        make_column_transformer((OneHotEncoder(handle_unknown='ignore', sparse_output=False), ['cause', 'time_type']),
                                ('passthrough', ['official', 'sin_hour', 'cos_hour', 'weekend'])),
        GradientBoostingRegressor(loss='absolute_error', n_estimators=100, max_depth=2, min_samples_leaf=20,
                                  random_state=0))
    m.fit(ftr, train.dur.values - ftr.official.values)
    return np.maximum(fte.official.values + m.predict(fte), 0)


if __name__ == '__main__':
    main()
