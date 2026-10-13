"""
Do statistical / ML models add predictive value over the rule engines?

    python3 scripts/research/ml.py --features research-out/features.pkl --v2 research-out/v2 --out research-out/ml.json

Protocol (fixed before running):
  * Chronological splits as in analyze.py. Models are FIT on TRAIN only.
  * VALIDATION is used for early stopping, probability calibration (isotonic) and
    for choosing the abstention margin θ. θ is then FROZEN.
  * TEST is scored once with the frozen model and θ. No refitting on TEST except in
    the separate walk-forward check, which refits only on data *before* each month.
  * Decision: CALL if p(up) ≥ 0.5 + θ, PUT if p(up) ≤ 0.5 − θ, otherwise NO TRADE.
  * Ties (close == open) are excluded from fitting; in evaluation they refund.
"""
import argparse
import glob
import json
import math
import os
import time

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

SPLITS = {"TRAIN": ("2018-07-01", "2019-07-01"), "VALIDATION": ("2019-07-01", "2020-01-01"), "TEST": ("2020-01-01", "2021-01-01")}
PAYOUT = 0.85
BE = 1 / (1 + PAYOUT)
GROUPS = {
    "momentum": ["ret1", "ret2", "ret3", "ret5", "ret10", "ret20", "ret60", "run"],
    "candle": ["body", "upw", "loww", "rangeAtr", "bodyAtr", "prevBody"],
    "oscillators": ["rsi14", "rsi7", "pb", "macdh", "macdhD"],
    "trend": ["ema9_21", "c_ema50", "ema21slope"],
    "volatility": ["atrPct", "atrRatio", "bbwAtr"],
    "range": ["distHi20", "distLo20", "pos20"],
    "mtf": ["r5"],
    "time": ["hourSin", "hourCos", "dow", "min5"],
}
FEATURES = [f for g in GROUPS.values() for f in g]
THETAS = [0.0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15, 0.2, 0.25, 0.3]
LGB_PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=63, min_child_samples=500, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=2, seed=7)


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((c - m) / d, 4), round((c + m) / d, 4)]


def evaluate(direction, y, extra=None):
    """direction: +1/-1/0 per opportunity; y: sign of trade candle (NaN = no candle)."""
    direction = np.asarray(direction)
    y = np.asarray(y, float)
    opp = len(direction)
    taken = direction != 0
    res = taken & ~np.isnan(y)
    d, r = direction[res], y[res]
    win = d * r > 0
    loss = d * r < 0
    tie = r == 0
    w, l, t = int(win.sum()), int(loss.sum()), int(tie.sum())
    pnl = np.where(win, PAYOUT, np.where(loss, -1.0, 0.0))
    eq = np.cumsum(pnl)
    dd = float((np.maximum.accumulate(np.r_[0, eq])[1:] - eq).max()) if len(eq) else 0.0
    streak = mx = 0
    for x in loss[~tie]:
        streak = streak + 1 if x else 0
        mx = max(mx, streak)
    out = {
        "opportunities": opp,
        "signals": int(taken.sum()),
        "calls": int((direction == 1).sum()),
        "puts": int((direction == -1).sum()),
        "coverage": round(float(taken.mean()), 5) if opp else None,
        "rejected": int(opp - taken.sum()),
        "wins": w,
        "losses": l,
        "ties": t,
        "unresolved": int((taken & np.isnan(y)).sum()),
        "winRate": round(w / (w + l), 4) if w + l else None,
        "ci95": wilson(w, w + l),
        "netUnits": round(float(pnl.sum()), 2),
        "perTrade": round(float(pnl.sum()) / (w + l), 4) if w + l else None,
        "maxDrawdown": round(dd, 2),
        "longestLosingStreak": int(mx),
    }
    if extra:
        out.update(extra)
    return out


def decide(p, theta):
    return np.where(p >= 0.5 + theta, 1, np.where(p <= 0.5 - theta, -1, 0))


def split_of(t):
    ts = pd.to_datetime(t, unit="ms", utc=True)
    s = np.full(len(t), None, dtype=object)
    for name, (a, b) in SPLITS.items():
        s[(ts >= pd.Timestamp(a, tz="UTC")) & (ts < pd.Timestamp(b, tz="UTC"))] = name
    return s


def choose_theta(p_val, y_val, min_trades=1000):
    """Largest lower-95 % bound of win rate on VALIDATION with ≥ min_trades decided trades."""
    table = []
    for th in THETAS:
        e = evaluate(decide(p_val, th), y_val)
        n = e["wins"] + e["losses"]
        table.append({"theta": th, "coverage": e["coverage"], "n": n, "winRate": e["winRate"], "ci95": e["ci95"]})
    ok = [r for r in table if r["n"] >= min_trades and r["ci95"][0] is not None]
    best = max(ok, key=lambda r: r["ci95"][0])
    return best["theta"], table


