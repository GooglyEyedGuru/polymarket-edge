/**
 * Risk manager — enforces position limits, Kelly sizing caps,
 * daily loss circuit breaker, and bucket diversification.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BANKROLL_USDC, MAX_POSITION_USDC, MAX_TOTAL_EXPOSURE_USDC,
  MAX_SINGLE_BUCKET_USDC, DAILY_LOSS_LIMIT_USDC, MAX_CONCURRENT_POSITIONS,
} from '../config';
import { Position, RiskState, PricerResult, MarketCategory } from '../types';

const STATE_FILE = path.join(__dirname, '../../data/positions.json');

// ── Load/save state ───────────────────────────────────────────
export function loadState(): RiskState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {
    open_positions:      [],
    daily_pnl_usdc:      0,
    total_exposure_usdc: 0,
    bucket_exposure:     {},
  };
}

export function saveState(state: RiskState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Check if we can open a new position ──────────────────────
export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  sizeUsdc: number;  // approved size (may be reduced)
}

export function checkRisk(
  result: PricerResult,
  category: MarketCategory,
  state: RiskState,
): RiskCheckResult {
  // Circuit breaker: daily loss limit
  if (state.paused_until && Date.now() < state.paused_until) {
    const resumeAt = new Date(state.paused_until).toISOString();
    return { allowed: false, reason: `Daily loss limit hit — paused until ${resumeAt}`, sizeUsdc: 0 };
  }

  // Max concurrent positions
  const openCount = state.open_positions.filter(p => p.status === 'open').length;
  if (openCount >= MAX_CONCURRENT_POSITIONS) {
    return { allowed: false, reason: `Max concurrent positions reached (${MAX_CONCURRENT_POSITIONS})`, sizeUsdc: 0 };
  }

  // Total exposure cap
  if (state.total_exposure_usdc >= MAX_TOTAL_EXPOSURE_USDC) {
    return { allowed: false, reason: `Total exposure cap reached ($${MAX_TOTAL_EXPOSURE_USDC})`, sizeUsdc: 0 };
  }

  // Per-bucket cap (use category as bucket for now)
  const bucketExposure = state.bucket_exposure[category] ?? 0;
  if (bucketExposure >= MAX_SINGLE_BUCKET_USDC) {
    return { allowed: false, reason: `Bucket "${category}" exposure cap reached ($${MAX_SINGLE_BUCKET_USDC})`, sizeUsdc: 0 };
  }

  // Size: start with pricer suggestion, cap at position max and remaining exposure room
  let size = result.size_usdc;
  size = Math.min(size, MAX_POSITION_USDC);
  size = Math.min(size, MAX_TOTAL_EXPOSURE_USDC - state.total_exposure_usdc);
  size = Math.min(size, MAX_SINGLE_BUCKET_USDC - bucketExposure);
  size = Math.floor(size * 100) / 100;  // round to cents

  if (size < 1) {
    return { allowed: false, reason: 'Position size too small (<$1)', sizeUsdc: 0 };
  }

  return { allowed: true, sizeUsdc: size };
}

// ── Record an opened position ─────────────────────────────────
export function recordOpen(state: RiskState, position: Position): RiskState {
  const updated: RiskState = {
    ...state,
    open_positions: [...state.open_positions, position],
    total_exposure_usdc: state.total_exposure_usdc + position.size_usdc,
    bucket_exposure: {
      ...state.bucket_exposure,
      [position.category]: (state.bucket_exposure[position.category] ?? 0) + position.size_usdc,
    },
  };
  saveState(updated);
  return updated;
}

// ── Record a closed position ──────────────────────────────────
export function recordClose(
  state: RiskState,
  positionId: string,
  exitPrice: number,
  txHash: string,
): RiskState {
  const pos = state.open_positions.find(p => p.id === positionId);
  if (!pos) return state;

  const pnl      = (exitPrice - pos.entry_price) * pos.size_usdc / pos.entry_price;
  const outcome: 'win' | 'loss' = pnl >= 0 ? 'win' : 'loss';

  const closed: Position = {
    ...pos,
    status:    'closed',
    closed_at: Date.now(),
    exit_price: exitPrice,
    pnl_usdc:   pnl,
    outcome,
    tx_hash:    txHash,
  };

  const newDailyPnl = state.daily_pnl_usdc + pnl;
  let pausedUntil   = state.paused_until;

  // Daily loss circuit breaker
  if (newDailyPnl < -DAILY_LOSS_LIMIT_USDC) {
    pausedUntil = Date.now() + 24 * 60 * 60 * 1000;
    console.warn(`🚨 Daily loss limit hit ($${Math.abs(newDailyPnl).toFixed(2)}) — pausing 24h`);
  }

  const updated: RiskState = {
    open_positions: state.open_positions.map(p => p.id === positionId ? closed : p),
    daily_pnl_usdc: newDailyPnl,
    total_exposure_usdc: Math.max(0, state.total_exposure_usdc - pos.size_usdc),
    bucket_exposure: {
      ...state.bucket_exposure,
      [pos.category]: Math.max(0, (state.bucket_exposure[pos.category] ?? 0) - pos.size_usdc),
    },
    paused_until: pausedUntil,
  };

  saveState(updated);
  return updated;
}

// ── Print summary ─────────────────────────────────────────────
export function printRiskSummary(state: RiskState): void {
  const open   = state.open_positions.filter(p => p.status === 'open');
  const closed = state.open_positions.filter(p => p.status === 'closed');
  const wins   = closed.filter(p => p.outcome === 'win').length;

  console.log('💼 Risk Summary');
  console.log(`   Open positions:  ${open.length} / ${MAX_CONCURRENT_POSITIONS}`);
  console.log(`   Total exposure:  $${state.total_exposure_usdc.toFixed(2)} / $${MAX_TOTAL_EXPOSURE_USDC.toFixed(2)}`);
  console.log(`   Daily PnL:       $${state.daily_pnl_usdc.toFixed(2)} (limit: -$${DAILY_LOSS_LIMIT_USDC.toFixed(2)})`);
  if (closed.length > 0) {
    console.log(`   Closed trades:   ${closed.length} | Win rate: ${(wins / closed.length * 100).toFixed(0)}%`);
  }
  if (state.paused_until && Date.now() < state.paused_until) {
    console.log(`   ⏸️  PAUSED until ${new Date(state.paused_until).toISOString()}`);
  }
}
