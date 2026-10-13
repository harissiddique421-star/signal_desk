# Live-entry validation protocol

## Why this exists
The historical research found FADE_V2 at 55.6% on immediate feed-candle entry, but 51.5% when entry was delayed by one candle. This does not establish profitability on Quotex. The app must measure actual manual-entry delay and keep broker-observed outcomes separate from feed estimates.

## Safe protocol
1. Use demo mode only; do not place real-money trades to validate a model.
2. Keep automatic execution disabled.
3. Select LIVE only when the provider is verified for the selected pair. OTC must remain NO TRADE unless a permitted, verified broker-OTC feed is available.
4. For each CALL/PUT alert, record the pair, market type, rule version, signal time, actual manual-entry delay in seconds, and outcome observed in the broker demo interface.
5. Mark a result BROKER_MANUAL only when the result and price were actually observed in the broker interface. Mark feed-derived outcomes FEED_ESTIMATE. Do not relabel historical feed estimates as broker results.
6. Keep unresolved outcomes unresolved; record ties as ties; never remove losses.
7. Review at least 200 resolved broker-observed demo entries before drawing a directional conclusion. Report the Wilson 95% confidence interval, sample size, pair, session, market type, delay bucket (0–2s, 3–5s, 6–10s, >10s), and actual payout.
8. Keep the final test period untouched. Do not keep changing thresholds until the same sample looks good.

## Interpretation
- A confidence score is not a win rate.
- A 90% target is not evidence and must not be displayed as achieved without independent test results.
- A positive historical backtest is not proof of live profitability.
- A 1-minute FX feed is not a substitute for broker-generated OTC quotes.
- The break-even win rate depends on payout: 1 / (1 + payout fraction). At 85% payout this is about 54.1%, before practical execution differences.
