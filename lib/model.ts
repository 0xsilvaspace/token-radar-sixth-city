// Token launch radar, model version radar-4.
//
// One sealed snapshot in, one ranked board out. The board ranks protocols that
// record no token (no market cap, no CoinGecko id, no symbol) by an implied
// value: what a token would be worth if the protocol's record stayed as it is.
// The value is the entry's own claim, never make.fun's, and it never predicts
// whether or when a token is issued.
//
// radar-4 fits its value model to the snapshot instead of hand-picking the
// weights: at runtime it runs an ordinary least squares regression of log
// market cap on log TVL, 7-day growth, age and chain count, over the token
// protocols the snapshot holds, with plain standard-library math. The fit is
// then judged on its own numbers before it is allowed to score anything:
// it must explain at least 30% of the variation (R-squared 0.30 or better)
// and its TVL, growth and age coefficients must all be non-negative, since a
// launch is worth more when the protocol is bigger, growing and long-running.
// On this snapshot the fit fails that bar: it explains only about 22% of log
// market cap, and its growth and age coefficients come out negative, the
// opposite of what a launch is worth (a single down week in the snapshot, and
// older token protocols carrying lower market caps). So radar-4 scores with
// the radar-3 category-median model and reports the regression, its
// coefficients and its R-squared, as a diagnostic the dashboard shows. The
// scoring model, per protocol, every input from the snapshot alone; no
// protocol name is ever special-cased and the same functions score every row.
//
//   sizeValue  = TVL with diminishing returns: TVL^0.9 * $1M^0.1. A $2.75B
//                protocol still outranks a $50M one, but the gap is 37x
//                instead of 55x, so growth, momentum and age can reorder the
//                mid-field instead of the board being TVL order.
//   ratio      = the median market-cap-to-TVL ratio of the protocols in the
//                same category that already have a token (at least 3 of
//                them), else the median across all token protocols;
//                clamped to [0.01, 1.5] so one outlier cannot set a price.
//   growth     = the protocol's 7-day TVL change, clamped to [-20, +50] %
//   growthMult = 1 + growth / 100 * 0.75, so a fast grower rises hard.
//   momentum   = the median 7-day change of the token protocols in the same
//                category (at least 3), else the median across all token
//                protocols, clamped to [-15, +30] %
//   momentMult = 1 + momentum / 100 * 0.5: a launch is worth more where its
//                category's own tokens are gaining.
//   ageYears   = days since listed_at / 365, capped at 4 years; a protocol
//                with no listed date is treated as 1 year old
//   maturity   = 0.7 + 0.3 * ln(1 + ageYears) / ln(5): log-scaled, so the
//                first year without a token counts most and age tops out.
//   chains     = 1 + 0.03 * min(chains - 1, 5): multi-chain, slightly higher.
//   implied    = sizeValue * ratio * growthMult * momentMult * maturity
//                * chains, capped at $50B.
//
// The board covers the snapshot's whole watchlist (the floor, never the
// ceiling) and adds the highest-valued pre-token protocols below the floor.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  ratio_min: number;
  ratio_max: number;
  ratio_fallback: number;
  min_category_samples: number;
  size_exponent: number;
  size_anchor_usd: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_years: number;
  unknown_age_years: number;
  chain_step: number;
  chain_max_steps: number;
  implied_cap_usd: number;
}

export const MODEL: ModelConstants = {
  ratio_min: 0.01,
  ratio_max: 1.5,
  ratio_fallback: 0.2049,
  min_category_samples: 3,
  size_exponent: 0.9,
  size_anchor_usd: 1_000_000,
  growth_weight: 0.75,
  growth_floor: -20,
  growth_cap: 50,
  momentum_weight: 0.5,
  momentum_floor: -15,
  momentum_cap: 30,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_years: 4,
  unknown_age_years: 1,
  chain_step: 0.03,
  chain_max_steps: 5,
  implied_cap_usd: 50_000_000_000,
};

export const MODEL_VERSION = 'radar-4';

/** The bar a fitted regression must clear before it is allowed to score. */
export const FIT_MIN_R_SQUARED = 0.3;

/** How many rows the board holds: the whole watchlist plus the best early rows. */
export const BOARD_ROWS = 250;

/** How many live-token protocols the dashboard's Live token view carries. */
export const LIVE_ROWS = 24;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_ratio: number;
    size_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    momentum_pct: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    chain_factor: number;
    age_years: number;
    /** What the fitted regression alone would price this protocol at, a diagnostic, never the score. */
    regression_value_usd: number;
  };
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One of the board's fastest growers over seven days. */
export interface MoverRow {
  slug: string;
  name: string;
  category: string | null;
  change_7d: number;
  tvl_usd: number;
  implied_value_usd: number;
  rank: number;
}

/**
 * The regression radar-4 fits at runtime: log market cap on log TVL, 7-day
 * growth, age and chain count, over the snapshot's token protocols. The fit
 * is reported whole, whether or not it is used to score, so the choice of
 * scoring model is checkable from the dashboard's own data.
 */
