"""
Before-vs-after comparison of the shipped engine versions on the same minutes.

    python3 scripts/research/compare.py --baseline research-out/baseline --v2 research-out/v2 --out research-out/compare.json

Uses the ledgers written by ledger.ts with the REAL TypeScript engine (not the
Python re-implementation used in the search), so these are the numbers of the
code that ships.
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from analyze import SPLITS, PAYOUT, by, load, per_split  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--v2", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    base = load(a.baseline)
    v2 = load(a.v2)[["pair", "time", "d_V2", "fail_V2"]]
    df = base.merge(v2, on=["pair", "time"], how="inner", validate="one_to_one")
    df["month"] = df["ts"].dt.strftime("%Y-%m")
    out = {"rows": len(df), "payout": PAYOUT, "breakEven": round(1 / (1 + PAYOUT), 4), "versions": {}}
    for name, col in [("v1 STRICT", "d_STRICT"), ("v1 NORMAL", "d_NORMAL"), ("v2 FADE", "d_V2")]:
        d = df[col]
        out["versions"][name] = {
            "signalsPerDayPerPair": round(float((d != 0).sum()) / (df["ts"].dt.normalize().nunique() * df["pair"].nunique()), 2),
            "onTime": per_split(df, d, df["r1"]),
            "oneCandleLate": per_split(df, d, df["rl"]),
            "TEST_byPair": by(df[df["split"] == "TEST"], d, df["r1"], "pair"),
            "TEST_bySession": by(df[df["split"] == "TEST"], d, df["r1"], "session"),
            "TEST_byRegime": by(df[df["split"] == "TEST"], d, df["r1"], "regime"),
            "byMonth": {k: {"n": v["wins"] + v["losses"], "winRate": v["winRate"], "net": v["netUnits"]} for k, v in by(df, d, df["r1"], "month").items()},
        }
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, default=str)
    for name, v in out["versions"].items():
        print(f"== {name}  ({v['signalsPerDayPerPair']} signals/day/pair)")
        for split in SPLITS:
            s, l = v["onTime"][split], v["oneCandleLate"][split]
            print(f"  {split:10s} n={s['wins']+s['losses']:6d} win={s['winRate']} ci={s['ci95']} net={s['netUnits']} dd={s['maxDrawdown']} streak={s['longestLosingStreak']} | late win={l['winRate']} net={l['netUnits']}")
        print("  TEST by pair", {k: (x["winRate"], x["wins"] + x["losses"]) for k, x in v["TEST_byPair"].items()})
        print("  TEST by session", {k: (x["winRate"], x["wins"] + x["losses"]) for k, x in v["TEST_bySession"].items()})


if __name__ == "__main__":
    main()
