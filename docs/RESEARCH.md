# Signal engine research: audit, loss analysis, v2 strategy

*Run on 2026-10-14. Every number below comes from the scripts in `scripts/research/` running the real TypeScript engine on real historical candles. Nothing was fitted on the TEST period. No trades were removed.*

## 1. Short answer

- **The original engine (v1) loses.** On 3.87 million historical 1-minute candles its signals won **48–49 %** of the time in every period, every pair and every session. The 95 % interval is *below 50 %*, so this is not bad luck: the rules point the wrong way at a 1-minute horizon.
- **Root cause: trend-following at 1 minute.** Every v1 indicator (EMA trend, slope, structure, MACD, RSI-above-50, Bollinger mid-band, 5-minute trend) predicts the next candle *worse than a coin flip* (48.6–49.7 %). Over one minute these FX prices tend to pull back, not continue. The more indicators agreed, the *worse* the result (48.1 % at agreement ≥ 0.75): the agreement score was anti-calibrated.
- **The Generate button was a coin flip.** Its forced UP/DOWN answers won 49.1 % (Mazboot), 49.2 % (Darmiyana) and 49.8 % (Kamzor) on TEST. At an 85 % payout you need 54.1 % to break even.
- **v2 (exhaustion fade)** trades *against* a large, decisive candle that closed outside the Bollinger band with RSI at an extreme. On the untouched TEST period it won **55.6 % (95 % CI 54.1–57.1 %, 4,420 trades)**, +127 stake units at 85 % payout, about 5 signals per pair per day.
- **But the edge disappears with slow entry.** Entering one candle late drops v2 to **51.5 %** (a loss). Real manual entry on Quotex (a few seconds late, broker's own price) sits between those two numbers, so **profit in real use is not demonstrated.**
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
| A7 | Tracker scores open→close of the next candle, but the user enters seconds later on Quotex's own price | `stats/resolve.ts` | v2: 55.6 % on time vs 51.5 % one candle late | Backtest now reports both; v2 entry window cut to 10 s; UI explains the gap |
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

## 7. Limitations

1. OANDA mid candles ≠ Twelve Data ≠ Quotex quotes. Reversal effects at 1 minute are sensitive to how a feed builds its candles; re-check on the live feed before using real money.
2. Entry latency is only bounded (0 s vs 60 s), not measured; 1-minute data cannot do better. Tick data would.
3. 2018–2020 only; market microstructure changes.
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
```