export interface RegressionFit {
  /** Token protocols the fit ran on. */
  n: number;
  /** Share of log market cap's variation the fit explains. */
  r_squared: number;
  /** Fitted coefficients, in the order [intercept, log TVL, growth, log(1+age), log chains]. */
  coefficients: [number, number, number, number, number];
  /** Median 7-day change of the token protocols, used where a protocol reports none. */
  median_growth_pct: number;
  /** Median age in years of the token protocols, used where a protocol reports no listed date. */
  median_age_years: number;
  /** Whether the fit cleared the bar to score the board. */
  usable: boolean;
  /** Why the fit was or was not used, in plain words. */
  reason: string;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  /** Which model scored the board, and why. */
  scoring: string;
  regression: RegressionFit;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_ratios: Record<string, number>;
  category_momentum: Record<string, number>;
  rows: RadarRow[];
  live: LiveRow[];
  /** The board's ten fastest growers over seven days. */
  movers: MoverRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The median of a list of numbers, or null when the list is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from listed_at to as_of, clamped at zero; null when either is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Solve a small linear system by Gaussian elimination with partial pivoting, or null when it is singular. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const k = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (piv !== col) {
      const tmp = m[col]!;
      m[col] = m[piv]!;
      m[piv] = tmp;
    }
    const d = m[col]![col]!;
    if (Math.abs(d) < 1e-10) return null;
    for (let r = col + 1; r < k; r++) {
      const f = m[r]![col]! / d;
      for (let c = col; c <= k; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const x = Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = m[r]![k]!;
    for (let c = r + 1; c < k; c++) s -= m[r]![c]! * x[c]!;
    x[r] = s / m[r]![r]!;
  }
  return x;
}

/** Ordinary least squares on a small design matrix, or null when it is singular. */
export function ols(xRows: number[][], y: number[]): number[] | null {
  const k = xRows[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => Array<number>(k).fill(0));
  const aty: number[] = Array<number>(k).fill(0);
  for (let i = 0; i < xRows.length; i++) {
    for (let r = 0; r < k; r++) {
      aty[r]! += xRows[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) ata[r]![c]! += xRows[i]![r]! * xRows[i]![c]!;
    }
  }
  return solveLinear(ata, aty);
}

/**
 * The regression's one row of inputs for a protocol: [1, log TVL, growth,
 * log(1+age), log chains]. Growth is clamped to -50% to +100%; a missing
 * 7-day change takes the token protocols' median, a missing listed date
 * their median age. The same transform is used to fit and to predict, so
 * the fit's R-squared describes the predictions it makes.
 */
export function regressionRow(p: SnapshotProtocol, asOf: string, medianGrowthPct: number, medianAgeYears: number): [number, number, number, number, number] {
  const growth = (typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : medianGrowthPct) / 100;
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? medianAgeYears : age / 365;
  return [
    1,
    Math.log(Math.max(1, p.tvl_usd)),
    Math.min(1.0, Math.max(-0.5, growth)),
    Math.log(1 + ageYears),
    Math.log(Math.max(1, p.chains.length)),
  ];
}

/**
 * Fit log market cap on log TVL, 7-day growth, age and chain count, over the
 * snapshot's token protocols, and judge the fit on its own numbers. The fit
 * is usable only when it explains at least FIT_MIN_R_SQUARED of the
 * variation and its TVL, growth and age coefficients are all non-negative:
 * a launch is worth more when the protocol is bigger, growing and
 * long-running, and a fit that says otherwise is fitting one week's noise.
 * On this snapshot the fit explains only about a fifth of log market cap
 * and its growth and age coefficients are negative, so it is reported and
 * not used: the board scores with the category-median model instead.
 */
export function fitRegression(snapshot: Snapshot): RegressionFit {
  const token = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const growths = token.filter((p) => typeof p.change_7d === 'number').map((p) => p.change_7d as number);
  const ages = token.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null).map((a) => a / 365);
  const medianGrowthPct = median(growths) ?? 0;
  const medianAgeYears = median(ages) ?? 1;
  const xRows: number[][] = [];
  const y: number[] = [];
  for (const p of token) {
    xRows.push(regressionRow(p, snapshot.as_of, medianGrowthPct, medianAgeYears));
    y.push(Math.log(p.mcap_usd as number));
  }
  const beta = xRows.length > 5 ? ols(xRows, y) : null;
  if (beta === null || beta.length !== 5) {
    return {
      n: token.length,
      r_squared: 0,
      coefficients: [0, 0, 0, 0, 0],
      median_growth_pct: Math.round(medianGrowthPct * 100) / 100,
      median_age_years: Math.round(medianAgeYears * 100) / 100,
      usable: false,
      reason: 'The regression could not be fitted (singular design matrix), so the board scores with the category-median model.',
    };
  }
  const yMean = y.reduce((a, v) => a + v, 0) / y.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    const pred = xRows[i]!.reduce((a, v, j) => a + v * beta[j]!, 0);
    ssRes += (y[i]! - pred) ** 2;
    ssTot += (y[i]! - yMean) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const [, bTvl, bGrowth, bAge] = beta as [number, number, number, number, number];
  const usable = rSquared >= FIT_MIN_R_SQUARED && bTvl > 0 && bGrowth >= 0 && bAge >= 0;
  const reason = usable
    ? `The fitted regression explains ${(rSquared * 100).toFixed(1)}% of log market cap across ${token.length} token protocols, so it scores the board.`
    : `The fitted regression explains only ${(rSquared * 100).toFixed(1)}% of log market cap across ${token.length} token protocols, and its growth (${bGrowth.toFixed(2)}) and age (${bAge.toFixed(2)}) coefficients are negative, the opposite of what a launch is worth, so the board scores with the category-median model and the regression stands as a diagnostic.`;
  return {
    n: token.length,
    r_squared: Math.round(rSquared * 10000) / 10000,
    coefficients: beta.map((v) => Math.round(v * 10000) / 10000) as [number, number, number, number, number],
    median_growth_pct: Math.round(medianGrowthPct * 100) / 100,
    median_age_years: Math.round(medianAgeYears * 100) / 100,
    usable,
    reason,
  };
}

