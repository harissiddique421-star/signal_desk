"""
Loss analysis and strategy comparison on the ledgers written by ledger.ts.

    python3 scripts/research/analyze.py --ledgers research-out/baseline --out research-out/baseline-report.json

Splits are chronological and fixed in advance (see SPLITS). Nothing here tunes on
the TEST split: candidate filters are ranked on TRAIN, chosen on VALIDATION, and
TEST is only reported.

Outcome conventions (same as the app): WIN/LOSS/TIE from the sign of the trade
candle; ties refund the stake and are excluded from the win rate; payout is a
fraction (0.85 = +85 % on a win, -100 % on a loss).
"""
import argparse
import glob
import json
import math
import os

import numpy as np
import pandas as pd

SPLITS = {
    "TRAIN": ("2018-07-01", "2019-07-01"),
    "VALIDATION": ("2019-07-01", "2020-01-01"),
    "TEST": ("2020-01-01", "2021-01-01"),
}
SESSIONS = [(0, 7, "Asia 00-07"), (7, 12, "London 07-12"), (12, 16, "London/NY 12-16"), (16, 21, "New York 16-21"), (21, 24, "Late 21-24")]
PAYOUT = 0.85


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((c - m) / d, 4), round((c + m) / d, 4)]


def load(ledger_dir):
    frames = []
    for f in sorted(glob.glob(os.path.join(ledger_dir, "ledger-*.csv"))):
        pair = os.path.basename(f)[7:-4]
        df = pd.read_csv(f, keep_default_na=True, dtype={"patterns": str, "breakouts": str})
        df["pair"] = pair
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    ts = pd.to_datetime(df["time"], unit="ms", utc=True)
    df["ts"] = ts
    df["hour"] = ts.dt.hour
    df["dow"] = ts.dt.dayofweek
    df["session"] = pd.cut(df["hour"], [s[0] for s in SESSIONS] + [24], right=False, labels=[s[2] for s in SESSIONS])
    df["split"] = None
    for name, (a, b) in SPLITS.items():
        df.loc[(ts >= pd.Timestamp(a, tz="UTC")) & (ts < pd.Timestamp(b, tz="UTC")), "split"] = name
    for c in ["patterns", "breakouts"]:
        df[c] = df[c].fillna("")
    return df


def summarize(direction, result):
    """direction: +1/-1 per trade; result: sign of the trade candle (+1/-1/0, NaN = no candle)."""
    mask = (direction != 0) & result.notna()
    d = direction[mask].to_numpy()
    r = result[mask].to_numpy()
    win = (d * r) > 0
    loss = (d * r) < 0
    tie = r == 0
    w, l, t = int(win.sum()), int(loss.sum()), int(tie.sum())
    unresolved = int(((direction != 0) & result.isna()).sum())
    pnl = np.where(win, PAYOUT, np.where(loss, -1.0, 0.0))
    eq = np.cumsum(pnl)
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:] if len(eq) else eq
    dd = float((peak - eq).max()) if len(eq) else 0.0
    streak = mx = 0
    for x in loss[~tie] if len(loss) else []:
        streak = streak + 1 if x else 0
        mx = max(mx, streak)
    n = w + l
    return {
        "trades": int(mask.sum()),
        "wins": w,
        "losses": l,
        "ties": t,
        "unresolved": unresolved,
        "winRate": round(w / n, 4) if n else None,
        "ci95": wilson(w, n),
        "netUnits": round(float(pnl.sum()), 2),
        "perTrade": round(float(pnl.sum()) / n, 4) if n else None,
        "maxDrawdown": round(dd, 2),
        "longestLosingStreak": int(mx),
    }


def by(df, direction, result, key):
    out = {}
    for k, g in df.groupby(key, observed=True):
        s = summarize(direction.loc[g.index], result.loc[g.index])
        if s["trades"]:
            out[str(k)] = s
    return out


def per_split(df, direction, result):
    return {name: summarize(direction[df["split"] == name], result[df["split"] == name]) for name in SPLITS}


def two_prop_z(k1, n1, k2, n2):
    if min(n1, n2) == 0:
        return None
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return round(((k1 / n1) - (k2 / n2)) / se, 2) if se else None


def loss_drivers(df, direction, result, factors):
    """Win rate inside each level of each factor vs. the rest; |z| > 3.3 ≈ Bonferroni-safe at ~50 tests."""
    mask = (direction != 0) & result.notna() & (result != 0)
    mask = mask.loc[df.index]
    d = df[mask]
    win = (direction[mask] * result[mask]) > 0
    total_w, total_n = int(win.sum()), int(mask.sum())
    rows = []
    for f in factors:
        for k, g in d.groupby(f, observed=True):
            n = len(g)
            if n < 30:
                continue
            w = int(win.loc[g.index].sum())
            z = two_prop_z(w, n, total_w - w, total_n - n)
            rows.append({"factor": f, "level": str(k), "n": n, "winRate": round(w / n, 4), "ci95": wilson(w, n), "zVsRest": z, "significant": z is not None and abs(z) > 3.3})
    return {"overall": {"n": total_n, "winRate": round(total_w / total_n, 4) if total_n else None}, "rows": rows}


