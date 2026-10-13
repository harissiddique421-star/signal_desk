"""
Pre-registered search for an exhaustion-fade rule set (rules-v2 candidate).

Protocol (fixed before running):
  1. Every grid point is scored on TRAIN only. Ranking key: lower bound of the
     95 % Wilson interval of the on-time win rate, minimum 1,000 decided trades.
  2. The single top-ranked grid point is the pre-registered choice. It is then
     checked on VALIDATION. The top 10 are also shown on VALIDATION so the cost
     of trying many variants (selection bias) is visible.
  3. TEST is reported once, for the pre-registered choice only, plus the old
     STRICT and NORMAL engines for comparison. Nothing is re-tuned after TEST.

    python3 scripts/research/search_fade.py --pickle research-out/baseline.pkl --out research-out/fade-search.json
"""
import argparse
import itertools
import json
import math

import numpy as np
import pandas as pd

PAYOUT = 0.85
BREAK_EVEN = 1 / (1 + PAYOUT)


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def score(d, r):
    m = (d != 0) & ~np.isnan(r) & (r != 0)
    n = int(m.sum())
    w = int(((d[m] * r[m]) > 0).sum())
    lo, hi = wilson(w, n)
    return {"n": n, "winRate": round(w / n, 4) if n else None, "ci95": [round(lo, 4), round(hi, 4)] if n else None, "lo": lo or 0.0}


def fade_direction(df, p):
    """+1 CALL / -1 PUT / 0 no trade. Uses only values known when the signal candle closed."""
    up = (df["pb"] > p["pb"]) & (df["lastDir"] == 1)
    dn = (df["pb"] < 1 - p["pb"]) & (df["lastDir"] == -1)
    ok = df["rangeAtr"] >= p["range"]
    ok &= df["body"] >= p["body"]
    if p["rsi"]:
        up &= df["rsi"] >= p["rsi"]
        dn &= df["rsi"] <= 100 - p["rsi"]
    ok &= df["rangeAtr"] <= p["maxRange"]  # skip true shock candles (news spikes)
    if p["mtf"] == "pullback":  # fade only moves that run against the 5m trend
        up &= df["e_trend"] == -1
        dn &= df["e_trend"] == 1
    elif p["mtf"] == "notAgainst":  # never fade a move that agrees with the 5m trend
        up &= df["e_trend"] != 1
        dn &= df["e_trend"] != -1
    if p["skipLate"]:
        ok &= ~df["hour"].isin([21, 22, 23])
    return np.where(ok & up, -1, np.where(ok & dn, 1, 0))


GRID = {
    "pb": [1.0, 1.1, 1.2],
    "range": [0.0, 1.0, 1.5, 2.0],
    "maxRange": [3.0, 100.0],
    "body": [0.0, 0.5],
    "rsi": [0, 65, 70],
    "mtf": ["ignore", "pullback", "notAgainst"],
    "skipLate": [False, True],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pickle", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    df = pd.read_pickle(a.pickle)
    df = df[df["pb"].notna()].copy()  # rows where the data gates passed (metrics present)
    parts = {s: df[df["split"] == s] for s in ["TRAIN", "VALIDATION", "TEST"]}
    keys = list(GRID)
    results = []
    for combo in itertools.product(*GRID.values()):
        p = dict(zip(keys, combo))
        tr = parts["TRAIN"]
        s = score(fade_direction(tr, p), tr["r1"].to_numpy())
        if s["n"] >= 1000:
            results.append({"params": p, "TRAIN": s})
    results.sort(key=lambda x: x["TRAIN"]["lo"], reverse=True)
    for r in results[:10]:
        v = parts["VALIDATION"]
        r["VALIDATION"] = score(fade_direction(v, r["params"]), v["r1"].to_numpy())
        r["VALIDATION_late"] = score(fade_direction(v, r["params"]), v["rl"].to_numpy())
    chosen = results[0]
    t = parts["TEST"]
    d = fade_direction(t, chosen["params"])
    test = {"onTime": score(d, t["r1"].to_numpy()), "oneCandleLate": score(d, t["rl"].to_numpy())}
    per_pair = {}
    for split in ["TRAIN", "VALIDATION", "TEST"]:
        per_pair[split] = {}
        for pair, g in parts[split].groupby("pair"):
            per_pair[split][pair] = score(fade_direction(g, chosen["params"]), g["r1"].to_numpy())
    out = {
        "gridSize": int(np.prod([len(v) for v in GRID.values()])),
        "eligible": len(results),
        "breakEven": BREAK_EVEN,
        "top10": [{k: v for k, v in r.items()} for r in results[:10]],
        "chosen": chosen["params"],
        "chosenTEST": test,
        "chosenPerPair": per_pair,
    }
    for r in out["top10"]:
        for k in ["TRAIN", "VALIDATION", "VALIDATION_late"]:
            if k in r:
                r[k].pop("lo", None)
    for split in per_pair.values():
        for s in split.values():
            s.pop("lo", None)
    for s in test.values():
        s.pop("lo", None)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print("grid", out["gridSize"], "eligible", out["eligible"])
    for r in out["top10"]:
        print(r["params"], "TRAIN", r["TRAIN"]["winRate"], r["TRAIN"]["n"], "VAL", r["VALIDATION"]["winRate"], r["VALIDATION"]["ci95"], r["VALIDATION"]["n"], "VAL late", r["VALIDATION_late"]["winRate"])
    print("CHOSEN", out["chosen"])
    print("TEST", test)
    for split, pp in per_pair.items():
        print(split, {k: (v["winRate"], v["n"]) for k, v in pp.items()})


if __name__ == "__main__":
    main()