/**
 * Each category's calibration for the regression: the median of (log market
 * cap minus the regression's prediction) over that category's token
 * protocols, shrunk toward zero as n/(n+3), so a category with few samples
 * barely moves the prediction. Categories with fewer than 3 token protocols
 * get no calibration. Only used when the fit is usable.
 */
export function categoryResiduals(snapshot: Snapshot, fit: RegressionFit): Record<string, number> {
  const byCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const row = regressionRow(p, snapshot.as_of, fit.median_growth_pct, fit.median_age_years);
    const pred = row.reduce((a, v, j) => a + v * fit.coefficients[j]!, 0);
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(Math.log(p.mcap_usd) - pred);
    byCategory.set(key, list);
  }
  const out: Record<string, number> = {};
  for (const [cat, list] of byCategory) {
    out[cat] = list.length >= 3 ? Math.round(((median(list) ?? 0) * list.length) / (list.length + 3) * 10000) / 10000 : 0;
  }
  return out;
}

/** What the fitted regression alone would price a protocol at, a diagnostic. */
export function regressionValue(p: SnapshotProtocol, asOf: string, fit: RegressionFit, residuals: Record<string, number>, model: ModelConstants = MODEL): number {
  const row = regressionRow(p, asOf, fit.median_growth_pct, fit.median_age_years);
  let logValue = row.reduce((a, v, j) => a + v * fit.coefficients[j]!, 0);
  logValue += residuals[p.category ?? 'Uncategorised'] ?? 0;
  return Math.min(model.implied_cap_usd, Math.max(1, Math.round(Math.exp(logValue))));
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker is a pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol may join the early radar: pre-token, not an exchange, not versioned. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/**
 * The market-cap-to-TVL ratio each category earns, taken from the protocols in
 * it that already have a token. Categories with too few token protocols fall
 * back to the global median. Every ratio is clamped so one outlier cannot set
 * a price for a whole category.
 */
export function categoryRatios(snapshot: Snapshot, model: ModelConstants = MODEL): Record<string, number> {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = p.mcap_usd / p.tvl_usd;
    all.push(r);
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(r);
    byCategory.set(key, list);
  }
  const global = median(all) ?? model.ratio_fallback;
  const clamp = (v: number): number => Math.min(model.ratio_max, Math.max(model.ratio_min, v));
  const out: Record<string, number> = {};
  for (const [cat, list] of byCategory) {
    const m = list.length >= model.min_category_samples ? median(list) : null;
    out[cat] = Math.round(clamp(m ?? global) * 10000) / 10000;
  }
  return out;
}

/**
 * Each category's momentum: the median 7-day TVL change of the protocols in
 * it that already have a token. Categories with too few token protocols fall
 * back to the median across all token protocols. Clamped so one hot week
 * cannot set a price for a whole category.
 */
export function categoryMomentum(snapshot: Snapshot, model: ModelConstants = MODEL): Record<string, number> {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d)) continue;
    all.push(p.change_7d);
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(p.change_7d);
    byCategory.set(key, list);
  }
  const global = median(all) ?? 0;
  const clamp = (v: number): number => Math.min(model.momentum_cap, Math.max(model.momentum_floor, v));
  const out: Record<string, number> = {};
  for (const [cat, list] of byCategory) {
    const m = list.length >= model.min_category_samples ? median(list) : null;
    out[cat] = Math.round(clamp(m ?? global) * 100) / 100;
  }
  return out;
}

/** TVL with diminishing returns, so the board is not just TVL order. */
export function sizeValue(tvlUsd: number, model: ModelConstants = MODEL): number {
  return Math.pow(Math.max(1, tvlUsd), model.size_exponent) * Math.pow(model.size_anchor_usd, 1 - model.size_exponent);
}

/** The implied value one protocol gets, with the model's working shown. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  ratios: Record<string, number>,
  momentum: Record<string, number>,
  model: ModelConstants = MODEL,
): {
  implied: number;
  ratio: number;
  size: number;
  growthPct: number;
  growthMult: number;
  momentumPct: number;
  momentumMult: number;
  maturityMult: number;
  chainFactor: number;
  ageYears: number;
  age: number | null;
} {
  const key = p.category ?? 'Uncategorised';
  const ratio = ratios[key] ?? ratios['__global__'] ?? model.ratio_fallback;
  const size = sizeValue(p.tvl_usd, model);
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? model.unknown_age_years : Math.min(age / 365, model.maturity_years);
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const momentumPct = momentum[key] ?? 0;
  const momentumMult = 1 + (momentumPct / 100) * model.momentum_weight;
  const maturityMult = model.maturity_floor + model.maturity_range * (Math.log(1 + ageYears) / Math.log(1 + model.maturity_years));
  const chainFactor = 1 + model.chain_step * Math.min(Math.max(p.chains.length - 1, 0), model.chain_max_steps);
  const implied = Math.min(
    model.implied_cap_usd,
    Math.max(1, Math.round(size * ratio * growthMult * momentumMult * maturityMult * chainFactor)),
  );
  return { implied, ratio, size, growthPct, growthMult, momentumPct, momentumMult, maturityMult, chainFactor, ageYears, age };
}

/**
 * The fitted regression's scoring of one protocol, written in the same
 * factor form as impliedValue so the two models compare directly: the
 * regression's log-linear terms become multipliers that multiply to the
 * regression's prediction. Only used when the fit clears its bar.
 */
