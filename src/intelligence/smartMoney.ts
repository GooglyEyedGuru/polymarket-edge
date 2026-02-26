/**
 * Smart money tracker — identifies high-conviction wallets and
 * surfaces their recent market entries as signal boosts.
 */
import { fetchTopWallets, fetchWalletActivity } from './goldsky';
import { WalletStats, SmartMoneySignal } from '../types';

const MIN_WIN_RATE  = 0.65;  // >65% historical win rate
const MIN_PNL_USD   = 50_000;
const MIN_SIZE_USD  = 5_000;  // only care about entries >$5k
const COPY_SCALE    = 0.25;   // copy at 25% of their size

let cachedWallets: WalletStats[] = [];
let lastWalletFetch = 0;
const WALLET_CACHE_MS = 4 * 60 * 60 * 1000;  // refresh every 4h

// ── Get / refresh smart money wallet list ─────────────────────
export async function getSmartWallets(): Promise<WalletStats[]> {
  if (lastWalletFetch > 0 && Date.now() - lastWalletFetch < WALLET_CACHE_MS) {
    return cachedWallets;
  }

  console.log('🧠 Refreshing smart money wallet list...');
  const wallets = await fetchTopWallets(MIN_PNL_USD);
  cachedWallets = wallets.filter(w => w.win_rate >= MIN_WIN_RATE && !w.is_hft);
  lastWalletFetch = Date.now();
  console.log(`   Found ${cachedWallets.length} qualifying smart wallets`);
  return cachedWallets;
}

// ── Check if any smart wallet has entered a specific market ───
export async function getSmartMoneySignals(
  marketId: string,
  sinceHours: number = 4,
): Promise<SmartMoneySignal[]> {
  const wallets   = await getSmartWallets();
  if (wallets.length === 0) return [];

  const addresses = wallets.map(w => w.address);
  const activity  = await fetchWalletActivity(addresses, sinceHours);

  // Filter to this market + enrich with wallet stats
  return activity
    .filter(a => a.market_id === marketId && a.size_usdc >= MIN_SIZE_USD)
    .map(a => ({
      ...a,
      wallet: wallets.find(w => w.address === a.wallet.address) ?? a.wallet,
    }));
}

// ── Calculate copy size based on smart money signal ───────────
// Returns 0 if no qualifying signal, otherwise a scaled copy size.
export function copySizeUsdc(signals: SmartMoneySignal[], maxUsdc: number): number {
  if (signals.length === 0) return 0;
  const totalSmartSize = signals.reduce((s, sig) => s + sig.size_usdc, 0);
  return Math.min(totalSmartSize * COPY_SCALE, maxUsdc);
}

// ── Signal boost multiplier for pricer confidence ─────────────
// If smart money is on the same side, boost confidence by up to 15 points.
export function confidenceBoost(signals: SmartMoneySignal[], side: 'Yes' | 'No'): number {
  const aligned = signals.filter(s => s.side === side);
  if (aligned.length === 0) return 0;
  const avgWinRate  = aligned.reduce((s, a) => s + a.wallet.win_rate, 0) / aligned.length;
  return Math.round((avgWinRate - MIN_WIN_RATE) / (1 - MIN_WIN_RATE) * 15);
}
