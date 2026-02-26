/**
 * Market Scanner — fetches all open Polymarket markets via Gamma API,
 * filters by volume/liquidity/expiry, categorises each one, and
 * returns a clean list ready for the pricer.
 *
 * Gamma API field reference (verified 2026-02-26):
 *   conditionId, questionID, question, description, endDateIso,
 *   volumeNum, liquidityNum, outcomes (JSON string), outcomePrices (JSON string),
 *   clobTokenIds (JSON string), negRisk, negRiskMarketID, rewardsMinSize
 */
import axios from 'axios';
import {
  MIN_MARKET_VOLUME, MIN_MARKET_LIQUIDITY, MIN_EXPIRY_MINUTES,
} from '../config';
import { PolymarketMarket, MarketCategory } from '../types';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// ── Fetch all active markets from Gamma ──────────────────────
export async function fetchMarkets(): Promise<PolymarketMarket[]> {
  const markets: PolymarketMarket[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { active: true, closed: false, limit, offset },
      timeout: 15_000,
    });

    const batch: any[] = Array.isArray(res.data) ? res.data : [];
    if (batch.length === 0) break;

    for (const raw of batch) {
      const market = parseMarket(raw);
      if (market) markets.push(market);
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  console.log(`📡 Fetched ${markets.length} markets from Gamma`);
  return markets;
}

// ── Parse a raw Gamma market object ──────────────────────────
function parseMarket(raw: any): PolymarketMarket | null {
  try {
    const outcomes:  string[] = JSON.parse(raw.outcomes      ?? '[]');
    const prices:    string[] = JSON.parse(raw.outcomePrices ?? '[]');
    const tokenIds:  string[] = JSON.parse(raw.clobTokenIds  ?? '[]');

    if (outcomes.length === 0 || prices.length === 0) return null;

    const tokens = outcomes.map((outcome: string, i: number) => ({
      token_id: tokenIds[i] ?? '',
      outcome,
      price: Number(prices[i] ?? 0),
    }));

    return {
      condition_id:      raw.conditionId    ?? '',
      question_id:       raw.questionID     ?? '',
      question:          raw.question       ?? '',
      description:       raw.description    ?? '',
      category:          categorise(raw),
      end_date_iso:      raw.endDateIso     ?? raw.endDate ?? '',
      volume:            Number(raw.volumeNum   ?? raw.volume    ?? 0),
      volume_1h:         Number(raw.volume24hr  ?? 0) / 24,
      liquidity:         Number(raw.liquidityNum ?? raw.liquidity ?? 0),
      tokens,
      rewards_daily_rate: raw.negRisk ? undefined : undefined,   // see negRisk note below
      active:  Boolean(raw.active),
      closed:  Boolean(raw.closed),
      // Extra fields stored for scanner use
      ...(raw.negRisk         ? { negRisk: true }                        : {}),
      ...(raw.negRiskMarketID ? { negRiskMarketID: raw.negRiskMarketID } : {}),
    } as PolymarketMarket;
  } catch {
    return null;
  }
}