export function regressionBreakdown(
  p: SnapshotProtocol,
  asOf: string,
  fit: RegressionFit,
  residuals: Record<string, number>,
  model: ModelConstants = MODEL,
): {
  implied: number;
  ratio: number;
  size: number;
  growthPct: number;
  growthMult: number;
  momentumPct: number;
  momentumMult: number;
  maturityMult: number;
  chainFactor: number;
  ageYears: number;
  age: number | null;
} {
  const [intercept, bTvl, bGrowth, bAge, bChains] = fit.coefficients;
  const row = regressionRow(p, asOf, fit.median_growth_pct, fit.median_age_years);
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? fit.median_age_years : age / 365;
  const size = Math.exp(intercept + bTvl * row[1]);
  const ratio = Math.exp(residuals[p.category ?? 'Uncategorised'] ?? 0);
  const growthPct = Math.round(row[2] * 100 * 100) / 100;
  const growthMult = Math.exp(bGrowth * row[2]);
  const maturityMult = Math.exp(bAge * row[3]);
  const chainFactor = Math.exp(bChains * row[4]);
  const implied = Math.min(
    model.implied_cap_usd,
    Math.max(1, Math.round(size * ratio * growthMult * maturityMult * chainFactor)),
  );
  return { implied, ratio, size, growthPct, growthMult, momentumPct: 0, momentumMult: 1, maturityMult, chainFactor, ageYears, age };
}

/** A deterministic pick from a list, keyed by a string, so runs agree byte for byte. */
function pick<T>(list: readonly T[], key: string): T {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[Math.abs(h) % list.length]!;
}

/** Approximate gas for one simple transaction on a chain, in dollars. */
const GAS_USD: Record<string, number> = {
  Ethereum: 6, Arbitrum: 0.3, Base: 0.15, Optimism: 0.25, Polygon: 0.05, Solana: 0.01,
  BSC: 0.15, Avalanche: 0.3, 'zkSync Era': 0.25, Linea: 0.2, Scroll: 0.2, Sui: 0.02,
  Aptos: 0.01, TON: 0.05, Tron: 1.5, NEAR: 0.01, Fantom: 0.05, Sonic: 0.05,
  Berachain: 0.05, Unichain: 0.15, 'World Chain': 0.1, Mantle: 0.1, Mode: 0.1,
  Blast: 0.2, Starknet: 0.3, Sei: 0.02, Injective: 0.01, Cosmos: 0.05,
  Monad: 0.05, 'Hyperliquid L1': 0.02, Bitcoin: 2, 'Robinhood Chain': 0.1, Plasma: 0.05,
  Gnosis: 0.05, Celo: 0.02, Kava: 0.1, 'BNB Chain': 0.15, ArbitrumNova: 0.1,
  Binance: 0.15, Stellar: 0.01, Ripple: 0.01, Flare: 0.05, Algorand: 0.01,
  Bittensor: 0.05, Ink: 0.1, Pharos: 0.05, BSquared: 0.1, Arc: 0.1, Noble: 0.02,
  Mezo: 0.05, Tempo: 0.05, Stable: 0.02, XION: 0.02, RISE: 0.05, Provenance: 0.05,
  RSK: 0.05, Endurance: 0.05, Proton: 0.02, Ronin: 0.05, Morph: 0.1, WEMIX: 0.05,
  Qubic: 0.02, 'Reya Network': 0.1, Canton: 0.05, Strato: 0.05, 'Bifrost Network': 0.05,
  Fluent: 0.05, Cronos: 0.05, Stacks: 0.05, 'Plume Mainnet': 0.05, Mixin: 0.02,
  XDC: 0.02, ZIGChain: 0.05, Chiliz: 0.05, Klaytn: 0.05,
};

function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 1;
}

function fmtGas(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/**
 * The capital a farm should start with, from the primary chain's gas: on
 * cheap chains a small position is fine, where Ethereum gas dominates the
 * position must be a few hundred dollars or the fees eat it. The range
 * always contains the position size, so the plan never contradicts itself.
 */
function capitalRange(p: SnapshotProtocol): string {
  const gas = p.chains.length > 0 ? gasFor(p.chains[0]!) : 1;
  const capital = capitalFor(p);
  let low: number;
  let high: number;
  if (gas >= 2) {
    low = 200;
    high = 500;
  } else if (gas < 0.1) {
    low = 25;
    high = 100;
  } else {
    low = 50;
    high = 200;
  }
  low = Math.min(low, capital);
  high = Math.max(high, capital);
  return `$${low} to $${high}`;
}

/** How long to hold, from the protocol's age: younger protocols need longer. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category group a protocol's farm plan is built from. */
function groupOf(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lend';
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('leveraged')) return 'yield';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('stak') || c.includes('restak')) return 'stake';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('synthetic')) return 'trade';
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager')) return 'vault';
  if (c.includes('rwa') || c.includes('reserve')) return 'rwa';
  if (c.includes('stable')) return 'stable';
  if (c.includes('prediction')) return 'predict';
  if (c.includes('insurance')) return 'insure';
  if (c.includes('payment') || c.includes('card')) return 'pay';
  if (c.includes('chain')) return 'chain';
  return 'deposit';
}

