/**
 * Market Scanner — fetches all open Polymarket markets, filters by
 * volume/liquidity/expiry, categorises each one, and returns a
 * clean list ready for the pricer.
 */
import axios from 'axios';
import {
  MIN_MARKET_VOLUME, MIN_MARKET_LIQUIDITY, MIN_EXPIRY_MINUTES,
} from '../config';
import { PolymarketMarket, MarketCategory } from '../types';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';

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

    const batch = res.data as any[];
    if (!batch || batch.length === 0) break;

    for (const m of batch) {
      const market = parseMarket(m);
      if (market) markets.push(market);
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  console.log(`📡 Fetched ${markets.length} markets from Gamma`);
  return markets;
}

// ── Parse + normalise a raw Gamma market object ──────────────
function parseMarket(raw: any): PolymarketMarket | null {
  try {
    const tokens = (raw.tokens ?? raw.outcomes ?? []).map((t: any) => ({
      token_id: t.token_id ?? t.tokenId ?? '',
      outcome:  t.outcome  ?? t.name    ?? '',
      price:    Number(t.price ?? 0),
    }));

    return {
      condition_id: raw.conditionId ?? raw.condition_id ?? '',
      question_id:  raw.questionID  ?? raw.question_id  ?? '',
      question:     raw.question    ?? '',
      description:  raw.description ?? '',
      category:     categorise(raw.question ?? '', raw.tags ?? []),
      end_date_iso: raw.endDateIso  ?? raw.end_date_iso ?? '',
      volume:       Number(raw.volume      ?? 0),
      volume_1h:    Number(raw.volume1Hour ?? raw.volume_1h ?? 0),
      liquidity:    Number(raw.liquidity   ?? 0),
      tokens,
      rewards_daily_rate: raw.rewardsDailyRate ? Number(raw.rewardsDailyRate) : undefined,
      active: true,
      closed: false,
    };
  } catch {
    return null;
  }
}

// ── Categorise a market by its question text + tags ──────────
function categorise(question: string, tags: string[]): MarketCategory {
  const q = question.toLowerCase();
  const t = tags.map((x: string) => x.toLowerCase()).join(' ');

  if (/temperature|rainfall|precipitation|hurricane|storm|weather|high of|low of/.test(q)) return 'weather';
  if (/bitcoin|btc|eth|crypto|sol|price above|price below|will btc|will eth/.test(q) &&
      /by [0-9]+ (hour|minute|min)/.test(q)) return 'crypto_binary';
  if (/election|vote|president|senate|congress|parliament|referendum|policy|regulation|fed rate|fed funds/.test(q + t)) return 'politics';
  if (/gdp|cpi|inflation|unemployment|nonfarm|fomc|rate (hike|cut)|pce/.test(q + t)) return 'macro';
  if (/oscar|grammy|nba|nfl|world cup|champion|winner|super bowl|award/.test(q + t)) return 'entertainment';
  if (tags.includes('sponsored') || tags.includes('rewards')) return 'sponsored';

  return 'other';
}

// ── Apply hard filters — returns only tradeable markets ───────
export function filterMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
  const now        = Date.now();
  const minExpiry  = now + MIN_EXPIRY_MINUTES * 60 * 1_000;

  return markets.filter(m => {
    const expiryMs = new Date(m.end_date_iso).getTime();

    // Must expire after our minimum window
    if (expiryMs < minExpiry) return false;

    // Volume or liquidity threshold
    if (m.volume < MIN_MARKET_VOLUME && m.liquidity < MIN_MARKET_LIQUIDITY) return false;

    // Must have at least 2 tokens with prices
    if (m.tokens.length < 2) return false;

    // Skip if prices are all zero (no orderbook yet)
    if (m.tokens.every(t => t.price === 0)) return false;

    // Crypto binaries: only keep if there's a true arb (yes+no != ~1)
    if (m.category === 'crypto_binary') {
      const sum = m.tokens.reduce((s, t) => s + t.price, 0);
      if (sum >= 0.975 && sum <= 1.025) return false;  // no arb
    }

    return true;
  });
}

// ── Full scan: fetch + filter ─────────────────────────────────
export async function scanMarkets(): Promise<PolymarketMarket[]> {
  const all      = await fetchMarkets();
  const filtered = filterMarkets(all);
  console.log(`🔍 ${filtered.length} markets passed filters (from ${all.length})`);
  return filtered;
}
