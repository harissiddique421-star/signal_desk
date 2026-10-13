"""
Independent reference implementation (pandas) used to cross-check the
TypeScript indicators. Run:  python scripts/gen_indicator_fixture.py
Writes tests/fixtures/indicators.json
"""
import json
import pathlib

import numpy as np
import pandas as pd

rng = np.random.default_rng(42)
n = 300
steps = rng.normal(0, 0.0004, n)
close = 1.10 + np.cumsum(steps)
open_ = np.concatenate([[1.10], close[:-1]])
spread = np.abs(rng.normal(0, 0.0003, n))
high = np.maximum(open_, close) + spread
low = np.minimum(open_, close) - np.abs(rng.normal(0, 0.0003, n))

s = pd.Series(close)


def ema(series, p):
    # SMA-seeded EMA, adjust=False after the seed
    out = pd.Series(np.nan, index=series.index)
    seed = series.iloc[:p].mean()
    out.iloc[p - 1] = seed
    k = 2 / (p + 1)
    prev = seed
    for i in range(p, len(series)):
        prev = series.iloc[i] * k + prev * (1 - k)
        out.iloc[i] = prev
    return out


def rsi(series, p=14):
    d = series.diff()
    gain = d.clip(lower=0)
    loss = -d.clip(upper=0)
    out = pd.Series(np.nan, index=series.index)
    ag = gain.iloc[1 : p + 1].mean()
    al = loss.iloc[1 : p + 1].mean()
    out.iloc[p] = 100 - 100 / (1 + ag / al) if al else 100
    for i in range(p + 1, len(series)):
        ag = (ag * (p - 1) + gain.iloc[i]) / p
        al = (al * (p - 1) + loss.iloc[i]) / p
        out.iloc[i] = 100 - 100 / (1 + ag / al) if al else 100
    return out


fast, slow = ema(s, 12), ema(s, 26)
macd_line = fast - slow
first = macd_line.first_valid_index()
sig = pd.Series(np.nan, index=s.index)
sig.iloc[first:] = ema(macd_line.iloc[first:].reset_index(drop=True), 9).values
hist = macd_line - sig

mid = s.rolling(20).mean()
sd = s.rolling(20).std(ddof=0)
upper, lower = mid + 2 * sd, mid - 2 * sd

prev_close = pd.Series(close).shift(1)
tr = pd.concat(
    [pd.Series(high - low), (pd.Series(high) - prev_close).abs(), (pd.Series(low) - prev_close).abs()], axis=1
).max(axis=1)
tr.iloc[0] = high[0] - low[0]
atr = pd.Series(np.nan, index=s.index)
a = tr.iloc[:14].mean()
atr.iloc[13] = a
for i in range(14, n):
    a = (a * 13 + tr.iloc[i]) / 14
    atr.iloc[i] = a


def clean(x):
    return [None if pd.isna(v) else float(v) for v in x]


out = {
    "candles": [
        {"time": 1_700_000_040_000 + i * 60_000, "open": float(open_[i]), "high": float(high[i]), "low": float(low[i]), "close": float(close[i])}
        for i in range(n)
    ],
    "ema9": clean(ema(s, 9)),
    "ema21": clean(ema(s, 21)),
    "rsi14": clean(rsi(s, 14)),
    "macd": clean(macd_line),
    "macdSignal": clean(sig),
    "macdHist": clean(hist),
    "bbMiddle": clean(mid),
    "bbUpper": clean(upper),
    "bbLower": clean(lower),
    "atr14": clean(atr),
}
p = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "indicators.json"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(out))
print("wrote", p)