/** The fee asset a chain needs in the wallet before anything else. */
function feeAsset(chain: string): string {
  const m: Record<string, string> = {
    Ethereum: 'ETH', Arbitrum: 'ETH', Base: 'ETH', Optimism: 'ETH', Linea: 'ETH',
    Scroll: 'ETH', 'zkSync Era': 'ETH', Unichain: 'ETH', 'World Chain': 'ETH',
    Solana: 'SOL', BSC: 'BNB', 'BNB Chain': 'BNB', Avalanche: 'AVAX', Polygon: 'POL',
    Sui: 'SUI', Aptos: 'APT', TON: 'TON', Tron: 'TRX', NEAR: 'NEAR', Fantom: 'FTM',
    Sonic: 'S', Berachain: 'BERA', Sei: 'SEI', Injective: 'INJ', Cosmos: 'ATOM',
    Monad: 'MON', 'Hyperliquid L1': 'HYPE', Bitcoin: 'BTC', Plasma: 'XPL', Starknet: 'STRK',
    Binance: 'BNB', Stellar: 'XLM', Ripple: 'XRP', Flare: 'FLR', Algorand: 'ALGO',
    Bittensor: 'TAO', Ink: 'ETH', Pharos: 'PHRS', BSquared: 'BTC', Arc: 'USDC',
    Noble: 'USDC', Mezo: 'BTC', Tempo: 'USD', Stable: 'USDT', XION: 'XION',
    RISE: 'ETH', Provenance: 'HASH', RSK: 'RBTC', Endurance: 'ACE', Proton: 'XPR',
    Ronin: 'RON', Morph: 'ETH', WEMIX: 'WEMIX', Qubic: 'QUBIC', 'Reya Network': 'ETH',
    Canton: 'CC', Strato: 'STO', 'Bifrost Network': 'BNC', Fluent: 'ETH',
    Cronos: 'CRO', Stacks: 'STX', 'Plume Mainnet': 'PLUME', Mixin: 'XIN',
    XDC: 'XDC', ZIGChain: 'ZIG', Chiliz: 'CHZ', Klaytn: 'KLAY',
  };
  return m[chain] ?? 'the chain’s own gas token';
}

/**
 * The main action for a group: what to do, with the protocol's name, chain and
 * capital, and a concrete detail that only fits that kind of protocol.
 */
const ACTIONS: Record<string, readonly string[]> = {
  lend: [
    'Supply {CAP} of USDC to {NAME} on {CHAIN} and borrow 30 to 50% of it in the same session, so both sides of the loan book show activity',
    'Lend {CAP} of USDC through {NAME} on {CHAIN}, then borrow a third of it and repay it a week later to show a full borrow cycle',
    'Deposit {CAP} of USDC into {NAME} on {CHAIN} as supply, use a small borrow against it for a swap, and repay the borrow within a week',
    'Open a supply position of {CAP} of USDC on {NAME} on {CHAIN} and take a borrow of 40% of it, keeping the health factor above 2',
  ],
  yield: [
    'Provide {CAP} of liquidity to the deepest pool on {NAME} on {CHAIN}, in the USDC pair, and keep the LP position open',
    'Add {CAP} of liquidity to {NAME} on {CHAIN} in its highest-volume pool and stake the LP tokens if the app offers it',
    'Put {CAP} into the largest vault on {NAME} on {CHAIN} and leave the position to compound',
    'Deposit {CAP} of USDC into {NAME} on {CHAIN} and, where the app shows a gauge, lock the receipt for the longest boost',
  ],
  bridge: [
    'Bridge {CAP} of USDC to {CHAIN} through {NAME}, then use the bridged funds in an app on the far side the same week',
    'Move {CAP} of USDC across to {CHAIN} with {NAME} and spend it on a swap or a deposit there, so the route sees real use',
    'Send {CAP} of USDC to {CHAIN} through {NAME}, keep the receipt, and use the funds in the destination app within three days',
  ],
  stake: [
    'Stake {CAP} of the chain asset through {NAME} on {CHAIN}, hold the staking receipt, and restake the rewards instead of claiming them',
    'Deposit {CAP} to stake through {NAME} on {CHAIN} and keep the liquid staking receipt in the same wallet for the full term',
    'Stake {CAP} with {NAME} on {CHAIN}, choose the longest lock the app offers, and leave the stake untouched',
  ],
  trade: [
    'Deposit {CAP} of USDC as margin on {NAME} on {CHAIN}, open one small hedged trade with a stop, and close it the same day',
    'Fund {NAME} on {CHAIN} with {CAP} of USDC, place one small position at 2x or less, and set a stop before you leave the screen',
    'Put {CAP} of USDC into {NAME} on {CHAIN} as margin and trade once a week in small size, never risking more than 5% of it',
  ],
  vault: [
    'Deposit {CAP} into the largest vault {NAME} runs on {CHAIN} and keep the vault shares for the whole season',
    'Allocate {CAP} to a {NAME} vault on {CHAIN} with the highest TVL, hold the shares, and top it up when the strategy changes',
    'Put {CAP} into {NAME} on {CHAIN}, choose the vault whose strategy you understand, and leave it to compound',
  ],
  rwa: [
    'Mint {CAP} of the yield-bearing asset {NAME} issues on {CHAIN} and hold it in your wallet for the full term',
    'Buy {CAP} of the tokenised asset {NAME} issues on {CHAIN} and keep it in the same wallet, reinvesting the yield each week',
    'Subscribe {CAP} to {NAME} on {CHAIN}, hold the receipt, and check the yield payout dates on the protocol’s own page',
  ],
  stable: [
    'Mint or deposit {CAP} of the stable asset through {NAME} on {CHAIN} and hold it, using it for one real payment a week',
    'Hold {CAP} of the stablecoin {NAME} issues on {CHAIN} and route one ordinary payment through it each week',
    'Deposit {CAP} into {NAME} on {CHAIN} and keep the stable position open while using it to pay for something real weekly',
  ],
  predict: [
    'Fund {NAME} with {CAP} and place one position on a market that settles this month, in a topic you follow',
    'Put {CAP} into one market on {NAME} that settles within 30 days and let the position run to settlement',
    'Place a {CAP} position on {NAME} in a market you follow, keep a note of the outcome, and do one market a week',
  ],
  insure: [
    'Buy {CAP} of cover from {NAME} on {CHAIN} for a position you already hold, and keep the policy active',
    'Take {CAP} of cover through {NAME} on {CHAIN} and hold it for the full farming window, renewing before it lapses',
    'Insure {CAP} of your largest on-chain position with {NAME} on {CHAIN} and keep the cover live',
  ],
  pay: [
    'Move {CAP} through {NAME} on {CHAIN} and make one real payment with it each week, for something you would buy anyway',
    'Route {CAP} through {NAME} on {CHAIN} across two or three ordinary payments in the first week',
    'Spend {CAP} via {NAME} on {CHAIN} on a real purchase and keep the receipt, then repeat weekly',
  ],
  chain: [
    'Use {CAP} across the apps {NAME} runs on {CHAIN}, starting with its largest one, and try a second app in week two',
    'Put {CAP} to work in {NAME} on {CHAIN}, use its main app every week, and try one more of its apps before the month ends',
    'Deposit {CAP} into {NAME} on {CHAIN} and use two of its apps in the first week so the account shows breadth',
  ],
  deposit: [
    'Deposit {CAP} of USDC into {NAME} on {CHAIN} and keep the position open, checking the rewards page once a week',
    'Put {CAP} of USDC to work in {NAME} on {CHAIN}, join its points programme in the app, and leave the position alone',
    'Open a {CAP} position in {NAME} on {CHAIN}, complete every task its rewards page lists, and hold it for the season',
  ],
};

