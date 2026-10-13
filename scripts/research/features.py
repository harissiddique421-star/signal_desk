"""
Decision-time feature dataset built straight from raw 1-minute candles.

    python3 scripts/research/features.py --data data --out research-out/features.parquet

Row i describes the moment candle i has CLOSED (the "signal candle"). Every
feature uses candles 0..i only; indicator definitions match src/lib/indicators
(EMA seeded by SMA, Wilder RSI/ATR, population-sd Bollinger). Labels come from
the following candles and are kept in separate `y_*` columns.

Eligibility mirrors the live STRICT/V2 data gate: no missing minute in the last
60 and at least 300 candles of history. Tick volume is NOT used — the live feed
(Twelve Data FX) does not provide comparable volume, so a model using it could
not run live.
"""
import argparse
import glob
import os

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

MS = 60_000


def ema(x, n):
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    k = 2 / (n + 1)
    prev = x[:n].mean()
    out[n - 1] = prev
    for i in range(n, len(x)):
        prev = x[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(x, n):
    out = np.full(len(x), np.nan)
    d = np.diff(x)
    g = np.maximum(d, 0)
    l_ = np.maximum(-d, 0)
    ag, al = g[:n].mean(), l_[:n].mean()

    def val(a, b):
        if a == 0 and b == 0:
            return 50.0
        if b == 0:
            return 100.0
        return 100 - 100 / (1 + a / b)

    out[n] = val(ag, al)
    for i in range(n + 1, len(x)):
        ag = (ag * (n - 1) + g[i - 1]) / n
        al = (al * (n - 1) + l_[i - 1]) / n
        out[i] = val(ag, al)
    return out


def wilder(tr, n):
    out = np.full(len(tr), np.nan)
    prev = tr[:n].mean()
    out[n - 1] = prev
    for i in range(n, len(tr)):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


def load_pair(path):
    frames = [pd.read_csv(f) for f in sorted(glob.glob(os.path.join(path, "*.csv")))]
    df = pd.concat(frames, ignore_index=True)
    dt = pd.to_datetime(df["time"], utc=True)
    df["t"] = ((dt - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta("1ms")).astype("int64")
    return df.drop_duplicates("t").sort_values("t").reset_index(drop=True)[["t", "open", "high", "low", "close"]]


def build(df, pair):
    o, h, l, c = (df[k].to_numpy(float) for k in ["open", "high", "low", "close"])
    t = df["t"].to_numpy()
    n = len(c)
    rng = h - l
    tr = np.maximum.reduce([rng, np.abs(h - np.r_[c[0], c[:-1]]), np.abs(l - np.r_[c[0], c[:-1]])])
    tr[0] = rng[0]
    atr = wilder(tr, 14)
    atr_prev = np.r_[np.nan, atr[:-1]]
    e9, e21, e50 = ema(c, 9), ema(c, 21), ema(c, 50)
    e12, e26 = ema(c, 12), ema(c, 26)
    macd_line = e12 - e26
    sig = np.full(n, np.nan)
    first = np.argmax(~np.isnan(macd_line))
    sig[first:] = ema(macd_line[first:], 9)
    hist = macd_line - sig
    sma20 = pd.Series(c).rolling(20).mean().to_numpy()
    sd20 = pd.Series(c).rolling(20).std(ddof=0).to_numpy()
    up, lo = sma20 + 2 * sd20, sma20 - 2 * sd20
    w = up - lo
    pb = np.where(w > 0, (c - lo) / np.where(w > 0, w, 1), 0.5)
    r14, r7 = rsi(c, 14), rsi(c, 7)

    # ATR percentile within the last 100 ATR values (engine: percentileRank incl. current)
    atr_pct = np.full(n, np.nan)
    win = sliding_window_view(atr, 100)
    cur = atr[99:][:, None]
    atr_pct[99:] = ((win < cur).sum(1) + 0.5 * (win == cur).sum(1)) / 100 * 100
    tr100 = pd.Series(tr).rolling(100).mean().to_numpy()

    hi20 = pd.Series(h).shift(1).rolling(20).max().to_numpy()
    lo20 = pd.Series(l).shift(1).rolling(20).min().to_numpy()
    hi20i = pd.Series(h).rolling(20).max().to_numpy()
    lo20i = pd.Series(l).rolling(20).min().to_numpy()

    body = c - o
    sdir = np.sign(body)
    run = np.zeros(n)
    for i in range(1, n):
        run[i] = run[i - 1] + sdir[i] if sdir[i] != 0 and np.sign(run[i - 1]) in (0, sdir[i]) else sdir[i]
    run = np.clip(run, -6, 6)

    # Missing minutes in the 60 minutes up to i (gap gate) and contiguity of the next candles
    step = np.diff(t, prepend=t[0] - MS) // MS - 1
    miss60 = pd.Series(np.maximum(step, 0)).rolling(60, min_periods=1).sum().to_numpy()
    nxt1 = np.r_[t[1:] == t[:-1] + MS, False]
    nxt2 = np.r_[(t[2:] == t[:-2] + 2 * MS) & (t[1:-1] == t[:-2] + MS), False, False]

    # Last COMPLETE 5-minute bucket ending at or before candle i's close
    s = pd.Series(c, index=pd.to_datetime(t, unit="ms", utc=True))
    o5 = pd.Series(o, index=s.index).resample("5min").first()
    c5 = s.resample("5min").last()
    cnt5 = s.resample("5min").count()
    ret5 = ((c5 - o5).where(cnt5 == 5))
    bucket_end = (t // (5 * MS)) * (5 * MS) + 5 * MS  # end of the bucket containing i
    complete_now = (t + MS) == bucket_end  # i is the last minute of its bucket
    last_complete_start = np.where(complete_now, bucket_end - 5 * MS, bucket_end - 10 * MS)
    r5 = ret5.reindex(pd.to_datetime(last_complete_start, unit="ms", utc=True)).to_numpy()

    a = np.where(atr > 0, atr, np.nan)
    ts = pd.to_datetime(t, unit="ms", utc=True)
    f = pd.DataFrame(
        {
            "pair": pair,
            "time": t,
            "ret1": (c - np.r_[np.nan, c[:-1]]) / a,
            "ret2": (c - np.r_[[np.nan] * 2, c[:-2]]) / a,
            "ret3": (c - np.r_[[np.nan] * 3, c[:-3]]) / a,
            "ret5": (c - np.r_[[np.nan] * 5, c[:-5]]) / a,
            "ret10": (c - np.r_[[np.nan] * 10, c[:-10]]) / a,
            "ret20": (c - np.r_[[np.nan] * 20, c[:-20]]) / a,
            "ret60": (c - np.r_[[np.nan] * 60, c[:-60]]) / a,
            "body": np.where(rng > 0, body / np.where(rng > 0, rng, 1), 0),
            "upw": np.where(rng > 0, (h - np.maximum(o, c)) / np.where(rng > 0, rng, 1), 0),
            "loww": np.where(rng > 0, (np.minimum(o, c) - l) / np.where(rng > 0, rng, 1), 0),
            "rangeAtr": rng / atr_prev,
            "bodyAtr": body / a,
            "prevBody": np.r_[np.nan, (body / np.where(rng > 0, rng, np.inf))[:-1]],
            "run": run,
            "rsi14": r14,
            "rsi7": r7,
            "pb": pb,
            "bbwAtr": w / a,
            "macdh": hist / a,
            "macdhD": (hist - np.r_[np.nan, hist[:-1]]) / a,
            "ema9_21": (e9 - e21) / a,
            "c_ema50": (c - e50) / a,
            "ema21slope": (e21 - np.r_[[np.nan] * 3, e21[:-3]]) / a,
            "atrPct": atr_pct,
            "atrRatio": atr / tr100,
            "distHi20": (hi20 - c) / a,
            "distLo20": (c - lo20) / a,
            "pos20": np.where(hi20i > lo20i, (c - lo20i) / np.where(hi20i > lo20i, hi20i - lo20i, 1), 0.5),
            "r5": r5 / a,
            "min5": (t // MS) % 5,
            "hourSin": np.sin(2 * np.pi * ts.hour / 24),
            "hourCos": np.cos(2 * np.pi * ts.hour / 24),
            "hour": ts.hour,
            "dow": ts.dayofweek,
            "miss60": miss60,
            "eligible": (miss60 == 0) & (np.arange(n) >= 300),
            # labels (future — never features)
            "y1": np.where(nxt1, np.sign(np.r_[c[1:] - o[1:], np.nan]), np.nan),
            "yl": np.where(nxt2, np.sign(np.r_[c[2:] - c[1:-1], np.nan, np.nan]), np.nan),
        }
    )
    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    parts = []
    for d in sorted(glob.glob(os.path.join(a.data, "*/"))):
        pair = os.path.basename(os.path.normpath(d))
        df = load_pair(d)
        f = build(df, pair)
        parts.append(f)
        print(pair, len(f), "eligible", int(f["eligible"].sum()))
    out = pd.concat(parts, ignore_index=True)
    out["pair"] = out["pair"].astype("category")
    out.to_parquet(a.out) if a.out.endswith(".parquet") else out.to_pickle(a.out)


if __name__ == "__main__":
    main()