// ── Categorise a market from its raw API object ───────────────
function categorise(raw: any): MarketCategory {
  const q = (raw.question ?? '').toLowerCase();

  // Temperature / precipitation — use strict word-boundary patterns
  // Avoid false positives like "Ukraine" matching "rain"
  if (
    /\b(temperature|temp)\b/.test(q) ||
    /\b(high|low)\s+(of|above|below|exceed)\s+\d/.test(q) ||
    /\d+\s*°\s*[fc]\b/.test(q) ||
    /\bprecipitation\b/.test(q) ||
    /\b(rainfall|snowfall|snowpack)\b/.test(q) ||
    /\bnamed\s+storm\b/.test(q) ||
    /\bcategory\s+[1-5]\s+hurricane\b/.test(q)
  ) {
    return 'weather';
  }

  // Short-term crypto price binaries
  if (
    /\b(btc|bitcoin|eth|ethereum|solana|sol)\b/.test(q) &&
    /(above|below|exceed|reach|\$[\d,]+)\s*(by|on|before|at)/.test(q)
  ) {
    return 'crypto_binary';
  }

  // NegRisk grouped markets = mutually exclusive ranges = correlated arb candidates
  if (raw.negRisk === true) {
    return 'correlated';
  }

  // Politics
  if (/\b(elect|election|vote|president|senator|congress|parliament|cabinet|minister|referendum|resign|impeach|primary|nominee|nomination)\b/.test(q)) {
    return 'politics';
  }

  // Macro
  if (/\b(gdp|cpi|inflation|unemployment|nonfarm|payroll|fomc|fed\s+rate|fed\s+funds|rate\s+(hike|cut)|pce|ecb|boe|interest\s+rate)\b/.test(q)) {
    return 'macro';
  }

  // Entertainment / sports
  if (/\b(oscar|grammy|emmy|tony|nba|nfl|nhl|mlb|premier\s+league|champions\s+league|world\s+cup|super\s+bowl|stanley\s+cup|award|finals)\b/.test(q)) {
    return 'entertainment';
  }

  return 'other';
}

// ── Apply hard filters ────────────────────────────────────────
export function filterMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
  const now       = Date.now();
  const minExpiry = now + MIN_EXPIRY_MINUTES * 60 * 1_000;

  return markets.filter(m => {
    const expiryMs = new Date(m.end_date_iso).getTime();
    if (isNaN(expiryMs) || expiryMs < minExpiry) return false;
    if (m.volume < MIN_MARKET_VOLUME && m.liquidity < MIN_MARKET_LIQUIDITY) return false;
    if (m.tokens.length < 2) return false;
    if (m.tokens.every(t => t.price === 0)) return false;

    // Crypto binaries: only keep if true arb exists
    if (m.category === 'crypto_binary') {
      const sum = m.tokens.reduce((s, t) => s + t.price, 0);
      if (sum >= 0.975 && sum <= 1.025) return false;
    }

    return true;
  });
}

// ── Group negRisk markets by their shared negRiskMarketID ─────
// Returns map of groupId → array of markets (mutually exclusive outcomes).
// If a group's Yes prices don't sum to ~1.0, that's a correlated arb.
export function groupNegRiskMarkets(
  markets: PolymarketMarket[],
): Map<string, PolymarketMarket[]> {
  const groups = new Map<string, PolymarketMarket[]>();
  for (const m of markets) {
    const id = (m as any).negRiskMarketID;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(m);
  }
  return groups;
}

// ── Find correlated arb within negRisk groups ─────────────────
// Mutually exclusive outcomes must have Yes prices summing to exactly 1.0.
// Deviation > 3% after fees = arb.
export interface NegRiskArb {
  groupId:    string;
  markets:    PolymarketMarket[];
  yesSum:     number;
  deviation:  number;  // percent deviation from 1.0
}

export function findNegRiskArbs(markets: PolymarketMarket[]): NegRiskArb[] {
  const groups  = groupNegRiskMarkets(markets);
  const arbs: NegRiskArb[] = [];

  for (const [groupId, group] of groups) {
    if (group.length < 2) continue;
    const yesSum   = group.reduce((s, m) => {
      const yes = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
      return s + (yes?.price ?? 0);
    }, 0);
    const deviation = Math.abs(1 - yesSum) * 100;
    if (deviation > 3) {
      arbs.push({ groupId, markets: group, yesSum, deviation });
    }
  }

  return arbs.sort((a, b) => b.deviation - a.deviation);
}

// ── Full scan ─────────────────────────────────────────────────
export async function scanMarkets(): Promise<PolymarketMarket[]> {
  const all      = await fetchMarkets();
  const filtered = filterMarkets(all);
  console.log(`🔍 ${filtered.length} markets passed filters (from ${all.length})`);
  return filtered;
}
