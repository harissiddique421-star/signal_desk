# Signal engine research: audit, loss analysis, v2 strategy

*Run on 2026-10-14. Every number below comes from the scripts in `scripts/research/` running the real TypeScript engine on real historical candles. Nothing was fitted on the TEST period. No trades were removed.*

## 1. Short answer

- **The original engine (v1) loses.** On 3.87 million historical 1-minute candles its signals won **48–49 %** of the time in every period, every pair and every session. The 95 % interval is *below 50 %*, so this is not bad luck: the rules point the wrong way at a 1-minute horizon.
- **Root cause: trend-following at 1 minute.** Every v1 indicator (EMA trend, slope, structure, MACD, RSI-above-50, Bollinger mid-band, 5-minute trend) predicts the next candle *worse than a coin flip* (48.6–49.7 %). Over one minute these FX prices tend to pull back, not continue. The more indicators agreed, the *worse* the result (48.1 % at agreement ≥ 0.75): the agreement score was anti-calibrated.
- **The Generate button was a coin flip.** Its forced UP/DOWN answers won 49.1 % (Mazboot), 49.2 % (Darmiyana) and 49.8 % (Kamzor) on TEST. At an 85 % payout you need 54.1 % to break even.
- **v2 (exhaustion fade)** trades *against* a large, decisive candle that closed outside the Bollinger band with RSI at an extreme. On the untouched TEST period it won **55.6 % (95 % CI 54.1–57.1 %, 4,420 trades)**, +127 stake units at 85 % payout, about 5 signals per pair per day.
- **But the edge disappears with slow entry.** Entering one candle late drops v2 to **51.5 %** (a loss). Real manual entry on Quotex (a few seconds late, broker's own price) sits between those two numbers, so **profit in real use is not demonstrated.**
- **Machine learning (second round, §9):** logistic regression and LightGBM on 33 decision-time features have almost no predictive power (AUC 0.513–0.515). Trading only their most confident 0.3 % of minutes gave **58.9 % (56.5–61.3 %, 1,620 trades)** on TEST, but monthly retraining dropped it to 55.0 %, so it is **not** a proven improvement over v2. It runs in shadow mode for live comparison only.
- **90 % is not supported either**: the best validation bucket with ≥ 30 trades was 73.8 % on 80 trades.
- **80 % is not supported by the evidence.** No rule, pair, session or regime came close. The best stable result is ~56 %.

## 2. Data

| | |
|---|---|
| Source | OANDA 1-minute **mid** candles, published in the public repo `github.com/FutureSharks/financial-data` (`pyfinancialdata/data/currencies/oanda/<PAIR>/<YEAR>/oanda-<PAIR>-<YEAR>-<MONTH>.csv`) |
| Pairs | EUR/USD, GBP/USD, USD/CAD, AUD/USD, EUR/JPY, AUD/JPY |
| Period | 2018-07-01 → 2020-05-14 |
| Candles | 3,867,635 (AUD/JPY 680,480 · EUR/JPY 666,873 · EUR/USD 647,456 · USD/CAD 645,941 · GBP/USD 637,159 · AUD/USD 589,726) |
| Checks | timestamps UTC (weekly open Sunday 21:00), 0 duplicates, 0 invalid OHLC rows; minutes without ticks are absent (~2.5 %) and were **not** filled |
| Not available | your own signal history (it lives in your browser / Supabase, which this environment cannot read); Quotex prices; **any OTC data**; news calendar |

Chronological splits, fixed before any analysis:

| Split | Period | Use |
|---|---|---|
| TRAIN | 2018-07-01 → 2019-06-30 | find and rank candidate rules |
| VALIDATION | 2019-07-01 → 2019-12-31 | check the chosen rule |
| TEST | 2020-01-01 → 2020-05-14 | reported once, never tuned on (includes the March 2020 crash) |

Outcome rule (same as the app): entry = open of the candle after the signal candle, expiry = its close. "One candle late" = entry at that close, expiry one minute later. Ties refund the stake and are excluded from win rates. Payout 85 % → break-even **54.05 %**.

## 3. Phase 1 — code audit

| # | Finding | Where | Evidence | Fix |
|---|---|---|---|---|
| A1 | Strategy direction is wrong for a 1-minute horizon | `src/lib/engine/signal.ts` (TREND_V1) | §4: every trend item < 50 % on 3.87 M minutes | New FADE_V2 strategy, default mode `V2` |
| A2 | Agreement score treated as strength, but higher agreement = lower win rate | `signal.ts` score, `SignalApp` bar | v1 STRICT, TRAIN+VAL: 48.1 % at \|agree\| ≥ 0.75 (z = −3.7) | Bar hidden in v2; docs say it is not a probability |
| A3 | Generate button always forced UP/DOWN, even when the engine said NO TRADE | `SignalApp.tsx` `generate` | §4 table | Replaced by "Abhi check karein": same rules as auto scan, never forced |
| A4 | Generate targeted the candle *after* the next one, ignoring the forming candle | `SignalApp.tsx` (`targetStart = formingStart + 60 s`) | Code | Removed with A3 |
| A5 | Default mode was NORMAL (looser, 2× the signals, same 49 %) | `signals-store.ts` | §4 | Default `V2`; saved settings migrated once |
| A6 | "Aaj ke results" mixed forced Generate answers with rule-based signals | `SignalApp.tsx` today counter, `ResultsTab` headline | Code | `todaysTally`: AUTO signals of the selected mode only; other versions listed separately |
| A7 | Tracker scores open→close of the next candle, but the user enters seconds later on Quotex's own price | `stats/resolve.ts` | v2: 55.6 % on time vs 51.5 % one candle late | Backtest now reports both; v2 entry window 15 s (scan attempts at 3, 7, 11 s); UI explains the gap |
| A8 | Never tested on real market data (sample generator only) | — | — | Research harness in `scripts/research/` |
| A9 | Backtest used 200 candles, live analysis 300 (different EMA warm-up) | `backtest/backtest.ts` | Code | Backtest window 300 |
| A10 | Indicator readings at decision time were not recorded | `types.ts` | — | `SignalResult.metrics` |

Checked and **found correct**: only closed candles are used (`closedCandlesOnly`); the 5-minute candles are built only from complete buckets; swing points need confirmation candles (no repainting); timestamps are requested and parsed as UTC; gaps, duplicates, misalignment and stale data force NO TRADE; OTC always returns NO TRADE; indicators match an independent pandas implementation (existing fixture test). Displayed direction equals the engine decision.

A note on OTC: if you trade Quotex **OTC** pairs, no signal from this app applies to them — those prices are generated by the broker and are not the market feed this app reads.

## 4. Phase 2 — loss analysis (v1)

| Version | Split | Decided trades | Win rate (95 % CI) | Net units @85 % | Max DD | Longest losing streak |
|---|---|---|---|---|---|---|
| v1 STRICT | TRAIN | 120,384 | 48.3 % (48.0–48.5) | −12,934 | 12,941 | 19 |
| v1 STRICT | VALIDATION | 43,675 | 48.8 % (48.4–49.3) | −4,220 | 4,229 | 14 |
| v1 STRICT | TEST | 57,995 | 49.1 % (48.7–49.6) | −5,274 | 5,276 | 16 |
| v1 NORMAL | TEST | 109,643 | 49.1 % (48.8–49.4) | −10,054 | 10,058 | 19 |
| Generate "Mazboot" (as shipped) | TEST | 92,943 | 49.1 % (48.7–49.4) | | | |
| Generate "Darmiyana" | TEST | 272,664 | 49.2 % (49.0–49.4) | | | |
| Generate "Kamzor" | TEST | 127,520 | 49.8 % (49.5–50.0) | | | |

Each evidence item on its own (every minute it pointed somewhere, TEST): EMA trend 49.2 %, EMA slope 49.3 %, structure 49.7 %, MACD 49.5 %, RSI-vs-50 49.3 %, Bollinger mid-band 49.3 %, 5-minute trend 49.5 %. Naive "opposite of the last candle": 50.8 % (TRAIN), 50.2 % (TEST).

Losses were **not** concentrated in one pair, session or regime: every pair (47.6–49.4 %) and every session lost. The only meaningful pattern was that the strongest setups lost most: agreement ≥ 0.75, RSI 60–70 on CALLs / 30–40 on PUTs, and up-candles followed by CALL. All point the same way: at 1 minute, chasing the move is the loss.

Data gates: the "missing candles" gate blocked 48.7 % of minutes in STRICT (OANDA omits minutes with no ticks). This removes trades, it does not cause losses.

## 5. Phase 3–6 — v2 strategy and validation

**Search (pre-registered, `scripts/research/search_fade.py`):** 864 grid points over %B threshold, minimum candle range, minimum body, RSI extreme, 5-minute filter, maximum range and rollover-hour blocking. Ranked on TRAIN by the *lower* 95 % bound (≥ 1,000 trades). The top grid point was taken as is:

> Signal candle closed **outside the Bollinger band** (20, 2) in its own direction, **range ≥ 2 × ATR(14)**, **body ≥ 50 %** of its range, **RSI(14) ≥ 70** (up-candle) or **≤ 30** (down-candle), hour not 21–23 UTC → trade the **opposite** direction for the next 1-minute candle.

The 5-minute trend filter, the shock-candle cap and the old trend rules did not help on TRAIN and are not used by v2 (they are still computed and shown).

Results of the shipped TypeScript engine (`compare.py`):

| v2 FADE | Decided | Win rate (95 % CI) | Net @85 % | Max DD | Longest losing streak | One candle late |
|---|---|---|---|---|---|---|
| TRAIN | 8,757 | 56.2 % (55.2–57.3) | +354 | 35 | 10 | 54.3 % |
| VALIDATION | 3,159 | 57.8 % (56.1–59.6) | +221 | 19 | 13 | 52.6 % (−86) |
| **TEST** | **4,420** | **55.6 % (54.1–57.1)** | **+127** | **41** | **8** | **51.5 % (−211)** |

TEST by pair: AUD/JPY 58.3 %, AUD/USD 58.2 %, EUR/USD 55.8 %, GBP/USD 55.7 %, USD/CAD 53.2 %, EUR/JPY 51.3 %. By session: 54.2–56.1 %. By month (all 23): 52.0–61.7 %, 18 of 23 months above break-even; March 2020 (crash) 55.6 %.

**Honest reading**

- On-time, the TEST lower bound (54.1 %) only just touches break-even (54.05 %). The edge is real in this data but thin: about +3 % of stake per trade.
- Selection bias: 864 variants were tried. The top 10 on TRAIN all scored 55.9–59.0 % on VALIDATION, and the chosen one held on TEST, which argues against a pure fluke — but expect live results at the low end.
- The TREND regime was weaker on TEST (52.4 %) but not on TRAIN (56.1 %) or VALIDATION (56.5 %), so no filter was added for it; adding one now would be tuning on TEST.
- Two pairs (EUR/JPY, USD/CAD) were below break-even on TEST. They were fine on TRAIN/VALIDATION and were not removed for the same reason.
- **80 % target: not achievable on this evidence.** The best stable rule wins ~56 % with immediate entry and ~51 % with a one-minute delay.

## 6. Phase 7 — demo monitoring (in the app)

- Every v2 signal is recorded with its rule version before the outcome is known, then settled from the feed.
- Results headline shows only rule-based signals of the selected version; v1 and old forced Generate records are listed separately.
- `assessStrategyHealth` (window 50, minimum 20): **DEGRADED** only when the whole 95 % interval of the recent win rate is below break-even; signals then pause until the user overrides. A bad streak still consistent with break-even is **WATCH**.
- Data problems already force NO TRADE (stale, gaps, misaligned, unverified, OTC).
- Rollback: v1 Strict / v1 Normal stay selectable (marked old) and keep their own stats.
- No trade execution, browser automation, broker credentials or Quotex APIs were added.

## 9. Deep optimization: statistical and ML models (second round)

Question: do models fed with all decision-time features beat the v2 rule, and is 90 % reachable?

**Extra checks before modelling**

- Labels: 20,000 random ledger rows re-derived from the raw CSVs by an independent script → **0 mismatches** (on-time and late labels).
- Pair/market wiring, candle closing, entry window and repainting were re-checked (see §3); no new bug found.
- v1 "agreement score" vs outcome on TEST: 48.5–49.6 % in every bucket from 0.45 to 1.0 — **no relationship** to winning, so it was never a confidence score.
- Feature parity: `scripts/research/features.py` matches the engine's own RSI, %B, range/ATR and ATR-percentile readings to rounding (median abs. diff ≤ 0.0025 RSI points).

**Dataset** (`features.py`): 33 features available at the close of the signal candle — returns over 1–60 min scaled by ATR, candle geometry, RSI 14/7, %B, MACD histogram and its change, EMA distances and slope, ATR percentile and ratio, distance to 20-bar high/low, last complete 5-minute return, hour, weekday, minute in the 5-minute bucket, pair. Tick volume is excluded (the live feed has no comparable volume). Eligible minutes = same data gate as the app (no missing minute in the last 60): TRAIN 1,073,673 · VALIDATION 386,841 · TEST 521,240.

**Protocol** (`ml.py`): models fit on TRAIN only; VALIDATION used for early stopping, isotonic calibration and the abstention margin θ (choose θ with the highest lower 95 % bound, ≥ 1,000 trades); θ frozen; TEST scored once. Decision: CALL if calibrated p(up) ≥ 0.5 + θ, PUT if ≤ 0.5 − θ, else NO TRADE. Experiments tried: 2 model types × 16 margins (+ the 864 v2 grid points from §5).

**Predictive power on TEST (all eligible minutes)**

| Model | AUC | Log-loss (base 0.69314) | Win rate if it always trades |
|---|---|---|---|
| Logistic regression | 0.5133 | 0.69300 | 50.9 % |
| LightGBM (52 trees) | 0.5147 | 0.69281 | 50.9 % |

Calibrated probabilities stay between ~0.46 and ~0.53 (reliability within ±0.01 of observed). The models know very little; they never become "sure".

**Selective prediction — same TEST minutes, identical outcome rule**

| Version | Opportunities | Signals (coverage) | Decided | Win rate (95 % CI) | Net @85 % | Max DD | Longest losing streak | One candle late |
|---|---|---|---|---|---|---|---|---|
| v1 STRICT (old) | 521,240 | 60,719 (11.6 %) | 57,995 | 49.1 % (48.7–49.6) | −5,274 | 5,276 | 16 | 49.0 % |
| v2 Fade (rules, default) | 521,240 | 4,551 (0.87 %) | 4,420 | 55.6 % (54.1–57.1) | +127 | 41 | 8 | 51.5 % |
| Logistic, θ = 0.08 | 521,240 | 1,070 (0.21 %) | 1,037 | 58.4 % (55.4–61.4) | +84 | 20 | 9 | 51.7 % |
| **v3 LightGBM, θ = 0.08** | 521,240 | 1,667 (0.32 %) | 1,620 | **58.9 % (56.5–61.3)** | +145 | 17 | 6 | 52.3 % |

v3 by pair (TEST): AUD/USD 65.6 %, EUR/USD 61.3 %, AUD/JPY 59.6 %, GBP/USD 58.8 %, USD/CAD 54.5 %, EUR/JPY 53.7 %. By month: 53.3–61.8 %. Rejected opportunities: 99.68 %.

**Robustness**

- *Walk-forward*: refitting LightGBM before each TEST month on all earlier data (same settings, θ, recalibrated on the previous 6 months) gave **55.0 % (95 % CI 54.3–55.7 %)** on 18,742 trades — the probability scale shifts between refits, coverage jumped to 3.7 % and the edge fell to v2's level. The 58.9 % is therefore tied to one frozen model and is **not** shown to survive retraining.
- v3 vs v2 on TEST: +3.3 points, z ≈ 2.3 (p ≈ 0.02) for a single comparison, but after 30+ model/margin experiments and the failed walk-forward this is **not** a demonstrated improvement.
- When v2 fires, the GBM points the same way 100 % of the time (it learned the same exhaustion-reversal effect), so it cannot filter v2's losers.
- Ablation (drop one feature group, VALIDATION): every group changes AUC by ≤ 0.0012. Time-of-day and short-term momentum carry the most; trend, oscillators, volatility, range and 5-minute groups are largely redundant with each other. Pair adds nothing.

**90 % target**: the highest VALIDATION win rate at any margin with ≥ 30 trades was **73.8 % on 80 trades** (95 % CI 63–82 %), i.e. 0.02 % of minutes. Nothing approached 90 %, and tiny high-margin buckets did not hold up. **90 % is not supported by this data.** The best defensible result remains ~56–59 % with immediate entry on < 1 % of minutes, falling to ~52 % with a one-minute delay.

**What shipped**: v3 runs in **shadow mode only** (`src/lib/ml/`, `src/lib/engine/shadow.ts`). On every live scan the app records what v2 and v3 would have done on the same minute, settles them with the same outcome rule, and shows coverage and win rate side by side in Results. v3 never raises an alert. The TypeScript port reproduces the research result exactly (1,620 trades, 58.89 %, `scripts/research/shadow-ledger.ts`) and matches LightGBM's probabilities to 1e-9 on a fixture (`tests/unit/ml-shadow.test.ts`).

**Next experiments**: tick data to measure entry delay in seconds; a recent (2024–2026) dataset from the live provider; walk-forward retraining with a margin defined by coverage (top x %) instead of a probability, which is stable across refits; promote v3 only if live shadow results beat v2 on ≥ 200 decided trades.

## 10. Third round: timing bug, walk-forward of v2, in-app history

**Bug found and fixed — scan timing vs v2 entry window.** The app checked the market 4 s after each candle closed and retried every 5 s (4, 9, 14 s) when the feed had not yet published the finished candle, but v2's entry window closed at 10 s. Whenever the feed was a few seconds late, the only fresh answer arrived after the window had shut, so a valid v2 setup was shown as "entry window passed". Now: attempts at 3, 7 and 11 s (still 3 calls per minute for the Twelve Data credit limit) and a 15 s v2 window; `tests/unit/scan-timing.test.ts` checks that every mode's window covers the last attempt plus 3 s of network time. The app now also counts, per device, on which attempt the feed delivered the candle (More → Feed timing), so feed lateness is measured instead of guessed.

**Walk-forward of the v2 selection procedure** (`walkforward_fade.py`): before each month from 2019-07 to 2020-05, the full 864-point search was re-run on all earlier data only and its best rule traded that month.

| Period | Re-chosen monthly | Shipped v2 (chosen once) |
|---|---|---|
| Jul 2019 – May 2020 | 57.1 % (55.8–58.3), n = 6,296 | 56.6 % (55.5–57.7), n = 7,595 |
| TEST Jan – May 2020 | 56.1 % (54.5–57.8), n = 3,544 | 55.7 % (54.3–57.2), n = 4,425 |
| TEST, one candle late | 51.3 % | 51.4 % |

The procedure keeps choosing nearly the same rule (%B 1.0 → 1.1 from Sep 2019) and its results hold month to month, so **v2 survives walk-forward** — unlike the v3 ML model (§9). The shipped parameters were not changed: the difference is not significant and changing them now would mean tuning on TEST.

**Product**: Backtest tab shows the verified table above (generated by `export_history.py` from the research outputs, never typed by hand); Results lists each signal with entry and expiry time, market type, provider and rule version, and states LIVE vs OTC counts; the signal screen says the signals do not apply to OTC pairs; the Pro card now says the v1 agreement score had no relationship to outcomes.

**Still true:** no tested configuration approaches 90 %. The best robust results are 55–57 % with immediate entry on < 1 % of minutes.

## 11. Re-check on recent data (live provider)

The biggest open limitation (§7.3) is that every result above comes from 2018–2020. The **Recent data test** re-runs the shipped rules, unchanged, on recent candles from Twelve Data, the feed the app uses live:

- `scripts/research/fetch-twelvedata.ts` downloads up to `--days` (default 60) of 1-minute candles for the same six pairs, paging back 5,000 candles per call within the free plan's per-minute limit. The candle still forming at fetch time is dropped; nothing is filled in. If the plan holds less history than requested, the covered period is recorded instead of guessed.
- `scripts/research/recent-test.ts` runs v2 through `runBacktest` (same engine and outcome rule as §2) and the v3 shadow model with the same data gate, then writes `src/lib/research/recent.json`: on-time and one-candle-late win rates with 95 % Wilson intervals, by pair and session, a two-proportion test against the 2020 TEST result and v3 against v2, and a verdict (EDGE / UNPROVEN / LOSING; no verdict under 200 decided trades).
- `.github/workflows/recent-test.yml` runs both (manually from the Actions tab, and every Saturday after the FX week closes) using the repository secret `TWELVEDATA_API_KEY`, and commits `recent.json`. The Backtest tab shows it above the historical table.

Nothing is tuned on this data. It answers one question: does the edge measured in 2020 still exist on today's feed? If v2 shows LOSING, stop using it; if UNPROVEN, treat it as unproven. The pipeline was checked offline against a mock of the documented API shape; the first real run is the first contact with the live API.

### First results on Twelve Data (2026-08-15 → 2026-10-14, 6 pairs)

| | Decided | Win rate | One candle late |
|---|---|---|---|
| v2, all minutes (first run) | 3,231 | 29.3 % | 57.7 % |
| v2, weekdays only (after the market-hours gate) | 1,843 | **12.8 %** (11.3–14.4 %) | 49.5 % |
| v2, weekdays, scored from the signal candle's close | 1,830 | 15–30 % by pair | — |

Win rates this far below 50 % are not a market effect: they mean the feed's candles carry strong artificial continuation from one minute to the next. Measured on weekday minutes:

- the feed returns **~25,000 weekend candles per pair** (market closed) — the engine now refuses them (`data.marketHours`);
- the next candle opens at the previous close in only **0–10 %** of minutes (OANDA tick-built candles: nearly always within a pip); the gap is ~30 % of the candle's range and leans back into the previous candle (regression of gap on body ≈ −0.4);
- on **every** v2 signal the gap pointed against the signal candle.

So on this feed consecutive 1-minute candles overlap or are smoothed, and v2 (built on continuous OANDA candles) measures as badly wrong. Do not "reverse" the signals: a win rate produced by a smoothed feed cannot be traded on a real price. Next step: re-run the same test on a tick-built feed (OANDA v20 practice M1 candles) before drawing any conclusion about v2 itself. The Dukascopy test below did exactly that.

### Results on Dukascopy (tick-built, 2026-08-16 → 2026-10-14, 6 pairs, weekdays)

Dukascopy's candles behave like the OANDA history: the next open sits close to the previous close (median jump 4–11 % of the range vs ~30 % on Twelve Data) and shows no lean back into the previous candle (regression slope ≈ 0 vs −0.4). So this is the fair test of the rules themselves.

| Version | Decided | Win rate (95 % CI) | One candle late | Net @85 % | Verdict |
|---|---|---|---|---|---|
| v2 Fade | 2,114 | **47.7 % (45.6–49.9 %)** | 49.9 % | −247 | LOSING |
| v3 ML (shadow) | 956 | 51.1 % (47.9–54.2 %) | 51.3 % | −53 | not demonstrated |

- v2 is 7.9 points below its 2020 TEST result (z = −6.0). Every pair is between 44 % and 52 %. **The 2018–2020 edge is not present in today's market.** Changing the data provider will not bring it back.
- The New York session scored 57.6 % (n = 439). That is one of five sessions picked after the fact, and the same session was v2's weakest in 2020 (54.2 %). Treat it as noise unless a future, untouched period confirms it.
- v3 is not significantly better than v2 (p = 0.09) and is below break-even.

## 12. New strategy search (v4), pre-registered — 2026-10-14

Protocol fixed in `scripts/research/search_v4.py` before any result: Dukascopy mid candles 2024-08-15 → 2026-10-14, 6 pairs; TRAIN to 2025-09-30, VALIDATION 2025-10 → 2026-03, TEST 2026-04 → 2026-10; 450 rule variants (band extremes, streaks, RSI extremes, wick rejection, breakouts, 15-minute moves; each as fade and as momentum) × 5 sessions × 1- and 2-minute expiry = **4,500 configurations**; payout 90 % → break-even 52.63 %. Negative control on synthetic random walks: TRAIN leaders fell to ~50 % on VALIDATION and the verdict was NONE.

All 20 TRAIN leaders were variants of the same idea as v2 — fade a large candle that closed beyond the Bollinger band with RSI stretched, 1-minute expiry. No streak, breakout, wick, momentum or 2-minute rule made the list.

Chosen on VALIDATION: **close ≥ 20 % of the band width beyond the band (%B ≥ 1.2 / ≤ −0.2), range ≥ 3 × ATR(14), body ≥ 50 %, RSI(14) ≥ 75 / ≤ 25 → trade the opposite direction, 1-minute expiry, 00–21 UTC.**

| Split | Decided | Win rate (95 % CI) | One candle late | Net @90 % |
|---|---|---|---|---|
| TRAIN | 1,507 | 56.7 % (54.2–59.2) | 49.4 % | +116 |
| VALIDATION | 591 | 57.2 % (53.2–61.1) | 51.4 % | +51 |
| **TEST** | **860** | **55.8 % (52.5–59.1)** | 54.0 % | **+52** |

**Verdict by the pre-set rule: FAILED_TEST** — the TEST lower bound (52.48 %) is just below break-even (52.63 %). About 1.1 signals per pair per day. TEST by month: 51–63 % from April to August, then 48.7 % (Sep) and 43 % (Oct, 37 trades), the same recent weakness the 60-day check (§11) showed. Intervals are somewhat optimistic because signals on different pairs in the same minute are correlated.

Reading: there is still a faint exhaustion-reversal effect in very large 1-minute candles, but it is not demonstrated above break-even, it has weakened in the last two months, and it depends on entering within seconds. **Not a strategy to trade with money.** The only honest next step is a forward test: run it in shadow mode / on a demo account and promote it only if ≥ 300 live demo trades clear break-even.

**Shipped as a demo-only mode (V4).** The app's TypeScript engine reproduces the Python result exactly on the same candles (`scripts/research/v4-parity.ts`: 860 TEST trades, 55.81 %, identical per pair). Because Twelve Data's candles are distorted (§11), the forward test does not trust the app's own feed-based WIN/LOSS: each v4 signal is marked by hand with the result of the user's Quotex demo trade, and only those marks count toward the 300-trade verdict (Results → "v4 Demo forward test"). A daily loss limit (default 3) stops signals for the rest of the day; it limits damage, it does not raise accuracy.

## 7. Limitations

1. OANDA mid candles ≠ Twelve Data ≠ Quotex quotes. Reversal effects at 1 minute are sensitive to how a feed builds its candles; re-check on the live feed before using real money.
2. Entry latency is only bounded (0 s vs 60 s), not measured; 1-minute data cannot do better. Tick data would.
3. 2018–2020 only; market microstructure changes. The Recent data test (§11) re-checks v2 and v3 on recent live-feed candles.
4. No news filter (no verified calendar provider) — v2 trades large candles, which news often causes.
5. No OTC data exists here; v2 says nothing about OTC.
6. Your own past signals could not be analysed (not reachable from this environment).

## 8. Reproduce

```bash
# 1. Data (≈200 MB, OANDA mid candles from github.com/FutureSharks/financial-data)
bash scripts/research/fetch-oanda.sh data

# 2. Ledgers with the real engine (≈4 min per pair per mode)
npx tsx scripts/research/ledger.ts --data data --pair EUR_USD --out research-out/baseline --modes STRICT,NORMAL
npx tsx scripts/research/ledger.ts --data data --pair EUR_USD --out research-out/v2 --modes V2

# 3. Analysis (Python 3 + pandas)
python3 scripts/research/analyze.py --ledgers research-out/baseline --out research-out/baseline-report.json --pickle research-out/baseline.pkl
python3 scripts/research/search_fade.py --pickle research-out/baseline.pkl --out research-out/fade-search.json
python3 scripts/research/compare.py --baseline research-out/baseline --v2 research-out/v2 --out research-out/compare.json

# 4. Models (§9): features, training/validation/test, export, parity fixture, TS re-check
python3 scripts/research/features.py --data data --out research-out/features.pkl
python3 scripts/research/ml.py --features research-out/features.pkl --v2 research-out/v2 --out research-out/ml.json --export research-out/model-v3.json
python3 scripts/research/gen_ml_fixture.py --model research-out/model-v3.lgb.txt --json src/lib/ml/model-v3.json --out tests/fixtures/ml-v3.json
npx tsx scripts/research/shadow-ledger.ts --data data --pair EUR_USD --from 2020-01-01T00:00:00Z --out research-out/v3

# 5. Walk-forward of v2 and the in-app history table (§10)
python3 scripts/research/walkforward_fade.py --pickle research-out/baseline.pkl --out research-out/walkforward-fade.json
python3 scripts/research/export_history.py --dir research-out --out src/lib/research/history.json
```
Python packages: pandas, numpy, scikit-learn, lightgbm.
