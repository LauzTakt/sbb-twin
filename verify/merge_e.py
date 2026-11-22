# Gate E results: "before" from the full-length replay (05:30 start, main), "after" from the current planner commit's
# two short replay instances (06:25 start for W1, 10:48 start for W2; earlier decisions applied at their own times).
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import RESULTS, dump  # noqa: E402


def main():
    full = json.load(open(os.path.join(RESULTS, "gate_e-full-10c3bdc-and-main.json")))
    out = dict(witnesses=full["witnesses"], summary={}, results={}, sources={})
    out["summary"]["before"] = full["summary"]["before"]
    out["results"]["before"] = full["results"]["before"]
    out["sources"]["before"] = "full replay from 05:30 on main"
    w1p, w2p = os.path.join(RESULTS, "gate_e-after-w1.json"), os.path.join(RESULTS, "gate_e-after-w2.json")
    if os.path.exists(w1p) and os.path.exists(w2p):
        w1, w2 = json.load(open(w1p)), json.load(open(w2p))
        r1, r2 = w1["results"]["after"], w2["results"]["after"]
        out["results"]["after"] = dict(W1=r1["W1"], W2=r2["W2"], snapshots=r1["snapshots"] + r2["snapshots"])
        out["summary"]["after"] = dict(W1=w1["summary"]["after"]["W1"], W1violations=w1["summary"]["after"]["W1violations"],
                                       W1seen18823=w1["summary"]["after"].get("W1seen18823"), W2=w2["summary"]["after"]["W2"],
                                       W2offered=w2["summary"]["after"]["W2offered"])
        out["sources"]["after"] = "current planner commit: replay instances from 06:25 (W1) and 10:48 (W2)"
    else:
        out["summary"]["after"] = full["summary"]["after"]
        out["results"]["after"] = full["results"]["after"]
        out["sources"]["after"] = "full replay from 05:30 on 10c3bdc"
    dump(os.path.join(RESULTS, "gate_e.json"), out)
    print(json.dumps(out["summary"], ensure_ascii=False)[:1500])


if __name__ == "__main__":
    main()
