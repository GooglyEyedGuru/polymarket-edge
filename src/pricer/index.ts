/**
 * Pricer — routes each market to the appropriate pricing engine,
 * applies smart-money boost, and returns a PricerResult or null
 * (null = no edge / skip).
 */
import {
  MIN_EDGE_PCT, MIN_EDGE_SPONSORED_PCT, MIN_CONFIDENCE,
  BANKROLL_USDC, MAX_POSITION_PCT,
} from '../config';
import { PolymarketMarket, PricerResult } from '../types';
import { priceWeatherMarket } from './weather';
import { getSmartMoneySignals, confidenceBoost } from '../intelligence/smartMoney';

// ── Route market to correct pricer ───────────────────────────
export async function priceMarket(market: PolymarketMarket): Promise<PricerResult | null> {
  let result: PricerResult | null = null;

  switch (market.category) {
    case 'weather':
      result = await priceWeatherMarket(market);
      break;

    case 'crypto_binary': {
      // Only true arb: yes+no sum deviation > 2.5% after fees
      result = checkCryptoArb(market);
      break;
    }

    case 'correlated': {
      result = checkCorrelatedArb(market);
      break;
    }

    case 'sponsored': {
      result = await priceSponsored(market);
      break;
    }

    case 'politics':
    case 'macro':
    case 'entertainment':
    case 'other':
      // TODO: implement AI reasoning pricer (Phase 2)
      // These require Claude reasoning + news/X search to price fairly
      // For now: log as opportunity, return null
      console.log(`   🔮 [${market.category.toUpperCase()}] Reasoning pricer not yet implemented: "${market.question.slice(0, 60)}"`);
      return null;
  }

  if (!result) return null;

  // ── Smart money boost ─────────────────────────────────────
  const smartSignals = await getSmartMoneySignals(market.condition_id);
  if (smartSignals.length > 0) {
    const boost = confidenceBoost(smartSignals, result.side as 'Yes' | 'No');
    if (boost > 0) {
      console.log(`   🧠 Smart money boost: +${boost} confidence (${smartSignals.length} signal(s))`);
      result = { ...result, confidence: Math.min(result.confidence + boost, 99) };
    }
  }

  // ── Apply minimum edge / confidence filters ───────────────
  const minEdge = market.category === 'sponsored' ? MIN_EDGE_SPONSORED_PCT : MIN_EDGE_PCT;
  if (result.edge_percent < minEdge) {
    console.log(`   ❌ Edge ${result.edge_percent.toFixed(1)}% < min ${minEdge}% — skip`);
    return null;
  }
  if (result.confidence < MIN_CONFIDENCE) {
    console.log(`   ❌ Confidence ${result.confidence} < min ${MIN_CONFIDENCE} — skip`);
    return null;
  }

  // ── Attach Kelly size (capped) ────────────────────────────
  result.size_usdc = kellySize(result.fair_prob, result.implied_prob);

  return result;
}

// ── Kelly fraction (full) capped at MAX_POSITION_PCT ─────────
function kellySize(fairProb: number, impliedPrice: number): number {
  // Full Kelly: f = (p*(b+1) - 1) / b  where b = (1/price - 1)
  // impliedPrice = cost per share, payout = 1.0 if correct
  const b = (1 / impliedPrice) - 1;
  if (b <= 0) return 0;
  const kelly = (fairProb * (b + 1) - 1) / b;
  if (kelly <= 0) return 0;
  // Cap at MAX_POSITION_PCT of bankroll, half-Kelly as default
  const halfKelly = kelly * 0.5;
  return Math.min(halfKelly * BANKROLL_USDC, BANKROLL_USDC * MAX_POSITION_PCT);
}

// ── Crypto binary arb check ───────────────────────────────────
function checkCryptoArb(market: PolymarketMarket): PricerResult | null {
  const sum = market.tokens.reduce((s, t) => s + t.price, 0);
  const deviation = Math.abs(1 - sum) * 100;

  if (deviation < 2.5) return null;  // no arb after fees

  // sum < 1 → buy both sides (underpriced total)
  // sum > 1 → sell both sides (overpriced — would need shorting, not available on Polymarket)
  if (sum > 1) return null;  // can't short on Polymarket

  const edge = (1 - sum) * 100;
  const lowToken = market.tokens.reduce((a, b) => a.price < b.price ? a : b);

  return {
    market_id:    market.condition_id,
    side:         'arb_both',
    fair_prob:    0.5,
    implied_prob: sum / 2,
    edge_percent: edge,
    confidence:   95,  // pure arb, high confidence
    size_usdc:    0,
    reasoning_summary: `Yes+No sum = ${sum.toFixed(3)} (${deviation.toFixed(1)}% below 1.0). Pure arb opportunity.`,
    risk_notes: 'Resolution timing risk. Both legs must fill. Check liquidity on both sides.',
  };
}

// ── Correlated market arb check ───────────────────────────────
function checkCorrelatedArb(market: PolymarketMarket): PricerResult | null {
  // Multi-outcome markets: outcomes should sum to ~1.0
  const sum = market.tokens.reduce((s, t) => s + t.price, 0);
  const deviation = Math.abs(1 - sum) * 100;

  if (deviation < 3) return null;

  const underpriced = market.tokens.filter(t => t.price < (1 / market.tokens.length) * 0.8);
  if (underpriced.length === 0) return null;

  const bestToken = underpriced.reduce((a, b) => a.price < b.price ? a : b);

  return {
    market_id:    market.condition_id,
    side:         'Yes',
    fair_prob:    1 / market.tokens.length,
    implied_prob: bestToken.price,
    edge_percent: deviation,
    confidence:   75,
    size_usdc:    0,
    reasoning_summary: `Multi-outcome sum = ${sum.toFixed(3)}. ${bestToken.outcome} appears mispriced at ${(bestToken.price * 100).toFixed(1)}%.`,
    risk_notes: 'Outcome dependency risk. Verify outcomes are mutually exclusive and exhaustive.',
  };
}

// ── Sponsored market pricer ───────────────────────────────────
async function priceSponsored(market: PolymarketMarket): Promise<PricerResult | null> {
  if (!market.rewards_daily_rate || market.rewards_daily_rate === 0) return null;

  const daysToExpiry = (new Date(market.end_date_iso).getTime() - Date.now()) / 86_400_000;
  const totalRewards = market.rewards_daily_rate * daysToExpiry;

  // Simple check: if rewards > potential directional loss exposure, it's yield positive
  const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  if (!yesToken) return null;

  const impliedProb = yesToken.price;
  // Assume 50/50 fair if no other signal — rewards are the alpha
  const fairProb  = 0.5;
  const edgePct   = Math.abs(fairProb - impliedProb) * 100;
  const rewardApr = (totalRewards / BANKROLL_USDC) * (365 / daysToExpiry) * 100;

  return {
    market_id:    market.condition_id,
    side:         impliedProb < 0.5 ? 'Yes' : 'No',
    fair_prob:    fairProb,
    implied_prob: impliedProb,
    edge_percent: edgePct,
    confidence:   60,
    size_usdc:    0,
    reasoning_summary: `Sponsored market. $${market.rewards_daily_rate}/day rewards, ${daysToExpiry.toFixed(1)} days left. Est. ${rewardApr.toFixed(0)}% reward APR.`,
    risk_notes:   'Reward distribution rules may change. Provide limit orders to qualify.',
    reward_apr_bonus: rewardApr,
  };
}
