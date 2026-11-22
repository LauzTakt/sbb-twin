"""Parity harness library: private twin instances, virtual-clock synchronisation, JSON diff with tolerances."""
import json, os, random, re, signal, socket, subprocess, sys, threading, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
KT_ROOT = os.path.dirname(HERE)                      # .../kotlin
REPO = os.path.dirname(KT_ROOT)                      # worktree root
TS_DIR = os.environ.get("PARITY_TS_DIR", "/workspace/rail-twin")
JAR = os.environ.get("PARITY_JAR", os.path.join(KT_ROOT, "build/libs/sbb-twin-kotlin-all.jar"))
JAVA = os.environ.get("PARITY_JAVA", "/home/agent/.local/jdk-21/bin/java")
SCRATCH = os.environ.get("PARITY_SCRATCH", "/tmp/claude-1000/-workspace/fd11487b-ad76-4fbd-b488-79355a506188/scratchpad/parity")
os.makedirs(SCRATCH, exist_ok=True)
FORBIDDEN = {8787, 8080}

# ------------------------------------------------------------------ http
def http(method, url, body=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, code = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    except Exception as e:  # connection problems
        return (-1, {"_transport_error": str(e)})
    try:
        return (code, json.loads(raw))
    except Exception:
        return (code, raw.decode("utf8", "replace")[:2000])

def port_free(p):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", p)) != 0

def pick_port(lo, hi):
    ports = list(range(lo, hi + 1)); random.shuffle(ports)
    for p in ports:
        if p not in FORBIDDEN and port_free(p):
            return p
    raise RuntimeError("no free port")

def kill_port(port):
    """Kill processes whose environment says PORT=<port> (and our scratch state file). Never pkill -f."""
    if port in FORBIDDEN: return
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
        except Exception:
            continue
        e = {x.split(b"=", 1)[0]: x.split(b"=", 1)[1] for x in env if b"=" in x}
        if e.get(b"PORT") == str(port).encode() and e.get(b"RAIL_STATE_FILE", b"").startswith(SCRATCH.encode()):
            try: os.kill(int(pid), signal.SIGKILL)
            except Exception: pass

# ------------------------------------------------------------------ instances
class Instance:
    def __init__(self, kind, port, replay="2026-11-22T08:00", speed=1, extra_env=None, tag=""):
        self.kind, self.port, self.replay, self.speed = kind, port, replay, speed
        self.extra_env = extra_env or {}
        self.tag = tag or kind
        self.proc = None
        self.v0 = 0.0  # virtual(real_ms) = v0 + speed * real_ms
        self.base = f"http://127.0.0.1:{port}"
        self.log = os.path.join(SCRATCH, f"{self.tag}-{port}.log")

    def env(self):
        e = dict(os.environ)
        e.update({"MQTT_URL": "", "OTD_GTFS_RT_KEY": "", "OTD_GTFS_SA_KEY": "", "ANTHROPIC_API_KEY": "", "HOST": "127.0.0.1",
                  "PORT": str(self.port), "RAIL_STATE_FILE": os.path.join(SCRATCH, f"state-{self.tag}-{self.port}.json"),
                  "RAIL_REPLAY": self.replay, "RAIL_REPLAY_SPEED": str(self.speed), "NODE_ENV": "production"})
        for k in ("RAIL_REPLAY_SCENARIO",):
            e.pop(k, None)
        e.update(self.extra_env)
        try: os.remove(e["RAIL_STATE_FILE"])
        except FileNotFoundError: pass
        return e

    def start(self):
        assert self.port not in FORBIDDEN
        if self.kind == "ts":
            cmd, cwd = ["npx", "tsx", "src/main.ts"], TS_DIR
        else:
            cmd, cwd = [JAVA, "-Xmx2g", "-jar", JAR], REPO
        self.proc = subprocess.Popen(cmd, cwd=cwd, env=self.env(), stdout=open(self.log, "w"), stderr=subprocess.STDOUT, start_new_session=True)

    def wait_ready(self, timeout=180):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"{self.tag} exited early, see {self.log}")
            c, j = http("GET", self.base + "/api/status", timeout=5)
            if c == 200 and isinstance(j, dict) and j.get("trainsActive", 0) > 0:
                return
            time.sleep(0.5)
        raise RuntimeError(f"{self.tag} not ready, see {self.log}")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try: os.killpg(self.proc.pid, signal.SIGTERM)
            except Exception: pass
            for _ in range(30):
                if self.proc.poll() is not None: break
                time.sleep(0.2)
            try: os.killpg(self.proc.pid, signal.SIGKILL)
            except Exception: pass
        kill_port(self.port)

    def calibrate(self, n=9):
        best = None
        for _ in range(n):
            t0 = time.time() * 1000
            c, j = http("GET", self.base + "/api/status", timeout=10)
            t1 = time.time() * 1000
            if c != 200: continue
            if best is None or t1 - t0 < best[0]:
                best = (t1 - t0, j["ts"] - self.speed * (t0 + t1) / 2)
            time.sleep(0.05)
        self.v0 = best[1]

    def virtual(self):
        return self.v0 + self.speed * time.time() * 1000

    def req(self, method, path, body=None, target=None):
        """Request when this instance's virtual clock reaches `target` (epoch ms), if given."""
        if target is not None:
            wait = ((target - self.v0) / self.speed - time.time() * 1000) / 1000
            if wait > 0: time.sleep(wait)
        return http(method, self.base + path, body)

