"""
Parity fixture for the TypeScript port of the v3 shadow model.

    python3 scripts/research/gen_ml_fixture.py --model research-out/model-v3.lgb.txt --json src/lib/ml/model-v3.json --out tests/fixtures/ml-v3.json

Synthetic, seeded candles (no market data is committed). For several bars the
features are computed by features.py on exactly the 300-candle window the app
would see, and the probability by LightGBM itself (not by a re-implementation).
"""
import argparse
import json
import os
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from features import build  # noqa: E402

FEATURES = ["ret1", "ret2", "ret3", "ret5", "ret10", "ret20", "ret60", "run", "body", "upw", "loww", "rangeAtr", "bodyAtr", "prevBody", "rsi14", "rsi7", "pb", "macdh", "macdhD", "ema9_21", "c_ema50", "ema21slope", "atrPct", "atrRatio", "bbwAtr", "distHi20", "distLo20", "pos20", "r5", "hourSin", "hourCos", "dow", "min5"]


def candles(seed, n=420, start="2020-03-02T09:00:00Z", base=1.1):
    rng = np.random.default_rng(seed)
    t0 = pd.Timestamp(start).value // 10**6
    out, price = [], base
    vol = 0.00012
    for i in range(n):
        vol = max(0.00003, vol * np.exp(rng.normal(0, 0.08)))
        o = price
        moves = o + np.cumsum(rng.normal(0, vol / 2, 6))
        if i % 97 == 50:  # occasional large candle
            moves[-1] = o + 6 * vol * (1 if rng.random() < 0.5 else -1)
        c = float(moves[-1])
        h = float(max(o, c, moves.max()) + abs(rng.normal(0, vol / 4)))
        l_ = float(min(o, c, moves.min()) - abs(rng.normal(0, vol / 4)))
        out.append({"time": int(t0 + i * 60_000), "open": round(o, 6), "high": round(h, 6), "low": round(l_, 6), "close": round(c, 6)})
        price = round(c, 6)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    booster = lgb.Booster(model_file=a.model)
    meta = json.load(open(a.json))
    cases = []
    for seed, pair, base in [(1, "EUR_USD", 1.1), (2, "AUD_JPY", 72.5), (3, "GBP_USD", 1.27)]:
        cs = candles(seed, base=base)
        for i in range(len(cs) - 12, len(cs)):
            window = cs[i - 299 : i + 1]
            df = pd.DataFrame(window).rename(columns={"time": "t"})
            f = build(df, pair).iloc[-1]
            row = pd.DataFrame([f[FEATURES].astype(float).to_dict()])
            row["pair"] = pd.Categorical([pair], categories=meta["pairs"])
            raw = float(booster.predict(row[FEATURES + ["pair"]])[0])
            cal = float(np.interp(raw, meta["isotonic"]["x"], meta["isotonic"]["y"]))
            cases.append({"pair": pair.replace("_", "/"), "windowEnd": i, "features": {k: float(f[k]) for k in FEATURES}, "rawProbability": raw, "probability": cal})
        cases_c = {"pair": pair, "candles": cs}
        cases.append({"series": cases_c})
    series = {c["series"]["pair"]: c["series"]["candles"] for c in cases if "series" in c}
    checks = [c for c in cases if "series" not in c]
    with open(a.out, "w") as fh:
        json.dump({"note": "Synthetic seeded candles; expected values from scripts/research/features.py and LightGBM.", "series": series, "checks": checks}, fh)
    print(len(checks), "checks written; probabilities", min(c["probability"] for c in checks), max(c["probability"] for c in checks))


if __name__ == "__main__":
    main()
