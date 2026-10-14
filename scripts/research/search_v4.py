"""
Pre-registered search for a new strategy (v4) on recent tick-built candles.

    python3 scripts/research/search_v4.py --data data-dukascopy --out src/lib/research/strategy-search.json

Everything below — splits, rule families, grids, selection rule, payout, minimum
sample sizes — was fixed BEFORE looking at any result (2026-10-14). Do not edit
these choices after seeing the output; that would turn TEST into training data.

Data: Dukascopy 1-minute mid candles (fetch-dukascopy.ts), 6 pairs.
Splits (chronological):
    TRAIN       start      → 2025-09-30   rank rules
    VALIDATION  2025-10-01 → 2026-03-31   choose one rule among the TRAIN top 20
    TEST        2026-04-01 → end          scored once for the chosen rule
Decision time: 1 s after the signal candle closes; only closed candles are used.
Eligible minute: weekday market hours (not Fri 21:00 – Sun 22:00 UTC), not
21:00–23:59 UTC (rollover, wide spreads), and no missing minute in the last 60.
Outcome, expiry E in {1, 2} minutes:
    on time : entry = open of candle i+1, expiry = close of candle i+E
    late    : entry = close of candle i+1, expiry = close of candle i+1+E (a full minute late)
    ties (exit == entry) refund and are excluded from win rates.
Payout 90 % -> break-even 1 / 1.9 = 52.63 %.
Selection:
    1. TRAIN: keep configs with >= 500 decided trades; rank by the lower 95 % Wilson bound.
    2. VALIDATION: among the TRAIN top 20 with >= 150 decided trades, choose the highest lower bound.
       A config "passes" only if that lower bound is above break-even.
    3. TEST: score the chosen config once. It "holds" only if its TEST lower bound is above break-even.
Caveat fixed in advance: signals on different pairs in the same minute are correlated
(USD moves), so intervals are somewhat too narrow; the TEST verdict uses them as-is.
"""
import argparse
import itertools
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

PAYOUT = 0.90
BREAK_EVEN = 1 / (1 + PAYOUT)
TRAIN_END = pd.Timestamp("2025-10-01", tz="UTC")
VAL_END = pd.Timestamp("2026-04-01", tz="UTC")
SESSIONS = {"all": (0, 21), "asia": (0, 7), "london": (7, 12), "overlap": (12, 16), "newyork": (16, 21)}
MIN_TRAIN = 500
MIN_VAL = 150
TOP_K = 20


