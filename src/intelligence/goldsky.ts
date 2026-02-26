/**
 * Goldsky subgraph queries for Polymarket on-chain data.
 *
 * Polymarket's 5 public subgraphs (Polymarket's own project, no auth needed):
 *   pnl       — userPositions (realizedPnl, avgPrice, totalBought)
 *   orders    — orderFilledEvents, orderbooks, marketData
 *   positions — userBalances, conditions
 *   activity  — splits, merges, redemptions
 *   oi        — open interest per market
 *
 * All amounts are in raw USDC units (6 decimals). Divide by 1e6 for USD.
 */
import { GraphQLClient, gql } from 'graphql-request';
import { WalletStats, SmartMoneySignal } from '../types';

const PM_PROJECT = 'project_cl6mb8i9h0003e201j6li0diw';
const BASE       = `https://api.goldsky.com/api/public/${PM_PROJECT}/subgraphs`;
const SCALE      = 1e6;  // USDC decimals on Polygon

export const ENDPOINTS = {
  orders:    `${BASE}/orderbook-subgraph/0.0.1/gn`,
  positions: `${BASE}/positions-subgraph/0.0.7/gn`,
  activity:  `${BASE}/activity-subgraph/0.0.4/gn`,
  oi:        `${BASE}/oi-subgraph/0.0.6/gn`,
  pnl:       `${BASE}/pnl-subgraph/0.0.14/gn`,
};

function client(key: keyof typeof ENDPOINTS) {
  return new GraphQLClient(ENDPOINTS[key]);
}

// ── Health check — verifies all 5 subgraphs are live ─────────
export async function healthCheck(): Promise<Record<string, number | false>> {
  const metaQ = gql`{ _meta { block { number } } }`;
  const results: Record<string, number | false> = {};
  for (const key of Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]) {
    try {
      const d: any = await client(key).request(metaQ);
      results[key] = Number(d._meta?.block?.number ?? 0);
    } catch {
      results[key] = false;
    }
  }
  return results;
}

// ── Top PnL wallets ───────────────────────────────────────────
// Queries userPositions ordered by realizedPnl, aggregates by wallet address.
const TOP_PNL_QUERY = gql`
  query TopPnl($minPnl: BigDecimal!, $first: Int!) {
    userPositions(
      where:          { realizedPnl_gt: $minPnl }
      orderBy:        realizedPnl
      orderDirection: desc
      first:          $first
    ) {
      id
      user
      tokenId
      realizedPnl
      totalBought
      avgPrice
    }
  }
`;

export async function fetchTopWallets(
  minPnlUsd: number = 50_000,
  limit:     number = 200,   // fetch more, aggregate client-side
): Promise<WalletStats[]> {
  try {
    const data: any = await client('pnl').request(TOP_PNL_QUERY, {
      minPnl: minPnlUsd * SCALE,
      first:  limit,
    });

    // Aggregate by wallet address across multiple positions
    const walletMap: Record<string, { pnl: number; trades: number }> = {};
    for (const p of data.userPositions ?? []) {
      const addr = p.user?.toLowerCase() ?? p.id?.split('-')[0] ?? '';
      if (!addr) continue;
      const pnlUsd = Number(p.realizedPnl) / SCALE;
      walletMap[addr] = {
        pnl:    (walletMap[addr]?.pnl    ?? 0) + pnlUsd,
        trades: (walletMap[addr]?.trades ?? 0) + 1,
      };
    }

    return Object.entries(walletMap)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .map(([address, stats]) => ({
        address,
        win_rate:     0,          // not directly available — enriched if needed
        realized_pnl: stats.pnl,
        trade_count:  stats.trades,
        is_hft:       stats.trades > 500,
      }))
      .filter(w => !w.is_hft);
  } catch (err: any) {
    console.error('⚠️  Goldsky PNL query failed:', err.message);
    return [];
  }
}

