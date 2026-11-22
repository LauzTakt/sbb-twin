# Shared helpers for the verification gates: HTTP (stdlib urllib), polite cached reference calls, times.
import gzip, hashlib, json, os, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

Z = ZoneInfo("Europe/Zurich")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
CACHE = os.path.join(HERE, ".cache")
UA = {"user-agent": "rail-twin-verify/1.0 (planner verification harness)"}


def get_json(url, timeout=30, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = dict(UA)
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


_last_ref = [0.0]


def ref_get(url, cache_dir, min_interval=1.05):
    """transport.opendata.ch: at most one request per second, cached on disk by URL (raw response kept)."""
    os.makedirs(cache_dir, exist_ok=True)
    fn = os.path.join(cache_dir, hashlib.sha1(url.encode()).hexdigest()[:16] + ".json.gz")
    if os.path.exists(fn):
        with gzip.open(fn, "rt") as f:
            return json.load(f)
    for attempt in range(4):
        wait = _last_ref[0] + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_ref[0] = time.time()
        try:
            status, body = get_json(url, timeout=40)
        except Exception as e:  # network hiccup: back off and retry
            status, body = 0, {"error": str(e)}
        if status == 200:
            rec = dict(url=url, fetchedAt=datetime.now(Z).isoformat(), status=status, body=body)
            with gzip.open(fn, "wt") as f:
                json.dump(rec, f, ensure_ascii=False)
            return rec
        time.sleep(3 * (attempt + 1))
    return dict(url=url, fetchedAt=datetime.now(Z).isoformat(), status=status, body=body)


def save_raw(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt") as f:
        json.dump(obj, f, ensure_ascii=False)


def hms(ms_or_s, ms=True):
    if ms_or_s is None:
        return "-"
    t = ms_or_s / 1000 if ms else ms_or_s
    return datetime.fromtimestamp(t, Z).strftime("%H:%M:%S")


def local_epoch(day, hhmm):
    """'2026-11-22', '23:20' -> epoch seconds (Swiss local time)."""
    d = datetime.strptime(f"{day} {hhmm}", "%Y-%m-%d %H:%M").replace(tzinfo=Z)
    return int(d.timestamp())


def service_midnight(yyyymmdd):
    """GTFS service day reference ('noon minus 12h'; no DST change on these dates)."""
    d = datetime.strptime(yyyymmdd, "%Y%m%d").replace(hour=12, tzinfo=Z) - timedelta(hours=12)
    return int(d.timestamp())


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
