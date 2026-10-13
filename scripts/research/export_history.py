"""
Write the verified historical results the app displays (src/lib/research/history.json).
Every number is copied from the research outputs; nothing is typed by hand.

    python3 scripts/research/export_history.py --dir research-out --out src/lib/research/history.json
"""
import argparse
import json
import os


def pick(s, n_key="n"):
    n = s.get("n", s.get("wins", 0) + s.get("losses", 0))
    return {"n": n, "winRate": s["winRate"], "ci95": s["ci95"], **({"net": s["netUnits"]} if "netUnits" in s else {}), **({"coverage": s["coverage"]} if s.get("coverage") is not None else {}), **({"signals": s["signals"]} if "signals" in s else {})}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cmp_ = json.load(open(os.path.join(a.dir, "compare.json")))
    ml = json.load(open(os.path.join(a.dir, "ml.json")))
    wf = json.load(open(os.path.join(a.dir, "walkforward-fade.json")))
    v = cmp_["versions"]
    test = "TEST"
    rows = [
        {"id": "v1-strict", "label": "v1 Strict (old)", "test": pick(v["v1 STRICT"]["onTime"][test]), "late": pick(v["v1 STRICT"]["oneCandleLate"][test])},
        {"id": "v1-normal", "label": "v1 Normal (old)", "test": pick(v["v1 NORMAL"]["onTime"][test]), "late": pick(v["v1 NORMAL"]["oneCandleLate"][test])},
        {"id": "v2", "label": "v2 Fade (active)", "test": pick(ml["v2_sameRows"]["TEST"]), "late": pick(ml["v2_sameRows"]["TEST_lateEntry"])},
        {"id": "v2-wf", "label": "v2 re-chosen monthly (walk-forward)", "test": pick(wf["TEST (2020-01..2020-05)"]["walkForward"]), "late": pick(wf["TEST (2020-01..2020-05)"]["walkForward_late"])},
        {"id": "v3", "label": "v3 ML (shadow, frozen)", "test": pick(ml["models"]["lightgbm"]["TEST"]), "late": pick(ml["models"]["lightgbm"]["TEST_lateEntry"])},
        {"id": "v3-wf", "label": "v3 ML retrained monthly", "test": pick(ml["walkForward_lightgbm"]["TEST"]), "late": None},
    ]
    out = {
        "source": "OANDA 1-minute mid candles (github.com/FutureSharks/financial-data), EUR/USD GBP/USD USD/CAD AUD/USD EUR/JPY AUD/JPY",
        "period": {"train": "2018-07-01 – 2019-06-30", "validation": "2019-07-01 – 2019-12-31", "test": "2020-01-01 – 2020-05-14"},
        "testOpportunities": ml["v2_sameRows"]["TEST"]["opportunities"],
        "payout": cmp_["payout"],
        "breakEven": cmp_["breakEven"],
        "outcomeRule": "Entry = open of the candle after the signal candle, expiry = its close. Tie (close = open) refunds and is excluded from the win rate. 'Late' = entered one full candle later.",
        "versions": rows,
        "v2ByPair": {k: pick(x) for k, x in v["v2 FADE"]["TEST_byPair"].items()},
        "v2BySession": {k: pick(x) for k, x in v["v2 FADE"]["TEST_bySession"].items()},
        "v2ByRegime": {k: pick(x) for k, x in v["v2 FADE"]["TEST_byRegime"].items()},
        "v3ByPair": {k: pick(x) for k, x in ml["models"]["lightgbm"]["TEST_by_pair"].items()},
        "otc": "No OTC data exists from any permitted source, so nothing was or can be tested for OTC.",
        "highestValidationBucket": ml["highestValidationWinRateWith30Trades"][0],
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    for r in rows:
        print(r["label"], r["test"])


if __name__ == "__main__":
    main()