// ── Recent large fills for a set of wallets ───────────────────
const ORDER_FILLS_QUERY = gql`
  query Fills($makers: [String!]!, $since: Int!, $minAmount: BigDecimal!) {
    orderFilledEvents(
      where:          { maker_in: $makers, timestamp_gt: $since, makerAmountFilled_gt: $minAmount }
      orderBy:        timestamp
      orderDirection: desc
      first:          200
    ) {
      id
      maker
      makerAssetId
      takerAssetId
      makerAmountFilled
      takerAmountFilled
      timestamp
      transactionHash
    }
  }
`;

export async function fetchWalletActivity(
  wallets:    string[],
  sinceHours: number = 4,
  minSizeUsd: number = 5_000,
): Promise<SmartMoneySignal[]> {
  if (wallets.length === 0) return [];
  const since = Math.floor(Date.now() / 1000) - sinceHours * 3_600;
  try {
    const data: any = await client('orders').request(ORDER_FILLS_QUERY, {
      makers:    wallets.map(w => w.toLowerCase()),
      since,
      minAmount: minSizeUsd * SCALE,
    });

    return (data.orderFilledEvents ?? []).map((f: any) => ({
      wallet: {
        address:      f.maker,
        win_rate:     0,
        realized_pnl: 0,
        trade_count:  0,
        is_hft:       false,
      },
      market_id: f.makerAssetId ?? '',
      side:      'Yes' as const,   // refined by cross-referencing token side
      size_usdc: Number(f.makerAmountFilled) / SCALE,
      timestamp: Number(f.timestamp) * 1_000,
    }));
  } catch (err: any) {
    console.error('⚠️  Goldsky order fills query failed:', err.message);
    return [];
  }
}

// ── Recent all-market large fills (any wallet) ────────────────
// Used for scanning smart money activity without a known wallet list.
export async function fetchRecentLargeFills(
  sinceHours: number = 1,
  minSizeUsd: number = 10_000,
  limit:      number = 50,
): Promise<Array<{ maker: string; sizeUsdc: number; tokenId: string; timestamp: number; txHash: string }>> {
  const since = Math.floor(Date.now() / 1000) - sinceHours * 3_600;
  const q = gql`
    query BigFills($since: Int!, $minAmount: BigDecimal!, $first: Int!) {
      orderFilledEvents(
        where: { timestamp_gt: $since, makerAmountFilled_gt: $minAmount }
        orderBy: makerAmountFilled
        orderDirection: desc
        first: $first
      ) {
        maker makerAssetId makerAmountFilled timestamp transactionHash
      }
    }
  `;
  try {
    const data: any = await client('orders').request(q, {
      since, minAmount: minSizeUsd * SCALE, first: limit,
    });
    return (data.orderFilledEvents ?? []).map((f: any) => ({
      maker:     f.maker,
      sizeUsdc:  Number(f.makerAmountFilled) / SCALE,
      tokenId:   f.makerAssetId,
      timestamp: Number(f.timestamp) * 1_000,
      txHash:    f.transactionHash,
    }));
  } catch (err: any) {
    console.error('⚠️  Goldsky large fills query failed:', err.message);
    return [];
  }
}

// ── User positions (token balances) ──────────────────────────
export async function fetchOwnPositions(walletAddress: string): Promise<any[]> {
  const q = gql`
    query UserPos($wallet: String!) {
      userBalances(where: { user: $wallet, balance_gt: "0" }) {
        id balance asset { id }
      }
    }
  `;
  try {
    const data: any = await client('positions').request(q, {
      wallet: walletAddress.toLowerCase(),
    });
    return data.userBalances ?? [];
  } catch (err: any) {
    console.error('⚠️  Goldsky positions query failed:', err.message);
    return [];
  }
}

// ── Market open interest ──────────────────────────────────────
export async function fetchMarketOI(conditionId: string): Promise<number> {
  const q = gql`
    query OI($id: ID!) {
      condition(id: $id) { id openInterest }
    }
  `;
  try {
    const data: any = await client('oi').request(q, { id: conditionId });
    return Number(data.condition?.openInterest ?? 0) / SCALE;
  } catch (err: any) {
    console.error(`⚠️  Goldsky OI query failed:`, err.message);
    return 0;
  }
}
