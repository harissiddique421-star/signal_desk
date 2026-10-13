"""
Walk-forward test of the v2 SELECTION PROCEDURE (not just the one chosen rule).

    python3 scripts/research/walkforward_fade.py --pickle research-out/baseline.pkl --out research-out/walkforward-fade.json

For every month from 2019-07 to 2020-05: run the same 864-point grid search on
ALL data before that month (expanding window, starting 2018-07), pick the point
with the best lower 95 % bound (≥ 1,000 trades), and trade it during that month
only. Nothing from the month being tested is used to choose its rule. The
shipped v2 rule (chosen once on TRAIN) is scored on the same months.
"""
import argparse
import itertools
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from search_fade import GRID, fade_direction, score  # noqa: E402

SHIPPED = {"pb": 1.0, "range": 2.0, "maxRange": 100.0, "body": 0.5, "rsi": 70, "mtf": "ignore", "skipLate": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pickle", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    df = pd.read_pickle(a.pickle)
    df = df[df["pb"].notna()].copy()
    df["month"] = df["ts"].dt.strftime("%Y-%m")
    months = sorted(m for m in df["month"].unique() if m >= "2019-07")
    keys = list(GRID)
    combos = [dict(zip(keys, c)) for c in itertools.product(*GRID.values())]
    rows = []
    dir_wf = pd.Series(0, index=df.index)
    dir_fixed = pd.Series(fade_direction(df, SHIPPED), index=df.index)
    for m in months:
        past = df[df["month"] < m]
        best, best_lo = None, -1
        for p in combos:
            s = score(fade_direction(past, p), past["r1"].to_numpy())
            if s["n"] >= 1000 and s["lo"] > best_lo:
                best, best_lo = p, s["lo"]
        cur = df[df["month"] == m]
        d = fade_direction(cur, best)
        dir_wf.loc[cur.index] = d
        rows.append({"month": m, "chosen": best, "sameAsShipped": best == SHIPPED, "walkForward": {k: v for k, v in score(d, cur["r1"].to_numpy()).items() if k != "lo"}, "shipped": {k: v for k, v in score(dir_fixed.loc[cur.index].to_numpy(), cur["r1"].to_numpy()).items() if k != "lo"}})
        print(m, "same" if best == SHIPPED else best, rows[-1]["walkForward"]["winRate"], rows[-1]["walkForward"]["n"], "| shipped", rows[-1]["shipped"]["winRate"], flush=True)

    def agg(sel):
        x = df[sel]
        out = {}
        for name, d in [("walkForward", dir_wf), ("shipped", dir_fixed)]:
            out[name] = {k: v for k, v in score(d.loc[x.index].to_numpy(), x["r1"].to_numpy()).items() if k != "lo"}
            out[name + "_late"] = {k: v for k, v in score(d.loc[x.index].to_numpy(), x["rl"].to_numpy()).items() if k != "lo"}
        return out

    result = {
        "months": rows,
        "VALIDATION+TEST (2019-07..2020-05)": agg(df["month"] >= "2019-07"),
        "TEST (2020-01..2020-05)": agg(df["month"] >= "2020-01"),
        "monthsWhereSelectionMatchedShipped": sum(r["sameAsShipped"] for r in rows),
    }
    with open(a.out, "w") as f:
        json.dump(result, f, indent=1)
    for k in ["VALIDATION+TEST (2019-07..2020-05)", "TEST (2020-01..2020-05)"]:
        print(k, {n: (v["winRate"], v["ci95"], v["n"]) for n, v in result[k].items()})


if __name__ == "__main__":
    main()