class Pair:
    def __init__(self, a, b):
        self.a, self.b = a, b
    def calibrate(self):
        self.a.calibrate(); self.b.calibrate()
    def virtual(self):
        return max(self.a.virtual(), self.b.virtual())
    def both(self, path, method="GET", body=None, target=None, body_b=None):
        """Same request on both at the same virtual instant. Returns ((code, json) a, (code, json) b)."""
        out = [None, None]
        def run(i, inst, bd):
            out[i] = inst.req(method, path, bd, target)
        ts = [threading.Thread(target=run, args=(0, self.a, body)), threading.Thread(target=run, args=(1, self.b, body if body_b is None else body_b))]
        for t in ts: t.start()
        for t in ts: t.join()
        return out[0], out[1]
    def wait_until(self, target):
        d = (target - self.virtual()) / self.a.speed / 1000
        if d > 0: time.sleep(d)
    def stop(self):
        self.a.stop(); self.b.stop()

def start_pair(kind_b="ts", replay="2026-11-22T08:00", speed=1, jar_port=None, extra_env=None, tag=""):
    """A = TypeScript twin (reference), B = Kotlin (or a 2nd TypeScript twin to validate the harness)."""
    a = Instance("ts", pick_port(8800, 8899), replay, speed, extra_env, "ts" + tag)
    b = Instance(kind_b, jar_port or (pick_port(8900, 8999) if kind_b == "kt" else pick_port(8800, 8899)), replay, speed, extra_env, kind_b + tag)
    if kind_b == "ts": b.tag = "ts2" + tag; b.log = os.path.join(SCRATCH, f"{b.tag}-{b.port}.log")
    p = Pair(a, b)
    try:
        a.start(); b.start()
        a.wait_ready(); b.wait_ready()
        time.sleep(3)
        p.calibrate()
    except Exception:
        p.stop(); raise
    return p

# ------------------------------------------------------------------ id normalisation
_ID1 = re.compile(r"\b[dmi]-([0-9a-f]{6,8})\b")
_ID2 = re.compile(r"EV-([0-9a-f]{8})-([0-9a-f]{6})-")
def normalize(x):
    """Replace server-generated random ids (d-xxxxxxxx, m-xxxxxx, i-xxxxxxxx, EV-<d>-<m>-...) by their order of appearance."""
    s = json.dumps(x, sort_keys=True, ensure_ascii=False)
    m = {}
    def tok(h):
        return m.setdefault(h, f"ID{len(m)}")
    # order of appearance in the text
    def sub1(mo): return mo.group(0)[:2].replace(mo.group(0)[:2], mo.group(0)[:2]) + tok(mo.group(1))
    s = re.sub(r"EV-([0-9a-f]{8})-([0-9a-f]{6})-", lambda mo: f"EV-{tok(mo.group(1))}-{tok(mo.group(2))}-", s)
    s = re.sub(r"\b([dmi])-([0-9a-f]{6,8})\b", lambda mo: f"{mo.group(1)}-{tok(mo.group(2))}", s)
    return json.loads(s)

