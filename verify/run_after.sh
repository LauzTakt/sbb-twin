#!/usr/bin/env bash
# The "after" chain against the pinned planner twin (default 8806): A (cached reference) + C validation, B, D.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8806}; CASES=${CASES:-100}; TAG=${TAG:-after}
PY=/opt/venv/bin/python
$PY verify/gate_a.py --twin $TAG=http://127.0.0.1:$PORT --day 2026-11-22 --times 09:37,12:04,16:58,19:33,23:20 --out verify/results/gate_a-$TAG.json > verify/.cache/gate_a-$TAG.log 2>&1
$PY verify/gate_a.py --reclassify verify/results/gate_a-$TAG.json >> verify/.cache/gate_a-$TAG.log 2>&1
$PY verify/failures.py >> verify/.cache/failures.log 2>&1
$PY verify/gate_b.py --twin $TAG=http://127.0.0.1:$PORT --out verify/results/gate_b-$TAG.json > verify/.cache/gate_b-$TAG.log 2>&1
$PY verify/failures.py >> verify/.cache/failures.log 2>&1
$PY verify/gate_d.py --twin http://127.0.0.1:$PORT --label $TAG --cases $CASES --seed 1 > verify/.cache/gate_d-$TAG.log 2>&1
$PY verify/failures.py >> verify/.cache/failures.log 2>&1
echo done > verify/.cache/run_after.done