def wilson(w, n, z=1.96):
    if n == 0:
        return (None, None)
    p = w / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def rsi(close, n):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def load_pair(path: Path, code: int):
    df = pd.read_csv(path)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.sort_values("time").drop_duplicates("time").reset_index(drop=True)
    o, h, l, c = (df[k].astype(float) for k in ("open", "high", "low", "close"))
    t = df["time"]
    # Unit-independent minute index (pandas may store datetimes in ns, us or ms).
    mins = ((t - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(minutes=1)).to_numpy().astype(np.int64)

    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 14, adjust=False).mean()
    mid = c.rolling(20).mean()
    sd = c.rolling(20).std(ddof=0)
    pb = (c - (mid - 2 * sd)) / (4 * sd)
    body = c - o
    rng = h - l
    direction = np.sign(body).astype(int)
    # signed streak of same-direction candles ending at i
    streak = np.zeros(len(df), dtype=int)
    dv = direction.to_numpy()
    for i in range(len(dv)):
        if dv[i] == 0:
            streak[i] = 0
        elif i > 0 and dv[i - 1] == dv[i] and mins[i] - mins[i - 1] == 1:
            streak[i] = streak[i - 1] + dv[i]
        else:
            streak[i] = dv[i]
    upper_wick = h - np.maximum(o, c)
    lower_wick = np.minimum(o, c) - l

    hour = t.dt.hour.to_numpy()
    dow = t.dt.dayofweek.to_numpy()  # Monday = 0
    weekend = (dow == 5) | ((dow == 4) & (hour >= 21)) | ((dow == 6) & (hour < 22))
    complete60 = np.zeros(len(df), dtype=bool)
    complete60[60:] = (mins[60:] - mins[:-60]) == 60
    eligible = complete60 & ~weekend & (hour < 21) & (atr.to_numpy() > 0) & np.isfinite(pb.to_numpy())

    def contiguous(k):
        ok = np.zeros(len(df), dtype=bool)
        ok[: len(df) - k] = (mins[k:] - mins[: len(df) - k]) == k
        return ok

    out = {
        "pair": np.full(len(df), code, dtype=np.int8),
        "time": t.to_numpy(),
        "hour": hour,
        "eligible": eligible,
        "atr": atr.to_numpy(),
        "pb": pb.to_numpy(),
        "range_atr": (rng / atr).to_numpy(),
        "body_share": (body.abs() / rng.replace(0, np.nan)).fillna(0).to_numpy(),
        "dir": dv,
        "rsi14": rsi(c, 14).to_numpy(),
        "rsi7": rsi(c, 7).to_numpy(),
        "rsi2": rsi(c, 2).to_numpy(),
        "streak": streak,
        "uw_share": (upper_wick / rng.replace(0, np.nan)).fillna(0).to_numpy(),
        "lw_share": (lower_wick / rng.replace(0, np.nan)).fillna(0).to_numpy(),
        "ret15_atr": ((c - c.shift(15)) / atr).to_numpy(),
        "brk20": np.sign((c > h.shift(1).rolling(20).max()).astype(int) - (c < l.shift(1).rolling(20).min()).astype(int)).to_numpy(),
        "brk60": np.sign((c > h.shift(1).rolling(60).max()).astype(int) - (c < l.shift(1).rolling(60).min()).astype(int)).to_numpy(),
    }
    co, cc = o.to_numpy(), c.to_numpy()
    n = len(df)
    for E in (1, 2):
        on = np.full(n, np.nan)
        ok = contiguous(E)
        idx = np.where(ok[: n - E])[0]
        on[idx] = np.sign(cc[idx + E] - co[idx + 1])
        late = np.full(n, np.nan)
        ok2 = contiguous(E + 1)
        idx2 = np.where(ok2[: n - E - 1])[0]
        late[idx2] = np.sign(cc[idx2 + 1 + E] - cc[idx2 + 1])
        out[f"on{E}"] = on
        out[f"late{E}"] = late
    return pd.DataFrame(out)


def rule_specs():
    """Every candidate, fixed in advance. Each spec returns a direction array (+1 CALL, -1 PUT, 0 none)."""
    specs = []
    for pbt, ra, bs, rx, mode in itertools.product((1.0, 1.1, 1.2), (1.0, 1.5, 2.0, 2.5, 3.0), (0.3, 0.5, 0.7), (None, 70, 75, 80), ("fade", "momentum")):
        specs.append({"family": "band_extreme", "pb": pbt, "range_atr": ra, "body": bs, "rsi": rx, "mode": mode})
    for nn, ra, mode in itertools.product((3, 4, 5, 6, 7), (0.0, 1.0), ("fade", "momentum")):
        for bs in (0.0, 0.3):
            specs.append({"family": "streak", "n": nn, "range_atr": ra, "body": bs, "mode": mode})
    for per, th, mode in itertools.product((2, 7), (0, 1, 2), ("fade", "momentum")):
        lvl = {2: (90, 95, 98), 7: (80, 85, 90)}[per][th]
        specs.append({"family": "rsi_extreme", "period": per, "level": lvl, "mode": mode})
    for ws, ra, mode in itertools.product((0.5, 0.6, 0.7), (1.0, 1.5, 2.0), ("fade", "momentum")):
        specs.append({"family": "wick", "wick": ws, "range_atr": ra, "mode": mode})
    for lb, ra, mode in itertools.product((20, 60), (0.0, 1.0, 1.5), ("fade", "momentum")):
        specs.append({"family": "breakout", "lookback": lb, "range_atr": ra, "mode": mode})
    for k, mode in itertools.product((3, 4, 5, 6), ("fade", "momentum")):
        specs.append({"family": "move15", "atr": k, "mode": mode})
    return specs


