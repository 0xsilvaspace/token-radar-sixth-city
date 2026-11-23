// Token launch radar, model version radar-2.
//
// One sealed snapshot in, one ranked board out. The board ranks protocols that
// record no token (no market cap, no CoinGecko id, no symbol) by an implied
// value: what a token would be worth if the protocol's record stayed as it is.
// The value is the entry's own claim, never make.fun's, and it never predicts
// whether or when a token is issued.
//
// The model, per protocol:
//
//   ratio        = the median market-cap-to-TVL ratio of the protocols in the
//                  same category that already have a token (at least 3 of
//                  them), else the median across all token protocols;
//                  clamped to [0.01, 1.5] so one outlier cannot set a price.
//   growth       = the protocol's 7-day TVL change, clamped to [-20, +50] %
//   growthMult   = 1 + growth / 100 * 0.5
//   ageYears     = days since listed_at / 365, capped at 3 years; a protocol
//                  with no listed date is treated as 1 year old
//   maturityMult = 0.6 + ageYears / 3 * 0.4
//   implied      = TVL * ratio * growthMult * maturityMult, capped at $50B
//
// No protocol name is ever special-cased: the same function scores every row.
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
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_years: number;
  unknown_age_years: number;
  implied_cap_usd: number;
}

export const MODEL: ModelConstants = {
  ratio_min: 0.01,
  ratio_max: 1.5,
  ratio_fallback: 0.2138,
  min_category_samples: 3,
  growth_weight: 0.5,
  growth_floor: -20,
  growth_cap: 50,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_years: 3,
  unknown_age_years: 1,
  implied_cap_usd: 50_000_000_000,
};

export const MODEL_VERSION = 'radar-2';

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
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_years: number;
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

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_ratios: Record<string, number>;
  rows: RadarRow[];
  live: LiveRow[];
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

