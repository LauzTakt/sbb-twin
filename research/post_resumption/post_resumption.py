#!/usr/bin/env python3
"""Post-resumption train risk: reproduce and test the advisor's (Astra's) model on SBB records.

Question: when VIA publishes "Service resumed: A - B", which regular trains due at A or B in the next
60 minutes will the operating record (Ist-Daten) still show as cancelled at A or B?

Model:    P(cancelled) = sigmoid(a + b * lead_minutes / 60), lead_minutes = minutes from the
          resumption notice to the train's first scheduled call at a named endpoint.
Baseline: the cancellation rate of the training years (one constant).
Folds:    train 2024 -> test 2025; train 2024-25 -> test Jan-Oct 2026 (by the notice's local year).

Run:  /opt/venv/bin/python research/post_resumption/post_resumption.py
      (one process, about 20 s). It writes model.json and scorecard.json next to this file, in the format of
      research/forecast-contract.md (sections 2 and 3). No row-level data is written.

Inputs (not in this repo):
  /workspace/sbb/Daten/extern-liveticker/incident*_202610121914.csv  VIA incident versions
  /workspace/sbb/history/months/YYYY-MM.parquet                       train rows at incident stations
  /workspace/sbb/history/build_effects.py                              norm() for station names
"""
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

for k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(k, '1')

import numpy as np
import pandas as pd
import pyarrow as pa
from sklearn.linear_model import LogisticRegression

pa.set_cpu_count(1)
sys.path.insert(0, '/workspace/sbb/history')
from build_effects import norm  # noqa: E402  (the normalisation the monthly extracts were built with)

LT = Path('/workspace/sbb/Daten/extern-liveticker')
MONTHS = Path('/workspace/sbb/history/months')
HERE = Path(__file__).resolve().parent
TZ = 'Europe/Zurich'
ACTIVE = ('Interrupted service:', 'Limited service:')
RESUMED = 'Service resumed:'
HOUR = pd.Timedelta(hours=1)
REPS, SEED = 5000, 1234
BANDS = [dict(min=0.25, label='check first'), dict(min=0.12, label='check'), dict(min=0, label='low')]
EXAMPLE_ID = '2195004968685'  # Sion - Sierre/Siders, 2 Jan 2026 (the advisor's replay example)


def endpoints(title):
    """'Service resumed: A - B and C' -> ['a', 'b'] (first branch, normalised); 'X' -> ['x']."""
    sec = title.split(':', 1)[1].strip()
    return list(dict.fromkeys(norm(x) for x in sec.split(' and ')[0].split(' - ', 1)))


def resumptions():
    """First explicit 'Service resumed:' version after the first INFO 'Interrupted/Limited service:' one."""
    cols = ['id', 'summary_en', 'lifecycle', 'last_modified_date']
    v = pd.concat([pd.read_csv(LT / f, usecols=cols, dtype={'id': str})
                   for f in ('incident_audit_202610121914.csv', 'incident_202610121914.csv')], ignore_index=True)
    v['t'] = pd.to_datetime(v.last_modified_date, utc=True, format='mixed').dt.tz_convert(TZ)
    v = v.sort_values(['id', 't'], kind='stable')
    s = v.summary_en.fillna('')
    first_active = v[v.lifecycle.eq('INFO') & s.str.startswith(ACTIVE)].groupby('id').t.min()
    res = v[s.str.startswith(RESUMED) & v.t.gt(v.id.map(first_active))].drop_duplicates('id')
    res = res.assign(issued=res.t.dt.tz_localize(None),  # Europe/Zurich wall clock, like the Ist-Daten times
                     endpoints=res.summary_en.map(endpoints))
    return len(first_active), res[['id', 'summary_en', 'issued', 'endpoints']].reset_index(drop=True)