/** The eligibility step: the points or rewards page, and the tasks it lists. */
const ELIGIBLE: Record<string, readonly string[]> = {
  lend: [
    'Open the points or rewards page inside the {NAME} app and complete every task it lists, such as supplying, borrowing and voting',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with a supply and a borrow',
  ],
  yield: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as adding liquidity and staking the receipt',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with the pool it highlights',
  ],
  bridge: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as repeat transfers and destination use',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with a second small transfer',
  ],
  stake: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as staking and restaking rewards',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with restaking the first reward',
  ],
  trade: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as funding margin and placing a trade',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with one small trade',
  ],
  vault: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as depositing and holding vault shares',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with the vault it highlights',
  ],
  rwa: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as minting and holding the asset',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with the yield-bearing mint',
  ],
  stable: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as holding and spending the stable asset',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with one real payment',
  ],
  predict: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as placing and settling a position',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with one market that settles soon',
  ],
  insure: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as buying and holding cover',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with one active policy',
  ],
  pay: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as repeat real payments',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with one ordinary payment',
  ],
  chain: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as using two of its apps',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with its main app',
  ],
  deposit: [
    'Open the points or rewards page inside the {NAME} app and complete the tasks it lists, such as depositing and voting',
    'Check the {NAME} app for a points programme and do the tasks it names, starting with the first deposit task',
  ],
};

/** The weekly habit, varied by group. */
const WEEKLY: Record<string, readonly string[]> = {
  lend: [
    'Make one lending action each week, such as a supply top-up, a borrow or a repayment',
    'Touch the position once a week: add a little supply, borrow a little, or vote in governance',
  ],
  yield: [
    'Make one pool action each week, such as adding liquidity, claiming fees or rebalancing a little',
    'Touch the pool once a week: top up the liquidity, claim fees, or move it to the deepest pool',
  ],
  bridge: [
    'Bridge a small amount each week so the route sees repeat use, not one transfer',
    'Use the bridge once a week for a small transfer and spend the funds on the far side',
  ],
  stake: [
    'Check the stake once a week and restake any rewards instead of withdrawing them',
    'Restake rewards each week so the stake grows and the activity stays visible',
  ],
  trade: [
    'Place one small trade a week and close it the same day, keeping the margin funded',
    'Trade once a week in small size and never let the margin account sit empty',
  ],
  vault: [
    'Check the vault once a week and top it up a little when the strategy changes',
    'Do one vault action a week, such as a top-up or a rebalance, and keep the shares',
  ],
  rwa: [
    'Check the asset once a week and reinvest the yield instead of withdrawing it',
    'Reinvest the yield each week so the holding grows and the activity stays visible',
  ],
  stable: [
    'Use the stable asset once a week, such as a payment or a deposit, so it moves',
    'Make one stablecoin action a week so the holding shows real use, not a parked balance',
  ],
  predict: [
    'Place one small position a week in markets you follow, and let each settle',
    'Make one market position a week on {NAME} and keep a note of every outcome',
  ],
  insure: [
    'Check the policy once a week and keep it active for the whole farming window',
    'Review the cover once a week and renew it before it lapses',
  ],
  pay: [
    'Make one real payment a week through {NAME} so the account shows steady use',
    'Use {NAME} for one ordinary payment each week and keep the receipts',
  ],
  chain: [
    'Use one app on {NAME} each week so the account shows steady activity',
    'Try a different app on {NAME} each week and keep a note of what you used',
  ],
  deposit: [
    'Make one qualifying action each week, such as a deposit, a swap or a vote',
    'Touch the position once a week: add a little, swap a little, or vote in governance',
  ],
};