def direction_for(spec, d):
    sgn = 1 if spec["mode"] == "momentum" else -1
    f = spec["family"]
    if f == "band_extreme":
        up = (d["dir"] > 0) & (d["pb"] >= spec["pb"])
        dn = (d["dir"] < 0) & (d["pb"] <= 1 - spec["pb"])
        common = (d["range_atr"] >= spec["range_atr"]) & (d["body_share"] >= spec["body"])
        if spec["rsi"] is not None:
            up &= d["rsi14"] >= spec["rsi"]
            dn &= d["rsi14"] <= 100 - spec["rsi"]
        raw = np.where(up & common, 1, np.where(dn & common, -1, 0))
    elif f == "streak":
        ok = (np.abs(d["streak"]) >= spec["n"]) & (d["range_atr"] >= spec["range_atr"]) & (d["body_share"] >= spec["body"])
        raw = np.where(ok, np.sign(d["streak"]), 0)
    elif f == "rsi_extreme":
        r = d[f"rsi{spec['period']}"]
        raw = np.where(r >= spec["level"], 1, np.where(r <= 100 - spec["level"], -1, 0))
    elif f == "wick":
        # long lower wick = buyers rejected the low (bullish rejection) -> raw +1
        big = d["range_atr"] >= spec["range_atr"]
        raw = np.where(big & (d["lw_share"] >= spec["wick"]), 1, np.where(big & (d["uw_share"] >= spec["wick"]), -1, 0))
        # here "momentum" means trading WITH the rejection, "fade" against it
    elif f == "breakout":
        b = d[f"brk{spec['lookback']}"]
        raw = np.where((b != 0) & (d["range_atr"] >= spec["range_atr"]), b, 0)
    elif f == "move15":
        m = d["ret15_atr"]
        raw = np.where(m >= spec["atr"], 1, np.where(m <= -spec["atr"], -1, 0))
    else:
        raise ValueError(f)
    return (raw * sgn).astype(np.int8)


def score(dirs, outcome, mask):
    x = dirs[mask] * outcome[mask]
    w = int(np.sum(x > 0))
    lo = int(np.sum(x < 0))
    n = w + lo
    ci = wilson(w, n)
    return {"n": n, "wins": w, "winRate": (w / n) if n else None, "ci95": ci, "net": round(w * PAYOUT - lo, 2)}


