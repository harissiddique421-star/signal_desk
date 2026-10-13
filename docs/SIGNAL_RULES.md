# Signal rules

Two rule versions ship. **v2 (`rules-v2-fade`, mode `V2`) is the default.** v1 (`rules-v1`, modes `STRICT` / `NORMAL`) is kept for comparison and rollback. Historical results for both are in [`RESEARCH.md`](RESEARCH.md).

## v2 — exhaustion fade (`strategy: FADE_V2`)

Same source and data gates as v1 (steps 1–2 below). Then, on the last **closed** candle:

| Check id | Rule (default) |
|---|---|
| `fade.stretch` | up-candle closing above the upper Bollinger band (%B > 1), or down-candle closing below the lower band (%B < 0) |
| `fade.range` | candle range ≥ `fadeMinRangeAtr` (2) × ATR(14) of the previous candle |
| `fade.body` | body ≥ `fadeMinBodyRatio` (50 %) of the range |
| `fade.rsi` | RSI(14) ≥ `fadeRsiExtreme` (70) after an up-candle, ≤ 30 after a down-candle |
| `session.hours` | signal candle hour (UTC) not in `blockedHoursUtc` (21, 22, 23 — daily rollover) |
| `timing.window` | evaluated within `entryWindowSeconds` (15) of the candle close — wide enough for the app's last scan attempt at 11 s |

All pass → **PUT after the up-candle, CALL after the down-candle**, for the next 1-minute candle. Anything else → NO TRADE with the failed check named. v1's volatility/shock filters and trend gates are not applied in v2 (the trend evidence is still computed and shown). There is no score: a v2 signal either meets every rule or it does not.

Historical result (OANDA, untouched TEST period Jan–May 2020): 55.6 % (95 % CI 54.1–57.1 %) with entry at the next candle's open; 51.5 % if entered one candle late. Break-even at 85 % payout is 54.05 %.

## v3 — ML shadow (`v3-ml-shadow`)

A frozen LightGBM model (`src/lib/ml/model-v3.json`) predicts p(up) for the next candle from 33 features; CALL if calibrated p ≥ 0.58, PUT if ≤ 0.42, otherwise NO TRADE. It runs only in **shadow mode**: its decisions are recorded and compared with v2 in Results, never shown as signals. Trained pairs only (EUR/USD, GBP/USD, USD/CAD, AUD/USD, EUR/JPY, AUD/JPY); no OTC. See `RESEARCH.md` §9.

## v1 — trend confluence (`strategy: TREND_V1`)

On 3.87 M historical minutes v1 won 48–49 % (CI below 50 %) in every split. Not recommended.

Signal Desk uses fixed, readable rules. Nothing is trained or fitted, and there is no hidden model. Every threshold lives in `src/lib/config/rules.ts` and can be overridden per request through the validated `rules` field of `POST /api/analyze`.

## Order of evaluation

1. **Source gates** — the source must be a verified market feed, it must cover the selected market type (regular or OTC), and it must offer the symbol. OTC requests against a regular FX feed stop here with *"No verified data source for broker OTC prices"*.
2. **Data gates** (on closed candles only; the still-forming candle is dropped)
   - at least `minCandles` (120) closed 1-minute candles
   - every candle passes OHLC checks (finite, positive, `high ≥ max(open, close)`, `low ≤ min(open, close)`)
   - timestamps aligned to the minute, strictly ascending, unique
   - no missing candles in the last `gapLookback` (60) minutes
   - fresh: the last closed candle is the one that just finished and closed no more than `maxStalenessSeconds` (75 s) ago
3. **Volatility filters** — ATR(14) must sit between the 20th and 95th percentile of its last 100 values; the last candle's range must not exceed 2.5× the previous ATR (shock candle).
4. **News filter** — no verified economic-calendar provider is configured yet. By default this adds a warning; set `requireNewsFilter: true` to block all signals instead.
5. **Evidence** (direction + weight)

   | Module | Bullish when | Weight |
   |---|---|---|
   | Trend (EMA 9/21 + EMA 50) | EMA9 > EMA21 and close > EMA50 | 2 |
   | Trend slope | EMA21 rising over 3 bars | 1 |
   | Market structure | last two confirmed swings: higher high + higher low | 2 |
   | MACD (12, 26, 9) | histogram > 0 and not falling | 1 |
   | RSI (14, Wilder) | 50 < RSI < 70 | 1 |
   | Bollinger (20, 2σ) | close above middle band | 0.5 |
   | Candlestick patterns | engulfing, hammer, marubozu, three soldiers… | 1.5 |
   | Breakout / retest / false breakout | close beyond 20-bar range, retest held, or failed break the other way | 1.5–2 |
   | Multi-timeframe | 5-minute EMA9 > EMA21 on complete 5-minute bars | 2 |

   Bearish is the mirror image. Neutral items count toward the denominator only.

6. **Decision gates** for the leading direction — all must pass:
   - agreement score ≥ 0.45 in absolute value
   - at least 4 evidence items agree
   - EMA trend agrees; market structure does not oppose
   - 5-minute trend agrees
   - RSI not exhausted (no CALL at RSI ≥ 70, no PUT at RSI ≤ 30)
   - last candle is not a doji
   - the nearest opposing support/resistance zone is more than 0.5 ATR away
   - the entry window is still open (10 s after the signal candle closes)

Any failure gives **NO TRADE** with the exact reasons. Sample and screenshot data can never produce CALL/PUT; the card then shows what the rules alone concluded (`engineDecision`) only for testing.

## The agreement score is not a confidence score

`agreementScore = (bullish weight − bearish weight) / total weight`, from −1 to +1. It measures how much of the evidence points one way. It is **not** a probability of winning and has **not been calibrated** against outcomes. A calibrated confidence figure needs a large set of resolved live signals (hundreds at minimum, per pair) and a reliability analysis; until that exists the UI labels the number accordingly.

## Look-ahead and leakage safeguards

- Unfinished candles are removed before any calculation.
- All indicators at index *i* use only inputs 0…*i* (tested: appending future data never changes earlier values).
- Swing points need `swingStrength` later candles before they count, so the newest candles can never be swings.
- Higher-timeframe bars are built only from complete 5-minute buckets.
- The backtest hands the engine `candles[0…i]` at step *i*, evaluates "now" as one second after candle *i* closed, and reads the outcome from candle *i+1* (tested: appending later data leaves earlier trades unchanged).

## Break-even arithmetic

With payout *p* (e.g. 0.80) and a full-stake loss, the break-even win rate is `1 / (1 + p)` — 55.6% at 80%, 54.1% at 85%. Results are reported with a 95% Wilson interval; if that interval includes the break-even rate, the app states that no edge has been demonstrated.