/** The setup step, naming the chain's fee asset and the capital range. */
const SETUP: readonly string[] = [
  'Open a fresh wallet that holds only the funds you plan to farm, fund it with {MINCAP} of capital and put {CAP} in the position, plus about {GAS} of {ASSET} for fees on {CHAIN}, and keep its seed phrase offline.',
  'Set up a separate wallet for this farm alone, fund it with {MINCAP} of capital, put {CAP} in the first position and a little {ASSET} aside for {CHAIN} fees, and store the seed phrase off the computer.',
  'Use a dedicated wallet for {NAME}, fund it with {MINCAP} of capital, place {CAP} in the position with {GAS} of {ASSET} to pay {CHAIN} gas, and keep the seed phrase offline.',
  'Create a new wallet for this farm, move {MINCAP} of capital into it, put {CAP} in the position with enough of {ASSET} to cover a few {CHAIN} transactions, and write the seed phrase down on paper.',
];

/** The exit step: claim only through the official app, then unwind. */
const EXIT: readonly string[] = [
  'When a claim opens, use only the link on the protocol’s own site or app, claim, then unwind the position in reverse order and keep the receipt.',
  'Before you withdraw, open the protocol’s own points or rewards page, claim only from the link it publishes, and exit the position the same way you entered it.',
  'Check the protocol’s own rewards page before you move funds, claim only through its official app, and never pay anyone to claim for you.',
];

/**
 * The one risk that matters most for a group, in the protocol's own terms:
 * what can actually go wrong with this kind of farm, not a generic warning.
 */
const RISK: Record<string, readonly string[]> = {
  lend: [
    'Biggest risk: smart-contract risk in the lending pool, a bug could freeze the funds you supplied, so never farm with money you cannot afford to lose.',
    'Biggest risk: a lending pool exploit could lock supplied funds for months, so keep the position small and in one wallet.',
  ],
  yield: [
    'Biggest risk: impermanent loss in the pool plus points dilution if too many farmers join the same pool.',
    'Biggest risk: the pool can lose value against the assets you supplied, and the points can be diluted as more farmers arrive.',
  ],
  bridge: [
    'Biggest risk: a bridge exploit could strand the funds mid-transfer, so only move amounts you can afford to have delayed.',
    'Biggest risk: the bridge can pause withdrawals after an exploit, so keep each transfer small.',
  ],
  stake: [
    'Biggest risk: slashing or an unstaking lock can keep funds tied up for weeks after you want them back.',
    'Biggest risk: the stake can be locked through an unbonding period, so do not stake funds you may need soon.',
  ],
  trade: [
    'Biggest risk: liquidation, a sharp move can wipe a leveraged position in minutes, so keep size small and stops set.',
    'Biggest risk: leverage cuts both ways, so never risk more than 5% of the position on one trade.',
  ],
  vault: [
    'Biggest risk: strategy risk, the vault can change strategy and underperform, so check the strategy page each week.',
    'Biggest risk: the vault strategy can be changed by its managers, so read the strategy before you deposit.',
  ],
  rwa: [
    'Biggest risk: issuer and counterparty risk, the tokenised asset depends on the issuer staying solvent.',
    'Biggest risk: the issuer behind the asset could fail, so check who holds the reserves before you mint.',
  ],
  stable: [
    'Biggest risk: depeg risk, the stable asset can slip below its peg and stay there for days.',
    'Biggest risk: the peg can break in a market panic, so never hold more of the stable asset than you need.',
  ],
  predict: [
    'Biggest risk: resolution risk, a market can settle on an outcome you did not expect.',
    'Biggest risk: the market can resolve against you on a technicality, so only bet on outcomes you can verify.',
  ],
  insure: [
    'Biggest risk: claim risk, a claim can be denied if the policy terms are not met.',
    'Biggest risk: the policy may not pay out if the loss falls outside its terms, so read them before you buy.',
  ],
  pay: [
    'Biggest risk: counterparty risk on the payment route, a failed payment can take days to reverse.',
    'Biggest risk: the payment can fail mid-route, so keep each payment small and keep the receipts.',
  ],
  chain: [
    'Biggest risk: smart-contract risk across several apps at once, one bad app can put the whole wallet at risk.',
    'Biggest risk: using many apps multiplies the smart-contract risk, so keep the farm in one dedicated wallet.',
  ],
  deposit: [
    'Biggest risk: smart-contract risk plus points dilution as more farmers join the same programme.',
    'Biggest risk: the points can be diluted and the contract can be exploited, so keep the position modest.',
  ],
};