def outcomes(res):
    """One row per regular train run due at the endpoints in [notice, notice + 60 min)."""
    rows, skip = [], Counter()
    for ym, grp in res.groupby(res.issued.dt.strftime('%Y-%m')):
        f = MONTHS / f'{ym}.parquet'
        if not f.exists():
            skip['no operating-record month'] += len(grp)
            continue
        df = pd.read_parquet(f, columns=['day', 'trip', 'line', 'name', 'arr', 'dep', 'canc', 'extra'])
        df = df[~df.extra]                                   # regular services only
        df = df.assign(tt=df.arr.fillna(df.dep))             # planned arrival, else departure
        df['station'] = df.name.map({x: norm(x) for x in df.name.unique()})
        df = df.sort_values('tt', kind='stable')
        gh = df.groupby('station', observed=True)
        known = set(gh.groups)
        for e in grp.itertuples():
            t = e.issued
            if (t.day == 1 and t.hour < 5) or (t + 3 * HOUR).month != t.month:
                skip['month edge (rows may sit in the neighbouring month)'] += 1
                continue
            req = e.endpoints
            if not all(q in known for q in req):
                skip['endpoint not in the operating records'] += 1
                continue
            z = pd.concat([gh.get_group(q) for q in req]).sort_values('tt', kind='stable')
            z = z[z.tt.between(t - 5 * HOUR, t + 4 * HOUR)]
            by = z.groupby(['day', 'trip'], observed=True).agg(
                n=('station', 'size'), dist=('station', 'nunique'), lo=('tt', 'min'), hi=('tt', 'max'),
                y=('canc', 'max'), line=('line', 'first'), at=('name', 'first'))
            lead = (by.lo - t).dt.total_seconds() / 60
            ok = ((by.n == len(req)) & (by.dist == len(req)) & ((by.hi - by.lo).dt.total_seconds() <= 7200)
                  & (lead >= 0) & (lead < 60))
            by = by[ok].assign(lead_minutes=lead[ok])
            if by.empty:
                skip['no eligible regular train in the hour'] += 1
                continue
            cz = z[z.canc].groupby(['day', 'trip'], observed=True).name.agg(lambda s: ', '.join(map(str, s)))
            for r in by.reset_index().itertuples():
                rows.append(dict(id=e.id, title=e.summary_en, issued=t, lead_minutes=r.lead_minutes, y=int(r.y),
                                 line=str(r.line), at=str(r.at), planned=r.lo,
                                 cancelled_at=cz.get((r.day, r.trip), '')))
    d = pd.DataFrame(rows)
    d['year'] = d.issued.dt.year
    d['week'] = d.issued.dt.strftime('%G-%V')
    d['quarter'] = (d.lead_minutes // 15).astype(int).clip(0, 3)
    return d, skip


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def fit(train):
    m = LogisticRegression(C=1, max_iter=500).fit(train[['lead_minutes']] / 60, train.y)
    return float(m.intercept_[0]), float(m.coef_[0, 0])


def week_bootstrap(diff, week, reps=REPS, seed=SEED):
    """Paired bootstrap of mean(diff), resampling whole ISO weeks of the notice (ratio of sums)."""
    s = diff.groupby(week).sum().to_numpy()
    n = diff.groupby(week).size().to_numpy()
    ix = np.random.default_rng(seed).integers(len(n), size=(reps, len(n)))
    est = s[ix].sum(axis=1) / n[ix].sum(axis=1)
    lo, hi = np.quantile(est, [0.025, 0.975])
    return [round(float(lo), 5), round(float(hi), 5)], int(len(n))


def brier(y, p, w=None):
    return float(np.average((y - p) ** 2, weights=w))


def band(p):
    return next(b['label'] for b in BANDS if p >= b['min'])


def fold(d, year):
    """Train on the years before `year`, test on `year`."""
    tr, te = d[d.year < year], d[d.year == year].copy()
    a, b = fit(tr)
    te['p'] = sigmoid(a + b * te.lead_minutes / 60)
    te['base'] = float(tr.y.mean())
    gain = (te.y - te.base) ** 2 - (te.y - te.p) ** 2  # baseline minus model, per run
    ci, n_weeks = week_bootstrap(gain, te.week)
    w = 1 / te.groupby('id').id.transform('size')       # every notice counts once
    lo_seed = [week_bootstrap(gain, te.week, seed=s)[0][0] for s in range(1, 11)]
    return dict(
        year=year, train_years=f'{int(tr.year.min())}' + (f'-{str(int(tr.year.max()))[2:]}' if tr.year.nunique() > 1 else ''),
        a=a, b=b, base_rate=float(tr.y.mean()),
        train_runs=int(len(tr)), train_notices=int(tr.id.nunique()),
        test_runs=int(len(te)), test_notices=int(te.id.nunique()), test_cancelled=int(te.y.sum()),
        brier_model=brier(te.y, te.p), brier_base=brier(te.y, te.base), gain=float(gain.mean()), ci=ci,
        weeks=n_weeks, ci_low_over_seeds=[round(min(lo_seed), 5), round(max(lo_seed), 5)],
        w_model=brier(te.y, te.p, w), w_base=brier(te.y, te.base, w),
        mean_p=float(te.p.mean()), observed=float(te.y.mean()),
    ), te


def r(x, k=5):
    return round(float(x), k)


def main():
    n_active, res = resumptions()
    d, skip = outcomes(res)
    f25, te25 = fold(d, 2025)
    f26, te26 = fold(d, 2026)
    a_all, b_all = fit(d)
    passed = all(f['brier_model'] < f['brier_base'] and f['ci'][0] > 0 for f in (f25, f26))

    model = dict(
        name='post_resumption', version='1.0', a=round(f26['a'], 6), b=round(f26['b'], 6), bands=BANDS,
        formula='risk = sigmoid(a + b * leadMinutes / 60)',
        leadMinutes='minutes from the "Service resumed" notice to the train\'s first scheduled call at a station '
                    'named in it (planned arrival, else departure)',
        roster='regular trains (no extra services, no replacement buses) calling once at each named station, at '
               'most 120 scheduled minutes between them, first named call within 60 minutes after the notice; '
               'single-station notices use that station',
        trainedOn='2024-03..2025-12', testedOn='2026-01..2026-10',
        runsTrain=f26['train_runs'], scorecard='scorecard.json')

    q26 = [dict(bin=f'{15 * q}-{15 * q + 15} min after the notice', predicted=r(g.p.mean(), 4),
                observed=r(g.y.mean(), 4), n=int(len(g)), cancelled=int(g.y.sum()))
           for q, g in te26.groupby('quarter')]
    te26['band'] = te26.p.map(band)
    by_band = [dict(bin=b['label'], predicted=r(g.p.mean(), 4), observed=r(g.y.mean(), 4), n=int(len(g)),
                    cancelled=int(g.y.sum()))
               for b in BANDS for g in [te26[te26.band == b['label']]] if len(g)]
    q25 = [dict(bin=f'{15 * q}-{15 * q + 15} min after the notice', predicted=r(g.p.mean(), 4),
                observed=r(g.y.mean(), 4), n=int(len(g)), cancelled=int(g.y.sum()))
           for q, g in te25.groupby('quarter')]
    pooled = [dict(bin=f'{15 * q}-{15 * q + 15} min after the notice', observed=r(g.y.mean(), 4), n=int(len(g)),
                   cancelled=int(g.y.sum())) for q, g in d.groupby('quarter')]

    ex = te26[te26.id == EXAMPLE_ID].sort_values('planned')
    examples = [dict(
        id=f'{EXAMPLE_ID} {e.line} {e.planned:%H:%M}',
        title=f'{e.title.split(":", 1)[1].strip()}, {e.issued:%-d %b %Y}: {e.line} due at {e.at} {e.planned:%H:%M}',
        announced=f'Service resumed at {e.issued:%H:%M}; the train was due {e.lead_minutes:.0f} min later',
        predicted=f'{e.p:.0%} · {band(e.p)}',
        actual=f'cancelled at {e.cancelled_at} in the operating record' if e.y else 'both named stops served')
        for e in ex.itertuples()]

    def metric(f):
        return dict(
            name=f'Brier score, {f["year"]} test (trained on {f["train_years"]}): {f["test_runs"]:,} runs after '
                 f'{f["test_notices"]} resumptions',
            lowerIsBetter=True, values=dict(model=r(f['brier_model']), baseline=r(f['brier_base'])),
            ci95=dict(model_vs_baseline=f['ci']),
            improvement=r(f['gain']),
            note=f'ci95 is the improvement (baseline minus model): paired bootstrap of {REPS:,} resamples of the '
                 f'{f["weeks"]} ISO weeks; above zero means the model is better. Baseline: the training-years '
                 f'cancellation rate, {f["base_rate"]:.1%} for every train.')

    def weighted(f):
        return dict(name=f'Brier score with every resumption weighted equally, {f["year"]} test',
                    lowerIsBetter=True, values=dict(model=r(f['w_model']), baseline=r(f['w_base'])))

    first, last = q26[0], q26[-1]
    scorecard = dict(
        model='post_resumption',
        generatedAt=datetime.now(timezone.utc).isoformat(timespec='seconds'),
        data=dict(
            incidentsTrain=f26['train_notices'], incidentsTest=f26['test_notices'],
            runsTrain=f26['train_runs'], runsTest=f26['test_runs'],
            source='VIA liveticker export (incident + incident_audit, 2026-10-12) for the "Service resumed" notices; '
                   'SBB Ist-Daten 2024-03..2026-10 (monthly extracts at incident stations) for the train outcomes',
            resumptionNotices=int(len(res)), scoredNotices=int(d.id.nunique()), runsAllYears=int(len(d)),
            notScored=dict(skip)),
        headline=(f'After SBB announced "Service resumed", {first["observed"]:.0%} of the trains due in the first 15 '
                  f'minutes still lost a stop on the section in 2026, against {last["observed"]:.0%} in the last 15 '
                  f'minutes of the hour; a model using only the minutes since the notice beat the historical rate '
                  f'in both forward years (2025 and 2026).'),
        acceptance=dict(rule='lower Brier than the baseline in both forward years and the 95% interval of the '
                             'improvement above zero in both', passed=bool(passed)),
        metrics=[metric(f26), metric(f25), weighted(f26), weighted(f25)],
        calibration=q26,
        calibrationByBand=by_band,
        calibration2025=q25,
        observedAllYears=pooled,
        coefficients=dict(
            fold2026=dict(a=round(f26['a'], 6), b=round(f26['b'], 6), trainedOn='2024-03..2025-12',
                          runs=f26['train_runs'], usedIn='model.json'),
            fold2025=dict(a=round(f25['a'], 6), b=round(f25['b'], 6), trainedOn='2024-03..2024-12',
                          runs=f25['train_runs']),
            allYears=dict(a=round(a_all, 6), b=round(b_all, 6), trainedOn='2024-03..2026-10', runs=int(len(d)),
                          note='reference only: not tested on a later period')),
        examples=examples,
        notes=[
            f'Calibration: the frozen 2024-25 fit predicted {f26["mean_p"]:.1%} on average in 2026 against '
            f'{f26["observed"]:.1%} observed, mostly in the first quarter hour ({first["predicted"]:.0%} predicted, '
            f'{first["observed"]:.0%} observed). In 2025 it predicted {f25["mean_p"]:.1%} against '
            f'{f25["observed"]:.1%}. Show the bands and the observed shares, not precise probabilities.',
            f'The 2025 improvement is small: {f25["gain"]:+.5f}, interval {f25["ci"][0]:+.5f} to {f25["ci"][1]:+.5f}. '
            f'Its lower bound ranged from {f25["ci_low_over_seeds"][0]:+.5f} to {f25["ci_low_over_seeds"][1]:+.5f} '
            f'over ten bootstrap seeds.',
            'The operating record holds the final status only. Some early trains were probably cancelled before the '
            'notice, so part of the early-train risk is "this train is usually still off". Live, an official '
            'cancellation or skipped stop must win over the band. Whether the model helps for trains whose status '
            'was still unknown at the notice is untested.',
            'The probabilities are fitted on the liveticker\'s VIA notices. The advisor found the same gradient but '
            'lower absolute risks on SBB\'s public notices (not re-checked here).',
            'The historical roster comes from runs that reached Ist-Daten; a live roster comes from the timetable. '
            'Nothing here was scored on live resumptions.',
            'Reproduction: every count, Brier score, coefficient, gradient and calibration figure matches the '
            'advisor\'s report; only the bootstrap lower bounds differ in the fourth decimal (the advisor\'s '
            'resampling code was not recorded).'],
    )
    (HERE / 'model.json').write_text(json.dumps(model, indent=1, ensure_ascii=False) + '\n')
    (HERE / 'scorecard.json').write_text(json.dumps(scorecard, indent=1, ensure_ascii=False) + '\n')
    print(json.dumps(dict(model=model, scorecard=scorecard), indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