def reliability(p, y, bins=10):
    m = ~np.isnan(y) & (y != 0)
    p, up = p[m], (y[m] > 0).astype(float)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    out = []
    for b in range(bins):
        s = idx == b
        if s.sum():
            out.append({"meanPredicted": round(float(p[s].mean()), 4), "observedUp": round(float(up[s].mean()), 4), "n": int(s.sum())})
    return out


def fit_lgb(X, y, Xv=None, yv=None, rounds=None, cat=("pair",)):
    dtr = lgb.Dataset(X, y, categorical_feature=list(cat), free_raw_data=False)
    if rounds is None:
        dv = lgb.Dataset(Xv, yv, reference=dtr, categorical_feature=list(cat))
        m = lgb.train(LGB_PARAMS, dtr, num_boost_round=1500, valid_sets=[dv], callbacks=[lgb.early_stopping(50, verbose=False)])
    else:
        m = lgb.train(LGB_PARAMS, dtr, num_boost_round=rounds)
    return m


def export_model(gbm, best_iter, iso, info, df, path):
    """Flatten the trees to arrays so a ~60-line TypeScript evaluator can run them."""
    dump = gbm.dump_model(num_iteration=best_iter)
    names = dump["feature_names"]
    pairs = list(df["pair"].cat.categories)
    trees = []
    for t in dump["tree_info"][:best_iter]:
        nodes = []  # [feature, threshold | category list, defaultLeft, left, right] ; leaves as ["L", value]

        def walk(n):
            idx = len(nodes)
            if "leaf_value" in n:
                nodes.append(["L", n["leaf_value"]])
                return idx
            nodes.append(None)
            l_ = walk(n["left_child"])
            r_ = walk(n["right_child"])
            thr = n["threshold"]
            if n["decision_type"] == "==":
                thr = [int(x) for x in str(thr).split("||")]
            elif n["decision_type"] != "<=":
                raise ValueError(n["decision_type"])
            nodes[idx] = [n["split_feature"], thr, 1 if n["default_left"] else 0, l_, r_, n.get("missing_type", "None")]
            return idx

        walk(t["tree_structure"])
        trees.append(nodes)
    model = {
        "version": "v3-ml-shadow",
        "trainedOn": "OANDA 1m mid candles 2018-07-01..2019-06-30 (TRAIN); early stopping + isotonic calibration + θ on 2019-07..2019-12 (VALIDATION)",
        "testResult": {k: info["TEST"][k] for k in ["winRate", "ci95", "wins", "losses", "coverage"]},
        "features": names,
        "pairs": pairs,
        "theta": info["thetaFrozen"],
        "isotonic": {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]},
        "trees": trees,
    }
    with open(path, "w") as f:
        json.dump(model, f, separators=(",", ":"))
    gbm.save_model(path.rsplit(".", 1)[0] + ".lgb.txt", num_iteration=best_iter)  # for the parity fixture
    print("exported", path, len(trees), "trees")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", required=True)
    ap.add_argument("--v2", required=True, help="ledger dir of the V2 engine run (for the same-rows comparison)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--skip-ablation", action="store_true")
    ap.add_argument("--export", help="write the frozen LightGBM + calibration + θ as JSON for the app")
    a = ap.parse_args()
    t0 = time.time()
    df = pd.read_pickle(a.features)
    df = df[df["eligible"]].copy()
    df["split"] = split_of(df["time"].to_numpy())
    df = df[df["split"].notna()].dropna(subset=FEATURES).reset_index(drop=True)

    # Existing engine on the same rows
    v2 = pd.concat([pd.read_csv(f, usecols=["time", "d_V2"]).assign(pair=os.path.basename(f)[7:-4]) for f in glob.glob(os.path.join(a.v2, "ledger-*.csv"))])
    df = df.merge(v2, on=["pair", "time"], how="left")
    df["d_V2"] = df["d_V2"].fillna(0)
    df["pair"] = df["pair"].astype("category")

    parts = {s: df[df["split"] == s] for s in SPLITS}
    fitmask = lambda d: d["y1"].notna() & (d["y1"] != 0)  # noqa: E731
    out = {"rows": {s: len(v) for s, v in parts.items()}, "features": FEATURES, "protocol": __doc__.strip(), "breakEven": round(BE, 4)}
    print({s: len(v) for s, v in parts.items()}, f"{time.time()-t0:.0f}s")

    tr, va, te = parts["TRAIN"], parts["VALIDATION"], parts["TEST"]
    trf, vaf = tr[fitmask(tr)], va[fitmask(va)]
    ytr, yva = (trf["y1"] > 0).astype(int), (vaf["y1"] > 0).astype(int)

    # ---- Logistic regression baseline -------------------------------------------------
    def lr_matrix(d):
        X = d[FEATURES].to_numpy(float)
        P = pd.get_dummies(d["pair"], dtype=float).to_numpy()
        return np.hstack([X, P])

    sc = StandardScaler().fit(lr_matrix(trf))
    lr = LogisticRegression(C=1.0, max_iter=300).fit(sc.transform(lr_matrix(trf)), ytr)
    p_lr = {s: lr.predict_proba(sc.transform(lr_matrix(parts[s])))[:, 1] for s in SPLITS}
    print("LR done", f"{time.time()-t0:.0f}s")

    # ---- LightGBM ------------------------------------------------------------------------
    cols = FEATURES + ["pair"]
    gbm = fit_lgb(trf[cols], ytr, vaf[cols], yva)
    best_iter = gbm.best_iteration
    p_gb = {s: gbm.predict(parts[s][cols], num_iteration=best_iter) for s in SPLITS}
    print("LGB done, best_iter", best_iter, f"{time.time()-t0:.0f}s")

    # ---- Isotonic calibration fitted on VALIDATION ------------------------------------
    models = {}
    isos = {}
    for name, p in [("logistic", p_lr), ("lightgbm", p_gb)]:
        mv = fitmask(va).to_numpy()
        iso = IsotonicRegression(out_of_bounds="clip").fit(p["VALIDATION"][mv], (va["y1"].to_numpy()[mv] > 0).astype(int))
        pc = {s: iso.predict(p[s]) for s in SPLITS}
        isos[name] = iso
        info = {}
        for s in ["VALIDATION", "TEST"]:
            y = parts[s]["y1"].to_numpy()
            m = ~np.isnan(y) & (y != 0)
            yy = (y[m] > 0).astype(int)
            info[s] = {"auc": round(roc_auc_score(yy, p[s][m]), 4), "logloss": round(log_loss(yy, np.clip(p[s][m], 1e-6, 1 - 1e-6)), 5), "brier": round(float(np.mean((p[s][m] - yy) ** 2)), 5), "baseLogloss": round(log_loss(yy, np.full(len(yy), yy.mean())), 5)}
        theta, table = choose_theta(pc["VALIDATION"], va["y1"].to_numpy())
        models[name] = {
            "scores": info,
            "thetaTable_VALIDATION": table,
            "thetaFrozen": theta,
            "VALIDATION": evaluate(decide(pc["VALIDATION"], theta), va["y1"]),
            "TEST": evaluate(decide(pc["TEST"], theta), te["y1"]),
            "TEST_lateEntry": evaluate(decide(pc["TEST"], theta), te["yl"]),
            "TEST_fullCoverage": evaluate(decide(pc["TEST"], 0.0), te["y1"]),
            "reliability_TEST_calibrated": reliability(pc["TEST"], te["y1"].to_numpy()),
            "maxCalibratedProbability_TEST": round(float(np.max(np.abs(pc["TEST"] - 0.5)) + 0.5), 4),
        }
        d = decide(pc["TEST"], theta)
        tt = te.assign(dirn=d)
        tt["session"] = pd.cut(tt["hour"], [0, 7, 12, 16, 21, 24], right=False, labels=["Asia", "London", "London/NY", "NewYork", "Late"])
        tt["volRegime"] = pd.cut(tt["atrPct"], [0, 20, 50, 80, 95, 101], right=False, labels=["<20", "20-50", "50-80", "80-95", "95+"])
        tt["month"] = pd.to_datetime(tt["time"], unit="ms", utc=True).dt.strftime("%Y-%m")
        for key in ["pair", "session", "volRegime", "month"]:
            models[name][f"TEST_by_{key}"] = {str(k): evaluate(g["dirn"].to_numpy(), g["y1"]) for k, g in tt.groupby(key, observed=True)}
        models[name]["_pc"] = pc
        print(name, info["TEST"], "θ", theta, models[name]["TEST"]["winRate"], models[name]["TEST"]["ci95"], "n", models[name]["TEST"]["wins"] + models[name]["TEST"]["losses"], "cov", models[name]["TEST"]["coverage"])

    # ---- The 90 % question: is there ANY margin with ≥90 % on VALIDATION? -----------------
    hunt = []
    for name in models:
        pv = models[name]["_pc"]["VALIDATION"]
        for th in np.linspace(0, 0.45, 91):
            e = evaluate(decide(pv, th), va["y1"])
            if e["wins"] + e["losses"] >= 30:
                hunt.append({"model": name, "theta": round(float(th), 3), "n": e["wins"] + e["losses"], "winRate": e["winRate"]})
    out["highestValidationWinRateWith30Trades"] = sorted(hunt, key=lambda r: -r["winRate"])[:5]

    # ---- Same rows: rule engine v2 ------------------------------------------------------------
    out["v2_sameRows"] = {s: evaluate(parts[s]["d_V2"].to_numpy(), parts[s]["y1"]) for s in ["VALIDATION", "TEST"]}
    out["v2_sameRows"]["TEST_lateEntry"] = evaluate(te["d_V2"].to_numpy(), te["yl"])

    # ---- Combination: v2 signal only when the calibrated GBM agrees -------------------------
    pc = models["lightgbm"]["_pc"]
    for s in ["VALIDATION", "TEST"]:
        agree = (parts[s]["d_V2"].to_numpy() != 0) & (np.sign(pc[s] - 0.5) == parts[s]["d_V2"].to_numpy())
        out.setdefault("v2_and_gbm_agree", {})[s] = evaluate(np.where(agree, parts[s]["d_V2"].to_numpy(), 0), parts[s]["y1"])

    # ---- Walk-forward: refit before each TEST month, frozen θ and rounds ---------------------
    wf = {}
    allf = df[fitmask(df)]
    te_month = pd.to_datetime(te["time"], unit="ms", utc=True).dt.strftime("%Y-%m")
    dirs = np.zeros(len(te), int)
    for mth in sorted(te_month.unique()):
        start = pd.Timestamp(mth + "-01", tz="UTC").value // 10**6
        train_wf = allf[allf["time"] < start - 2 * 60_000]
        m = fit_lgb(train_wf[cols], (train_wf["y1"] > 0).astype(int), rounds=best_iter)
        # calibrate on the most recent 6 months before the month (also strictly in the past)
        recent = train_wf[train_wf["time"] >= start - 183 * 86_400_000]
        iso = IsotonicRegression(out_of_bounds="clip").fit(m.predict(recent[cols]), (recent["y1"] > 0).astype(int))
        sel = (te_month == mth).to_numpy()
        p = iso.predict(m.predict(te[cols][sel]))
        dirs[sel] = decide(p, models["lightgbm"]["thetaFrozen"])
        wf[mth] = evaluate(dirs[sel], te["y1"][sel])
        print("walk-forward", mth, wf[mth]["winRate"], wf[mth]["wins"] + wf[mth]["losses"], f"{time.time()-t0:.0f}s")
    out["walkForward_lightgbm"] = {"byMonth": wf, "TEST": evaluate(dirs, te["y1"])}

    # ---- Feature importance and ablation (drop one group, refit, VALIDATION scores) ---------
    imp = dict(zip(gbm.feature_name(), gbm.feature_importance("gain")))
    tot = sum(imp.values())
    out["importanceGain"] = {k: round(v / tot, 4) for k, v in sorted(imp.items(), key=lambda x: -x[1])}
    if not a.skip_ablation:
        abl = {}
        sub = trf.sample(frac=0.5, random_state=1)
        ysub = (sub["y1"] > 0).astype(int)
        mv = fitmask(va).to_numpy()
        yv = (va["y1"].to_numpy()[mv] > 0).astype(int)

        def score(cs):
            m = fit_lgb(sub[cs], ysub, rounds=best_iter, cat=[c for c in ["pair"] if c in cs])
            p = m.predict(va[cs])
            return {"auc": round(roc_auc_score(yv, p[mv]), 4), "logloss": round(log_loss(yv, np.clip(p[mv], 1e-6, 1 - 1e-6)), 5)}

        abl["ALL"] = score(cols)
        for g, fs in GROUPS.items():
            abl[f"-{g}"] = score([c for c in cols if c not in fs])
            print("ablation", g, abl[f"-{g}"], f"{time.time()-t0:.0f}s")
        abl["-pair"] = score(FEATURES)
        out["ablation_VALIDATION"] = abl

    if a.export:
        export_model(gbm, best_iter, isos["lightgbm"], models["lightgbm"], df, a.export)

    for name in models:
        models[name].pop("_pc")
    out["models"] = models
    out["seconds"] = round(time.time() - t0)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, default=str)


if __name__ == "__main__":
    main()
