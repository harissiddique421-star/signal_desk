#!/usr/bin/env bash
# Download the OANDA 1-minute mid candles used in docs/RESEARCH.md (~200 MB).
#   bash scripts/research/fetch-oanda.sh data
# Source: github.com/FutureSharks/financial-data (public). Files are not committed here.
set -euo pipefail
OUT="${1:-data}"
BASE="https://raw.githubusercontent.com/FutureSharks/financial-data/master/pyfinancialdata/data/currencies/oanda"
for p in EUR_USD GBP_USD USD_CAD AUD_USD EUR_JPY AUD_JPY; do
  mkdir -p "$OUT/$p"
  for y in 2018 2019 2020; do
    for m in $(seq 1 12); do
      if [ "$y" = 2018 ] && [ "$m" -lt 7 ]; then continue; fi
      if [ "$y" = 2020 ] && [ "$m" -gt 5 ]; then continue; fi
      f="$OUT/$p/$y-$(printf %02d "$m").csv"
      [ -s "$f" ] || curl -fsS --retry 3 -o "$f" "$BASE/$p/$y/oanda-$p-$y-$m.csv"
    done
  done
  echo "$p: $(ls "$OUT/$p" | wc -l) files"
done