def label(spec, session, E):
    return {**spec, "session": session, "expiry": E}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    frames = []
    pairs = sorted(p.name for p in Path(a.data).iterdir() if p.is_dir())
    for code, pair in enumerate(pairs):
        csv = next(Path(a.data, pair).glob("*.csv"))
        frames.append(load_pair(csv, code))
        print(pair, len(frames[-1]), flush=True)
    d = pd.concat(frames, ignore_index=True)
    d = d[d["eligible"]].reset_index(drop=True)
    if len(d) < 10_000:
        raise SystemExit(f"only {len(d)} eligible minutes — data or eligibility bug, refusing to report")
    t = pd.to_datetime(d["time"], utc=True)
    split = np.where(t < TRAIN_END, 0, np.where(t < VAL_END, 1, 2))
    cols = {k: d[k].to_numpy() for k in d.columns if k != "time"}
    hour = cols["hour"]
    sess_mask = {s: (hour >= a_) & (hour < b_) for s, (a_, b_) in SESSIONS.items()}

    specs = rule_specs()
    finite = {E: np.isfinite(cols[f"on{E}"]) for E in (1, 2)}

    def build(spec_idx, s, E):
        dirs = direction_for(specs[spec_idx], cols)
        return dirs, (dirs != 0) & sess_mask[s] & finite[E]

    results = []  # (spec_idx, session, E, train score) — arrays are rebuilt on demand to save memory
    train = split == 0
    for k, spec in enumerate(specs):
        dirs = direction_for(spec, cols)
        has = dirs != 0
        for s, sm in sess_mask.items():
            for E in (1, 2):
                tr = score(dirs, cols[f"on{E}"], has & sm & finite[E] & train)
                results.append((k, s, E, tr))
    n_configs = len(results)
    print("configs", n_configs, flush=True)

    ranked = [r for r in results if r[3]["n"] >= MIN_TRAIN]
    ranked.sort(key=lambda r: r[3]["ci95"][0], reverse=True)
    rows = []
    for k, s, E, tr in ranked[:TOP_K]:
        dirs, valid = build(k, s, E)
        va = score(dirs, cols[f"on{E}"], valid & (split == 1))
        rows.append((label(specs[k], s, E), tr, va, dirs, valid))
    candidates = [r for r in rows if r[2]["n"] >= MIN_VAL]
    candidates.sort(key=lambda r: r[2]["ci95"][0] if r[2]["ci95"][0] is not None else -1, reverse=True)

    def pack(s):
        return {"n": s["n"], "winRate": None if s["winRate"] is None else round(s["winRate"], 4), "ci95": [None if x is None else round(x, 4) for x in s["ci95"]], "net": s["net"]}

    out = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "data": "Dukascopy 1-minute mid candles, " + ", ".join(p.replace("_", "/") for p in pairs),
        "period": {"from": str(t.min()), "to": str(t.max()), "trainEnd": str(TRAIN_END.date()), "validationEnd": str(VAL_END.date())},
        "payout": PAYOUT,
        "breakEven": round(BREAK_EVEN, 4),
        "configsTried": n_configs,
        "eligibleMinutes": {"train": int((split == 0).sum()), "validation": int((split == 1).sum()), "test": int((split == 2).sum())},
        "trainTop": [{"config": c, "train": pack(tr), "validation": pack(va)} for c, tr, va, _, _ in rows],
    }

    def full_report(cfg, dirs, valid):
        E = cfg["expiry"]
        rep = {}
        for nm, sp in (("train", 0), ("validation", 1), ("test", 2)):
            rep[nm] = pack(score(dirs, cols[f"on{E}"], valid & (split == sp)))
            late_valid = valid & np.isfinite(cols[f"late{E}"])
            rep[nm + "Late"] = pack(score(dirs, cols[f"late{E}"], late_valid & (split == sp)))
        test_mask = valid & (split == 2)
        rep["testByPair"] = {pairs[k].replace("_", "/"): pack(score(dirs, cols[f"on{E}"], test_mask & (cols["pair"] == k))) for k in range(len(pairs))}
        months = pd.to_datetime(d["time"], utc=True).dt.strftime("%Y-%m").to_numpy()
        rep["testByMonth"] = {m: pack(score(dirs, cols[f"on{E}"], test_mask & (months == m))) for m in sorted(set(months[test_mask]))}
        days = max(1, len(set(pd.to_datetime(d["time"][test_mask], utc=True).dt.date)))
        rep["testSignalsPerPairPerDay"] = round(int(test_mask.sum()) / days / len(pairs), 2)
        return rep

    if candidates:
        cfg, tr, va, dirs, valid = candidates[0]
        passed_val = va["ci95"][0] is not None and va["ci95"][0] > BREAK_EVEN
        rep = full_report(cfg, dirs, valid)
        held = rep["test"]["ci95"][0] is not None and rep["test"]["ci95"][0] > BREAK_EVEN
        out["chosen"] = {"config": cfg, "passedValidation": passed_val, "heldOnTest": held, **rep}
    else:
        out["chosen"] = None

    # v2 (shipped rule) on the same data for reference: band_extreme fade, pb 1.0, range 2 ATR, body 0.5, RSI 70, 1-minute.
    v2 = {"family": "band_extreme", "pb": 1.0, "range_atr": 2.0, "body": 0.5, "rsi": 70, "mode": "fade"}
    v2dirs = direction_for(v2, cols)
    v2valid = (v2dirs != 0) & sess_mask["all"] & np.isfinite(cols["on1"])
    out["v2Reference"] = {"config": label(v2, "all", 1), **full_report(label(v2, "all", 1), v2dirs, v2valid)}

    if out["chosen"] is None or not out["chosen"]["passedValidation"]:
        out["verdict"] = {"code": "NONE", "text": "Koi tareeqa validation par break-even se pakke taur par upar nahin gaya. Nayi strategy nahin mili."}
    elif not out["chosen"]["heldOnTest"]:
        out["verdict"] = {"code": "FAILED_TEST", "text": "Chuna hua tareeqa validation paas kar gaya lekin aakhri TEST par break-even se pakke taur par upar nahin raha. Is par paisa na lagayein."}
    else:
        out["verdict"] = {"code": "HELD", "text": "Chuna hua tareeqa aakhri TEST par bhi break-even se upar raha. Agla qadam: app mein shadow mode, phir demo account."}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, indent=1, default=str) + "\n")
    print(json.dumps(out["verdict"]), flush=True)


if __name__ == "__main__":
    main()
