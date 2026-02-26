/**
 * Goldsky subgraph queries for Polymarket on-chain data.
 * Subgraph: polymarket/polymarket-orderbook-v2 (free tier)
 * Docs: https://docs.goldsky.com
 */
import { GraphQLClient, gql } from 'graphql-request';
import { GOLDSKY_API_KEY } from '../config';
import { WalletStats, SmartMoneySignal } from '../types';

// Goldsky Polymarket subgraph endpoint
const SUBGRAPH_URL = `https://api.goldsky.com/api/public/${GOLDSKY_API_KEY}/subgraphs/polymarket-orderbook-v2/prod/gn`;

const client = new GraphQLClient(SUBGRAPH_URL, {
  headers: { 'Content-Type': 'application/json' },
});

// ── Fetch top PnL wallets from last 30 days ──────────────────
const TOP_WALLETS_QUERY = gql`
  query TopWallets($minPnl: BigDecimal!, $since: Int!) {
    userStats(
      where: { realizedPnl_gt: $minPnl, lastTradeTimestamp_gt: $since }
      orderBy: realizedPnl
      orderDirection: desc
      first: 50
    ) {
      id
      realizedPnl
      tradeCount
      winCount
      lastTradeTimestamp
    }
  }
`;

// ── Fetch recent activity for a list of wallets ──────────────
const WALLET_ACTIVITY_QUERY = gql`
  query WalletActivity($wallets: [String!]!, $since: Int!) {
    orderFills(
      where: { maker_in: $wallets, timestamp_gt: $since }
      orderBy: timestamp
      orderDirection: desc
      first: 200
    ) {
      id
      maker
      market
      side
      size
      price
      timestamp
    }
  }
`;

// ── Fetch orderbook snapshot for a market ───────────────────
const ORDERBOOK_QUERY = gql`
  query Orderbook($marketId: String!) {
    orderBook(id: $marketId) {
      id
      bids(orderBy: price, orderDirection: desc, first: 10) {
        price
        size
      }
      asks(orderBy: price, orderDirection: asc, first: 10) {
        price
        size
      }
    }
  }
`;

// ── Fetch our own positions ───────────────────────────────────
const OWN_POSITIONS_QUERY = gql`
  query OwnPositions($wallet: String!) {
    positions(where: { owner: $wallet, size_gt: "0" }) {
      id
      market
      side
      size
      avgPrice
      realizedPnl
      unrealizedPnl
    }
  }
`;

// ─────────────────────────────────────────────────────────────

export async function fetchTopWallets(minPnlUsd: number = 50_000): Promise<WalletStats[]> {
  const since = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // 30 days ago
  try {
    const data: any = await client.request(TOP_WALLETS_QUERY, { minPnl: minPnlUsd, since });
    return (data.userStats ?? []).map((w: any) => {
      const trades    = Number(w.tradeCount ?? 0);
      const wins      = Number(w.winCount   ?? 0);
      // Rough HFT detection: >500 trades/day over 30 days = 15,000 trades
      const is_hft    = trades > 15_000;
      return {
        address:      w.id,
        win_rate:     trades > 0 ? wins / trades : 0,
        realized_pnl: Number(w.realizedPnl ?? 0),
        trade_count:  trades,
        is_hft,
      };
    }).filter((w: WalletStats) => !w.is_hft);
  } catch (err: any) {
    console.error('⚠️  Goldsky topWallets query failed:', err.message);
    return [];
  }
}

export async function fetchWalletActivity(
  wallets: string[],
  sinceHours: number = 4,
): Promise<SmartMoneySignal[]> {
  if (wallets.length === 0) return [];
  const since = Math.floor(Date.now() / 1000) - sinceHours * 60 * 60;
  try {
    const data: any = await client.request(WALLET_ACTIVITY_QUERY, { wallets, since });
    return (data.orderFills ?? []).map((f: any) => ({
      wallet:    { address: f.maker, win_rate: 0, realized_pnl: 0, trade_count: 0, is_hft: false },
      market_id: f.market,
      side:      f.side === '0' ? 'No' : 'Yes',
      size_usdc: Number(f.size) * Number(f.price),
      timestamp: Number(f.timestamp) * 1000,
    }));
  } catch (err: any) {
    console.error('⚠️  Goldsky walletActivity query failed:', err.message);
    return [];
  }
}

export async function fetchOrderbook(marketId: string): Promise<{ bids: any[]; asks: any[] } | null> {
  try {
    const data: any = await client.request(ORDERBOOK_QUERY, { marketId });
    return data.orderBook ?? null;
  } catch (err: any) {
    console.error(`⚠️  Goldsky orderbook query failed for ${marketId}:`, err.message);
    return null;
  }
}

export async function fetchOwnPositions(walletAddress: string): Promise<any[]> {
  try {
    const data: any = await client.request(OWN_POSITIONS_QUERY, { wallet: walletAddress.toLowerCase() });
    return data.positions ?? [];
  } catch (err: any) {
    console.error('⚠️  Goldsky ownPositions query failed:', err.message);
    return [];
  }
}
