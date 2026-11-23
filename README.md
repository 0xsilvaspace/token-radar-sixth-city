# Token Launch Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xsilvaspace/token-radar-sixth-city/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xsilvaspace/token-radar-sixth-city/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar for the [$1,325 make.fun bounty](https://make.fun/bounty/token-radar-01): it reads a sealed snapshot of every protocol DefiLlama tracks, finds the ones that record no token, and ranks them by what a launch would be worth.

## The model (radar-2)

Each protocol's implied value is its TVL times its category's market-cap-to-TVL ratio, where the ratio is the median of the protocols in that category that already have a token (categories with fewer than 3 token protocols fall back to the global median, 0.2138). The result is adjusted by the protocol's 7-day TVL change, clamped to -20% to +50%, and by how long it has run with no token, up to 3 years. Ratios are clamped to 0.01-1.5 and implied values to $50B. No protocol name is special-cased: the same formula scores every row.

The board holds 226 rows: the snapshot's whole 40-protocol watchlist plus the 186 highest-valued pre-token protocols below the $50M floor. That is every protocol the snapshot holds that records no token and is a launch of its own: the rest either record a token, or are wrapped, bridged, staked or exchange products whose token already trades, or versioned pools of another protocol. Every row carries a five-step farm plan with costs and time, built from the protocol's own category, chains, TVL and age.

Implied values are this entry's own claim, never a prediction that a token will be issued. A protocol is shown as one that records no token in the snapshot, never as one that has none.

## Run it

Node 22, standard library only, no install:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

That writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory. Two runs write byte-identical output.
