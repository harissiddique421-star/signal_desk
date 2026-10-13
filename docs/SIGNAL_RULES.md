# Signal rules (rules-v1)

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
