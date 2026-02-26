import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ── Polymarket credentials ───────────────────────────────────
export const POLY_API_KEY        = optional('POLYMARKET_API_KEY', '');
export const POLY_API_SECRET     = optional('POLYMARKET_API_SECRET', '');
export const POLY_API_PASSPHRASE = optional('POLYMARKET_API_PASSPHRASE', '');
export const POLY_WALLET_KEY     = optional('POLYMARKET_WALLET_PRIVATE_KEY', '');

// ── Goldsky ──────────────────────────────────────────────────
export const GOLDSKY_API_KEY = required('GOLDSKY_API_KEY');

// ── Telegram ─────────────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN = optional('TELEGRAM_BOT_TOKEN', '');
export const TELEGRAM_CHAT_ID   = optional('TELEGRAM_CHAT_ID', '');

// ── Risk ─────────────────────────────────────────────────────
export const BANKROLL_USDC             = Number(optional('BANKROLL_USDC',                '1000'));
export const MAX_POSITION_PCT          = Number(optional('MAX_POSITION_PCT',             '0.02'));
export const MAX_TOTAL_EXPOSURE_PCT    = Number(optional('MAX_TOTAL_EXPOSURE_PCT',        '0.15'));
export const MAX_SINGLE_BUCKET_PCT     = Number(optional('MAX_SINGLE_BUCKET_PCT',         '0.05'));
export const DAILY_LOSS_LIMIT_PCT      = Number(optional('DAILY_LOSS_LIMIT_PCT',          '0.04'));
export const MAX_CONCURRENT_POSITIONS  = Number(optional('MAX_CONCURRENT_POSITIONS',      '8'));

// ── Edge thresholds ──────────────────────────────────────────
export const MIN_EDGE_PCT              = Number(optional('MIN_EDGE_PCT',                  '7'));
export const MIN_EDGE_SPONSORED_PCT    = Number(optional('MIN_EDGE_SPONSORED_PCT',        '4'));
export const MIN_CONFIDENCE            = Number(optional('MIN_CONFIDENCE',                '70'));
export const AUTO_EXECUTE_EDGE_PCT     = Number(optional('AUTO_EXECUTE_EDGE_PCT',         '12'));
export const AUTO_EXECUTE_CONFIDENCE   = Number(optional('AUTO_EXECUTE_CONFIDENCE',       '85'));
export const AUTO_EXECUTE_MAX_SIZE_PCT = Number(optional('AUTO_EXECUTE_MAX_SIZE_PCT',     '1'));

// ── Scan config ──────────────────────────────────────────────
export const SCAN_INTERVAL_MINUTES = Number(optional('SCAN_INTERVAL_MINUTES', '10'));
export const MIN_MARKET_VOLUME     = Number(optional('MIN_MARKET_VOLUME',     '10000'));
export const MIN_MARKET_LIQUIDITY  = Number(optional('MIN_MARKET_LIQUIDITY',  '1000'));
export const MIN_EXPIRY_MINUTES    = Number(optional('MIN_EXPIRY_MINUTES',    '60'));

// ── Derived ──────────────────────────────────────────────────
export const MAX_POSITION_USDC         = BANKROLL_USDC * MAX_POSITION_PCT;
export const MAX_TOTAL_EXPOSURE_USDC   = BANKROLL_USDC * MAX_TOTAL_EXPOSURE_PCT;
export const MAX_SINGLE_BUCKET_USDC    = BANKROLL_USDC * MAX_SINGLE_BUCKET_PCT;
export const DAILY_LOSS_LIMIT_USDC     = BANKROLL_USDC * DAILY_LOSS_LIMIT_PCT;
export const AUTO_EXECUTE_MAX_USDC     = BANKROLL_USDC * (AUTO_EXECUTE_MAX_SIZE_PCT / 100);

export function printConfig() {
  console.log('⚙️  PolymarketEdge Config');
  console.log(`   Bankroll:       $${BANKROLL_USDC} USDC`);
  console.log(`   Max position:   $${MAX_POSITION_USDC.toFixed(2)} (${MAX_POSITION_PCT * 100}%)`);
  console.log(`   Max exposure:   $${MAX_TOTAL_EXPOSURE_USDC.toFixed(2)} (${MAX_TOTAL_EXPOSURE_PCT * 100}%)`);
  console.log(`   Daily loss cap: $${DAILY_LOSS_LIMIT_USDC.toFixed(2)} (${DAILY_LOSS_LIMIT_PCT * 100}%)`);
  console.log(`   Min edge:       ${MIN_EDGE_PCT}% | Auto-execute: >${AUTO_EXECUTE_EDGE_PCT}% + >${AUTO_EXECUTE_CONFIDENCE}% conf`);
  console.log(`   Scan interval:  every ${SCAN_INTERVAL_MINUTES} min`);
  console.log(`   Goldsky:        ${GOLDSKY_API_KEY ? '✅' : '❌ missing'}`);
  console.log(`   Polymarket:     ${POLY_API_KEY ? '✅' : '⚠️  no API key (read-only)'}`);
  console.log(`   Telegram:       ${TELEGRAM_BOT_TOKEN ? '✅' : '⚠️  no bot token'}`);
}
