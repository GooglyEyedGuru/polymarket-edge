// ── Market types ─────────────────────────────────────────────
export type MarketCategory =
  | 'crypto_binary'   // short-term crypto up/down
  | 'weather'         // temperature/precip ranges — our edge
  | 'politics'        // elections, policy, regulatory
  | 'macro'           // econ data, Fed decisions
  | 'entertainment'   // sports, awards, pop culture
  | 'sponsored'       // liquidity reward markets
  | 'correlated'      // multi-outcome / parlay consistency
  | 'other';

export interface PolymarketToken {
  token_id:  string;
  outcome:   string;   // "Yes" | "No" | candidate name etc.
  price:     number;   // current mid price (0–1)
}

export interface PolymarketMarket {
  condition_id:   string;
  question_id:    string;
  question:       string;
  description:    string;
  category:       MarketCategory;
  end_date_iso:   string;
  volume:         number;   // USD lifetime
  volume_1h:      number;
  liquidity:      number;   // USD depth on best side
  tokens:         PolymarketToken[];
  rewards_daily_rate?: number;  // USD/day reward pool if sponsored
  active:         boolean;
  closed:         boolean;
}

// ── Pricer output ────────────────────────────────────────────
export interface PricerResult {
  market_id:        string;
  side:             'Yes' | 'No' | 'arb_both';
  fair_prob:        number;   // our estimate (0–1)
  implied_prob:     number;   // market price
  edge_percent:     number;   // |fair - implied| * 100
  confidence:       number;   // 0–100
  size_usdc:        number;
  reasoning_summary: string;
  risk_notes:       string;
  reward_apr_bonus?: number;
}

// ── Smart money ──────────────────────────────────────────────
export interface WalletStats {
  address:      string;
  win_rate:     number;    // 0–1
  realized_pnl: number;   // USD
  trade_count:  number;
  is_hft:       boolean;  // >500 trades/day
}

export interface SmartMoneySignal {
  wallet:        WalletStats;
  market_id:     string;
  side:          'Yes' | 'No';
  size_usdc:     number;
  timestamp:     number;
}

// ── Position / trade log ─────────────────────────────────────
export type PositionStatus = 'pending_approval' | 'open' | 'closed' | 'rejected';

export interface Position {
  id:             string;
  market_id:      string;
  question:       string;
  side:           'Yes' | 'No';
  size_usdc:      number;
  entry_price:    number;
  fair_prob:      number;
  edge_pct:       number;
  confidence:     number;
  category:       MarketCategory;
  status:         PositionStatus;
  opened_at:      number;
  closed_at?:     number;
  exit_price?:    number;
  pnl_usdc?:      number;
  outcome?:       'win' | 'loss' | 'void';
  tx_hash?:       string;
  reasoning:      string;
}

// ── Risk state ───────────────────────────────────────────────
export interface RiskState {
  open_positions:      Position[];
  daily_pnl_usdc:      number;
  total_exposure_usdc: number;
  paused_until?:       number;   // unix ms — daily loss limit triggered
  bucket_exposure:     Record<string, number>;  // resolution bucket → USD
}