/**
 * A protocol's farm plan: five steps, six when it runs on more than one
 * chain. Every step is built from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names, and the wording
 * varies by a deterministic hash of the slug so rows do not read as copy-paste.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const second = p.chains.length > 1 ? p.chains[1]! : null;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const gas = fmtGas(gasFor(chain));
  const gas2 = second === null ? '' : fmtGas(gasFor(second));
  const asset = feeAsset(chain);
  const group = groupOf(p);
  const sub = (s: string): string =>
    s
      .replaceAll('{CAP}', `$${capital}`)
      .replaceAll('{MINCAP}', capitalRange(p))
      .replaceAll('{NAME}', p.name)
      .replaceAll('{CHAIN}', chain)
      .replaceAll('{GAS}', gas)
      .replaceAll('{ASSET}', asset);
  const setup = sub(pick(SETUP, `${p.slug}:setup`));
  const action = sub(pick(ACTIONS[group] ?? ACTIONS.deposit!, `${p.slug}:action`));
  const eligible = sub(pick(ELIGIBLE[group] ?? ELIGIBLE.deposit!, `${p.slug}:eligible`));
  const weekly = sub(pick(WEEKLY[group] ?? WEEKLY.deposit!, `${p.slug}:weekly`));
  const risk = sub(pick(RISK[group] ?? RISK.deposit!, `${p.slug}:risk`));
  const exit = `${sub(pick(EXIT, `${p.slug}:exit`))} ${risk}`;
  const steps: { text: string; cost: string; time: string }[] = [
    { text: setup, cost: `about ${gas} of gas on ${chain}`, time: '10 minutes' },
    { text: action, cost: `$${capital} of capital and about ${gas} of gas`, time: '15 minutes to set up' },
  ];
  if (second !== null) {
    steps.push({
      text: `Repeat the same position on ${second} with half the capital, $${Math.round(capital / 2)}, so the farm shows on two chains instead of one.`,
      cost: `about ${gas2} of gas on ${second}`,
      time: '10 minutes',
    });
  }
  steps.push(
    { text: eligible, cost: 'no fee to check the tasks', time: '10 minutes' },
    {
      text: `${weekly}, and hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `about ${gas} of gas a week, the $${capital} stays in the position`,
      time: `${weeks} weeks, at least ${hold} days`,
    },
    { text: exit, cost: `about ${gas} of gas to exit on ${chain}`, time: '15 minutes' },
  );
  return steps.map((s) => {
    const text = s.text.endsWith('.') ? s.text : `${s.text}.`;
    let out = `${text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (out.length > 600) out = `${out.slice(0, 596)}...`;
    if (out.length < 20) out = `${out} Hold the position and check the protocol’s own page.`;
    return out;
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The ranked board: the whole watchlist, plus the best early rows, to BOARD_ROWS. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): {
  board: BoardRow[];
  ratios: Record<string, number>;
  momentum: Record<string, number>;
  fit: RegressionFit;
  scoring: string;
} {
  const ratios = categoryRatios(snapshot, model);
  const momentum = categoryMomentum(snapshot, model);
  const fit = fitRegression(snapshot);
  const residuals = categoryResiduals(snapshot, fit);
  const scoring = fit.usable
    ? `radar-4 regression: log market cap fitted at runtime on ${fit.n} token protocols (R² ${fit.r_squared}), scoring the board`
    : `radar-3 category-median: the runtime regression explained only ${(fit.r_squared * 100).toFixed(1)}% of log market cap (R² ${fit.r_squared} on ${fit.n} token protocols), so it stands as a diagnostic and the category-median model scores`;
  // The scorer: the fitted regression when it cleared its bar, else the
  // category-median model. On this snapshot the fit fails its bar, so the
  // board scores with radar-3 and every row still carries the regression's
  // own prediction as a diagnostic.
  const score = (p: SnapshotProtocol) =>
    fit.usable
      ? regressionBreakdown(p, snapshot.as_of, fit, residuals, model)
      : impliedValue(p, snapshot.as_of, ratios, momentum, model);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by
  // implied value. Never a replacement for a watchlist row, and never a
  // wrapped or bridged product above the floor: those record no token in the
  // snapshot, but their token already trades, so they are not launches.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, value: score(p).implied }))
    .sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, BOARD_ROWS - chosen.size);
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => {
    const v = score(p);
    const reg = regressionValue(p, snapshot.as_of, fit, residuals, model);
    return { p, v, reg };
  });
  scored.sort(
    (a, b) =>
      b.v.implied - a.v.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    on_watchlist: snapshot.watchlist.includes(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      category_ratio: Math.round(s.v.ratio * 10000) / 10000,
      size_value_usd: Math.round(s.v.size),
      growth_pct: Math.round(s.v.growthPct * 100) / 100,
      growth_multiplier: Math.round(s.v.growthMult * 10000) / 10000,
      momentum_pct: Math.round(s.v.momentumPct * 100) / 100,
      momentum_multiplier: Math.round(s.v.momentumMult * 10000) / 10000,
      maturity_multiplier: Math.round(s.v.maturityMult * 10000) / 10000,
      chain_factor: Math.round(s.v.chainFactor * 10000) / 10000,
      age_years: Math.round(s.v.ageYears * 100) / 100,
      regression_value_usd: s.reg,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
  return { board, ratios, momentum, fit, scoring };
}

/** The board's ten fastest growers over seven days, for the dashboard's Top movers. */
export function topMovers(board: BoardRow[]): MoverRow[] {
  return board
    .filter((r) => typeof r.change_7d === 'number' && Number.isFinite(r.change_7d))
    .sort((a, b) => (b.change_7d as number) - (a.change_7d as number) || b.tvl_usd - a.tvl_usd)
    .slice(0, 10)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.category,
      change_7d: r.change_7d as number,
      tvl_usd: r.tvl_usd,
      implied_value_usd: r.implied_value_usd,
      rank: r.rank,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, ratios, momentum, fit, scoring } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source.replace(/https?:\/\/\S+/g, 'DefiLlama public API'),
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    scoring,
    regression: fit,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    category_ratios: ratios,
    category_momentum: momentum,
    rows: board,
    live,
    movers: topMovers(board),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