# ------------------------------------------------------------------ diff
TIME_TOL_MS = 1500
class Cmp:
    def __init__(self):
        self.tol = 0; self.diffs = []; self.maxdev = {}; self.notes = []
    @property
    def status(self):
        return "differs" if self.diffs else ("within tolerance" if self.tol else "exact")
    def add_diff(self, path, a, b):
        self.diffs.append((path, a, b))
    def merge(self, o):
        self.tol += o.tol; self.diffs += o.diffs; self.notes += o.notes
        for k, v in o.maxdev.items(): self.maxdev[k] = max(self.maxdev.get(k, 0), v)
        return self
    def details(self, n=4):
        parts = []
        if self.tol: parts.append(f"{self.tol} values within tolerance" + (" (max " + ", ".join(f"{k}={v:.3g}" for k, v in sorted(self.maxdev.items())) + ")" if self.maxdev else ""))
        for p, a, b in self.diffs[:n]:
            sa, sb = json.dumps(a, ensure_ascii=False)[:70], json.dumps(b, ensure_ascii=False)[:70]
            parts.append(f"{p}: ts={sa} kt={sb}")
        if len(self.diffs) > n: parts.append(f"... {len(self.diffs) - n} more differences")
        parts += self.notes[:2]
        return "; ".join(parts)

def isnum(x): return isinstance(x, (int, float)) and not isinstance(x, bool)

def diff(a, b, ignore=(), tol_by_key=None, time_tol=TIME_TOL_MS, path="$", c=None, float_tol=1e-9):
    """Deep compare. ignore: key names skipped anywhere. tol_by_key: absolute tolerance per key name.
    Numbers above 1e12 (epoch ms) use time_tol."""
    c = c or Cmp(); tol_by_key = tol_by_key or {}
    key = path.rsplit(".", 1)[-1].split("[")[0]
    if isnum(a) and isnum(b):
        if a == b: return c
        d = abs(a - b)
        tol = time_tol if (abs(a) > 1e12 or abs(b) > 1e12) else tol_by_key.get(key, max(float_tol, 1e-9 * max(abs(a), abs(b))))
        if d <= tol:
            c.tol += 1; c.maxdev[key] = max(c.maxdev.get(key, 0), d)
        else: c.add_diff(path, a, b)
    elif isinstance(a, dict) and isinstance(b, dict):
        for k in a.keys() | b.keys():
            if k in ignore: continue
            if k not in a: c.add_diff(f"{path}.{k}", "<missing>", b[k])
            elif k not in b: c.add_diff(f"{path}.{k}", a[k], "<missing>")
            else: diff(a[k], b[k], ignore, tol_by_key, time_tol, f"{path}.{k}", c, float_tol)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b): c.add_diff(f"{path}[len]", len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)): diff(x, y, ignore, tol_by_key, time_tol, f"{path}[{i}]", c, float_tol)
    elif a != b or type(a) != type(b) and not (isnum(a) and isnum(b)):
        c.add_diff(path, a, b)
    return c

def shape(x):
    """Structure only: keys and JSON types."""
    if isinstance(x, dict): return {k: shape(v) for k, v in x.items()}
    if isinstance(x, list): return [shape(x[0])] if x else []
    if x is None: return "null"
    if isinstance(x, bool): return "bool"
    if isnum(x): return "number"
    return "string"

def compare_json(ra, rb, **kw):
    """ra, rb = (code, json). HTTP status must match."""
    c = Cmp()
    if ra[0] != rb[0]:
        c.add_diff("http status", ra[0], rb[0]); return c
    return diff(normalize(ra[1]) if kw.pop("norm", False) else ra[1], normalize(rb[1]) if False else rb[1], c=c, **kw)

def compare_norm(ra, rb, **kw):
    c = Cmp()
    if ra[0] != rb[0]:
        c.add_diff("http status", ra[0], rb[0]); return c
    return diff(normalize(ra[1]), normalize(rb[1]), c=c, **kw)

WORST = {"exact": 0, "within tolerance": 1, "differs": 2}
def worst(*statuses):
    return max(statuses, key=lambda s: WORST[s]) if statuses else "exact"

def metres(lat1, lon1, lat2, lon2):
    import math
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)); y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6371008.8