/** The implied value one protocol gets, with the model's working shown. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  ratios: Record<string, number>,
  model: ModelConstants = MODEL,
): { implied: number; ratio: number; growthPct: number; growthMult: number; maturityMult: number; ageYears: number; age: number | null } {
  const ratio = ratios[p.category ?? 'Uncategorised'] ?? ratios['__global__'] ?? model.ratio_fallback;
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? model.unknown_age_years : Math.min(age / 365, model.maturity_years);
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult = model.maturity_floor + (ageYears / model.maturity_years) * model.maturity_range;
  const implied = Math.min(
    model.implied_cap_usd,
    Math.max(1, Math.round(p.tvl_usd * ratio * growthMult * maturityMult)),
  );
  return { implied, ratio, growthPct, growthMult, maturityMult, ageYears, age };
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

/** The main action for a group, with three wordings each so rows do not read alike. */
const ACTIONS: Record<string, readonly string[]> = {
  lend: [
    'Supply {CAP} of USDC to {NAME} on {CHAIN} and keep the loan book position open',
    'Lend {CAP} of USDC through {NAME} on {CHAIN}, leaving the supply position untouched',
    'Deposit {CAP} of USDC into {NAME} on {CHAIN} and let the lending position earn',
  ],
  yield: [
    'Provide {CAP} of liquidity to {NAME} on {CHAIN}, in its deepest pool, and keep the position open',
    'Add {CAP} of liquidity to {NAME} on {CHAIN} and leave it staked in the pool',
    'Put {CAP} into {NAME} on {CHAIN} as liquidity and hold the LP position',
  ],
  bridge: [
    'Bridge {CAP} of USDC to {CHAIN} through {NAME} and use the bridged funds in its app',
    'Move {CAP} of USDC across to {CHAIN} with {NAME} and keep the funds working there',
    'Send {CAP} of USDC to {CHAIN} through {NAME} and use the destination app the same week',
  ],
  stake: [
    'Stake {CAP} of the chain asset through {NAME} on {CHAIN} and keep the receipt token',
    'Deposit {CAP} to stake through {NAME} on {CHAIN} and hold the staking receipt',
    'Stake {CAP} with {NAME} on {CHAIN} and leave the stake locked for the full term',
  ],
  trade: [
    'Deposit {CAP} of USDC as margin on {NAME} on {CHAIN} and open one small hedged trade',
    'Fund {NAME} on {CHAIN} with {CAP} of USDC and place one small position with a stop',
    'Put {CAP} of USDC into {NAME} on {CHAIN} as margin and trade once a week in small size',
  ],
  vault: [
    'Deposit {CAP} into a {NAME} vault on {CHAIN} and keep the vault shares',
    'Allocate {CAP} to a {NAME} vault on {CHAIN} and hold the shares for the season',
    'Put {CAP} into {NAME} on {CHAIN} and leave the vault position to compound',
  ],
  rwa: [
    'Mint {CAP} of the yield-bearing asset from {NAME} on {CHAIN} and hold it',
    'Buy {CAP} of the tokenised asset {NAME} issues on {CHAIN} and keep it in your wallet',
    'Subscribe {CAP} to {NAME} on {CHAIN} and hold the receipt for the full term',
  ],
  stable: [
    'Mint or deposit {CAP} of the stable asset through {NAME} on {CHAIN} and hold it',
    'Hold {CAP} of the stablecoin {NAME} issues on {CHAIN} in your wallet',
    'Deposit {CAP} into {NAME} on {CHAIN} and keep the stable position open',
  ],
  predict: [
    'Fund {NAME} with {CAP} and place one position on a market that settles this month',
    'Put {CAP} into one market on {NAME} and let the position run to settlement',
    'Place a {CAP} position on {NAME} in a market you follow, then leave it to settle',
  ],
  insure: [
    'Buy {CAP} of cover from {NAME} on {CHAIN} and keep the policy active',
    'Take {CAP} of cover through {NAME} on {CHAIN} and hold it for the full term',
    'Insure {CAP} of your position with {NAME} on {CHAIN} and keep the cover live',
  ],
  pay: [
    'Move {CAP} through {NAME} on {CHAIN} and make one real payment with it each week',
    'Route {CAP} through {NAME} on {CHAIN} and use it for a payment you would make anyway',
    'Spend {CAP} via {NAME} on {CHAIN} across two or three ordinary payments',
  ],
  chain: [
    'Use {CAP} across the apps {NAME} runs on {CHAIN}, starting with its largest one',
    'Put {CAP} to work in {NAME} on {CHAIN} and try two of its apps in the first week',
    'Deposit {CAP} into {NAME} on {CHAIN} and use its main app every week',
  ],
  deposit: [
    'Deposit {CAP} of USDC into {NAME} on {CHAIN} and keep the position open',
    'Put {CAP} of USDC to work in {NAME} on {CHAIN} and leave the position alone',
    'Open a {CAP} position in {NAME} on {CHAIN} and hold it for the season',
  ],
};

/** The weekly habit, varied by group. */
const WEEKLY: Record<string, readonly string[]> = {
  lend: [
    'Make one qualifying action each week, such as a supply top-up, a borrow or a repayment',
    'Touch the position once a week: add a little supply, borrow a little, or vote in governance',
    'Do one lending action a week on {NAME} so the activity shows in more than one snapshot',
  ],
  yield: [
    'Make one qualifying action each week, such as adding liquidity, claiming rewards or swapping',
    'Touch the pool once a week: top up the liquidity, claim fees, or rebalance a little',
    'Do one pool action a week on {NAME} so the activity shows in more than one snapshot',
  ],
  bridge: [
    'Bridge a small amount each week so the route sees repeat use, not one transfer',
    'Use the bridge once a week for a small transfer and spend the funds on the far side',
    'Make one small bridge a week through {NAME} and use the funds where they land',
  ],
  stake: [
    'Check the stake once a week and restake any rewards instead of withdrawing them',
    'Restake rewards each week so the stake grows and the activity stays visible',
    'Do one staking action a week, such as restaking rewards or adding a little more',
  ],
  trade: [
    'Place one small trade a week and close it the same day, keeping the margin funded',
    'Trade once a week in small size and never let the margin account sit empty',
    'Make one small trade a week on {NAME} and keep a record of each fill',
  ],
  vault: [
    'Check the vault once a week and top it up a little when the strategy changes',
    'Do one vault action a week, such as a top-up or a rebalance, and keep the shares',
    'Touch the vault once a week so the position shows steady use over time',
  ],
  rwa: [
    'Check the asset once a week and reinvest the yield instead of withdrawing it',
    'Reinvest the yield each week so the holding grows and the activity stays visible',
    'Do one action a week on {NAME}, such as reinvesting yield or adding a little more',
  ],
  stable: [
    'Use the stable asset once a week, such as a payment or a deposit, so it moves',
    'Make one stablecoin action a week so the holding shows real use, not a parked balance',
    'Touch the stable position once a week: pay, deposit or swap a small amount',
  ],
  predict: [
    'Place one small position a week in markets you follow, and let each settle',
    'Make one market position a week on {NAME} and keep a note of every outcome',
    'Trade one market a week in small size and never chase a loss with a bigger one',
  ],
  insure: [
    'Check the policy once a week and keep it active for the whole farming window',
    'Review the cover once a week and renew it before it lapses',
    'Keep the policy live and check its terms once a week while you farm',
  ],
  pay: [
    'Make one real payment a week through {NAME} so the account shows steady use',
    'Use {NAME} for one ordinary payment each week and keep the receipts',
    'Pay once a week through {NAME} for something you would buy anyway',
  ],
  chain: [
    'Use one app on {NAME} each week so the account shows steady activity',
    'Try a different app on {NAME} each week and keep a note of what you used',
    'Do one on-chain action a week inside {NAME} and keep the activity regular',
  ],
  deposit: [
    'Make one qualifying action each week, such as a deposit, a swap or a vote',
    'Touch the position once a week: add a little, swap a little, or vote in governance',
    'Do one action a week on {NAME} so the activity shows in more than one snapshot',
  ],
};