def add_buckets(df):
    df["agreeBucket"] = pd.cut(df["agree"].abs(), [0, 0.15, 0.3, 0.45, 0.6, 0.75, 1.01], right=False)
    df["atrBucket"] = pd.cut(df["atrPct"], [0, 20, 40, 60, 80, 95, 101], right=False)
    df["rsiBucket"] = pd.cut(df["rsi"], [0, 30, 40, 50, 60, 70, 101], right=False)
    df["rangeBucket"] = pd.cut(df["rangeAtr"], [0, 0.5, 1, 1.5, 2, 2.5, 100], right=False)
    df["oppBucket"] = pd.cut(df["oppAtr"], [-100, 0.5, 1, 2, 4, 1000], right=False)
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledgers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pickle", help="also save the merged ledger (input for search_fade.py)")
    a = ap.parse_args()
    df = add_buckets(load(a.ledgers))
    if a.pickle:
        df.to_pickle(a.pickle)
    modes = [c[2:] for c in df.columns if c.startswith("d_")]
    report = {"rows": len(df), "pairs": sorted(df["pair"].unique().tolist()), "splits": SPLITS, "payout": PAYOUT, "breakEven": round(1 / (1 + PAYOUT), 4)}

    # Data quality: how often each data gate blocks
    first = modes[0]
    fails = df[f"fail_{first}"].fillna("")
    report["dataGates"] = {g: int(fails.str.contains(g, regex=False).sum()) for g in ["data.gaps", "data.freshness", "data.count", "data.ohlc", "data.timestamps", "data.warmup"]}

    # Naive baselines: are 1-minute directions predictable at all?
    last = df["lastDir"].fillna(0)
    report["naive"] = {
        "continuation (repeat last candle)": per_split(df, last, df["r1"]),
        "reversal (opposite of last candle)": per_split(df, -last, df["r1"]),
        "always CALL": per_split(df, pd.Series(1, index=df.index), df["r1"]),
    }

    # Each evidence item alone, on every minute where it points somewhere
    report["evidenceAlone"] = {}
    for c in [c for c in df.columns if c.startswith("e_")]:
        report["evidenceAlone"][c[2:]] = per_split(df, df[c], df["r1"])

    # Engine modes as the app runs them
    report["modes"] = {}
    for m in modes:
        dirn = df[f"d_{m}"]
        report["modes"][m] = {
            "onTime": per_split(df, dirn, df["r1"]),
            "oneCandleLate": per_split(df, dirn, df["rl"]),
            "byPair": by(df[df["split"] != "TEST"], dirn, df["r1"], "pair"),
            "drivers_TRAIN_VAL": loss_drivers(df[df["split"] != "TEST"], dirn, df["r1"], ["pair", "session", "regime", "structure", "agreeBucket", "atrBucket", "rsiBucket", "rangeBucket", "oppBucket", "lastDir"]),
        }

    # Generate button exactly as shipped: direction = sign(agree) with 0 → CALL, target = candle after next (r2)
    gen_dir = np.where(df["agree"] >= 0, 1, -1)
    has_ev = df["nev"] > 0
    dmode = df[f"d_{'NORMAL' if 'NORMAL' in modes else first}"]
    label = np.where(dmode != 0, "Mazboot", np.where(df["agree"].abs() >= 0.3, "Darmiyana", "Kamzor"))
    g = pd.Series(np.where(has_ev, gen_dir, 0), index=df.index)
    report["generate"] = {}
    for lab in ["Mazboot", "Darmiyana", "Kamzor"]:
        sel = pd.Series(np.where(label == lab, g, 0), index=df.index)
        report["generate"][lab] = {"asShipped_targetAfterNext": per_split(df, sel, df["r2"]), "ifTargetNext": per_split(df, sel, df["r1"])}

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(report, f, indent=1, default=str)
    print(json.dumps({k: report[k] for k in ["rows", "dataGates", "breakEven"]}, indent=1))
    for m in modes:
        for split in SPLITS:
            s = report["modes"][m]["onTime"][split]
            print(m, split, "trades", s["trades"], "win", s["winRate"], s["ci95"], "net", s["netUnits"], "| late", report["modes"][m]["oneCandleLate"][split]["winRate"])
    for k, v in report["naive"].items():
        print(k, {s: v[s]["winRate"] for s in SPLITS})
    for k, v in report["evidenceAlone"].items():
        print("evidence", k, {s: (v[s]["winRate"], v[s]["trades"]) for s in SPLITS})
    for k, v in report["generate"].items():
        print("generate", k, {s: (v["asShipped_targetAfterNext"][s]["winRate"], v["asShipped_targetAfterNext"][s]["trades"]) for s in SPLITS})


if __name__ == "__main__":
    main()
