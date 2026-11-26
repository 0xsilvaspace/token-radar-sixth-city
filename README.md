# Token Launch Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xsilvaspace/token-radar-sixth-city/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xsilvaspace/token-radar-sixth-city/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar for the [$1,325 make.fun bounty](https://make.fun/bounty/token-radar-01): it reads a sealed snapshot of every protocol DefiLlama tracks, finds the ones that record no token, and ranks them by what a launch would be worth.

## The model (radar-5)

radar-5 picks its scoring model by held-out validation instead of by a single in-sample fit: at runtime it splits the snapshot's 128 token protocols into two deterministic halves (even vs odd by sorted slug), fits a regression of log market cap over TVL on one half, and scores both that regression and the radar-3 category-median model on the other half by Spearman rank correlation between predicted and actual market cap, in both directions. The regression averages Spearman 0.33 against radar-3's 0.35, and its held-out R-squared on log ratio is negative in both directions, so it does not beat the category-median model and the board scores with radar-3. The validation is reported whole in the dashboard's methodology card, so the choice is checkable. The v3 diagnostic also stays: a runtime regression of log market cap on log TVL, 7-day growth, age and chain count explains only 22% of the variation, R² 0.22, with negative growth and age coefficients, the opposite of what a launch is worth, so it stands as a diagnostic, shown in the methodology card and in every detail view as a regression check.

The scoring model: each protocol's implied value starts from its TVL with diminishing returns, size is TVL to the power 0.9, so the board is not just TVL order. That size is priced by its category's market-cap-to-TVL ratio, the median of the protocols in that category that already have a token (categories with fewer than 3 token protocols fall back to the global median, 0.21). Then four multipliers from the snapshot's own figures: the protocol's 7-day TVL change, clamped to -20% to +50% with weight 0.75; its category's momentum, the median 7-day change of that category's token protocols, clamped to -15% to +30% with weight 0.5; how long it has run with no token, log-scaled from 0.70 to 1.00 over 4 years; and how many chains it runs on, up to 1.15 for six or more. Ratios are clamped to 0.01-1.5 and implied values to $50B. No protocol name is special-cased: the same formula scores every row, and every detail view shows the factor-by-factor working.

The board holds 226 rows: the snapshot's whole 40-protocol watchlist plus the 186 highest-valued pre-token protocols below the $50M floor. That is every protocol the snapshot holds that records no token and is a launch of its own: the rest either record a token, or are wrapped, bridged, staked or exchange products whose token already trades, or versioned pools of another protocol. Every row carries a five or six step farm plan with costs and time, built from the protocol's own category, chains, TVL and age, with a second-chain step for protocols that run on more than one chain. Every plan names the minimum capital to start with (a dollar range that fits the protocol's chains), the one risk that matters most for that kind of farm, and a week-by-week timeline for the farm. The dashboard also lists the board's ten fastest growers over seven days, the top three pre-token protocols in each of the five largest categories, and charts total implied value by category.

Implied values are this entry's own claim, never a prediction that a token will be issued. A protocol is shown as one that records no token in the snapshot, never as one that has none.

## Run it

Node 22, standard library only, no install:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

That writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory. Two runs write byte-identical output.