/**
 * A protocol's farm plan: five steps, each an action with a cost and a time.
 * Every step is built from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names, and the wording varies by a
 * deterministic hash of the slug so rows do not read as copy-paste.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = fmtGas(gasFor(chain));
  const group = groupOf(p);
  const action = pick(ACTIONS[group] ?? ACTIONS.deposit!, `${p.slug}:action`)
    .replaceAll('{CAP}', `$${capital}`)
    .replaceAll('{NAME}', p.name)
    .replaceAll('{CHAIN}', chain);
  const weekly = pick(WEEKLY[group] ?? WEEKLY.deposit!, `${p.slug}:weekly`)
    .replaceAll('{NAME}', p.name);
  const setup = pick(
    [
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      'Set up a separate wallet for this farm alone, fund it with exactly what you plan to use, and store the seed phrase offline.',
      'Open a dedicated wallet for {NAME}, fund it with the farming capital only, and keep the seed phrase off the computer.',
    ],
    `${p.slug}:setup`,
  ).replaceAll('{NAME}', p.name);
  const claim = pick(
    [
      'Before you withdraw, open the protocol’s own points or rewards page and claim only from the link it publishes.',
      'When a claim opens, use only the link on the protocol’s own site or app; never pay anyone to claim for you.',
      'Check the protocol’s own rewards page before you move funds, and claim only through its official app.',
    ],
    `${p.slug}:claim`,
  );
  const log = pick(
    [
      'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      'Keep a farm log with the wallet address, the dates and each transaction hash, so the position is easy to unwind.',
      'Record the wallet, the amounts and the dates in one log, so you can prove the activity or exit cleanly.',
    ],
    `${p.slug}:log`,
  );
  const steps = [
    { text: setup, cost: `under ${gas} of gas for the first transaction`, time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about ${gas} of gas`, time: '15 minutes to set up' },
    { text: weekly, cost: `about ${gas} of gas a week`, time: '10 minutes a week' },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    { text: `${claim} ${log}`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
  ];
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
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; ratios: Record<string, number> } {
  const ratios = categoryRatios(snapshot, model);
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
    .map((p) => ({ p, value: impliedValue(p, snapshot.as_of, ratios, model).implied }))
    .sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, BOARD_ROWS - chosen.size);
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, ratios, model);
    return { p, v };
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
      growth_pct: Math.round(s.v.growthPct * 100) / 100,
      growth_multiplier: Math.round(s.v.growthMult * 10000) / 10000,
      maturity_multiplier: Math.round(s.v.maturityMult * 10000) / 10000,
      age_years: Math.round(s.v.ageYears * 100) / 100,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
  return { board, ratios };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, ratios } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source.replace(/https?:\/\/\S+/g, 'DefiLlama public API'),
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    category_ratios: ratios,
    rows: board,
    live,
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
