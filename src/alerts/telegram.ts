/**
 * Telegram alerts + approval flow.
 * Sends trade opportunities that don't meet auto-execute threshold
 * and waits for Approve / Reject / Adjust response.
 */
import axios from 'axios';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../config';
import { PricerResult, PolymarketMarket } from '../types';

const BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ── Send a plain text message ─────────────────────────────────
export async function sendMessage(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }, { timeout: 10_000 });
  } catch (err: any) {
    console.error('⚠️  Telegram sendMessage failed:', err.message);
  }
}

// ── Format a trade opportunity alert ─────────────────────────
export function formatTradeAlert(
  result: PricerResult,
  market: PolymarketMarket,
  sizeUsdc: number,
): string {
  const edgeEmoji    = result.edge_percent >= 12 ? '🔥' : result.edge_percent >= 8 ? '✅' : '⚠️';
  const confEmoji    = result.confidence   >= 85 ? '💪' : result.confidence   >= 70 ? '👍' : '🤔';
  const expiryHours  = ((new Date(market.end_date_iso).getTime() - Date.now()) / 3_600_000).toFixed(1);

  return [
    `${edgeEmoji} <b>TRADE OPPORTUNITY</b>`,
    ``,
    `<b>Market:</b> ${market.question.slice(0, 100)}`,
    `<b>Category:</b> ${market.category.toUpperCase()}`,
    `<b>Expiry:</b> ${expiryHours}h`,
    ``,
    `<b>Side:</b> ${result.side}`,
    `<b>Fair prob:</b> ${(result.fair_prob * 100).toFixed(1)}%`,
    `<b>Implied:</b> ${(result.implied_prob * 100).toFixed(1)}%`,
    `${edgeEmoji} <b>Edge:</b> ${result.edge_percent.toFixed(1)}%`,
    `${confEmoji} <b>Confidence:</b> ${result.confidence}/100`,
    `<b>Size:</b> $${sizeUsdc.toFixed(2)} USDC`,
    result.reward_apr_bonus ? `<b>Reward APR:</b> ${result.reward_apr_bonus.toFixed(0)}%` : '',
    ``,
    `<b>Reasoning:</b> ${result.reasoning_summary}`,
    `<b>Risks:</b> ${result.risk_notes}`,
    ``,
    `Reply: <code>approve</code> | <code>reject</code> | <code>size 5</code>`,
  ].filter(Boolean).join('\n');
}

// ── Send a trade alert ────────────────────────────────────────
export async function sendTradeAlert(
  result: PricerResult,
  market: PolymarketMarket,
  sizeUsdc: number,
): Promise<void> {
  const msg = formatTradeAlert(result, market, sizeUsdc);
  await sendMessage(msg);
  console.log(`📱 Telegram alert sent for ${market.question.slice(0, 60)}`);
}

// ── Send execution confirmation ───────────────────────────────
export async function sendExecutionConfirm(
  result: PricerResult,
  market: PolymarketMarket,
  sizeUsdc: number,
  txHash: string,
): Promise<void> {
  const msg = [
    `✅ <b>ORDER PLACED</b> (auto-executed)`,
    `<b>Market:</b> ${market.question.slice(0, 80)}`,
    `<b>Side:</b> ${result.side} @ ${(result.implied_prob * 100).toFixed(1)}¢`,
    `<b>Size:</b> $${sizeUsdc.toFixed(2)} USDC`,
    `<b>Edge:</b> ${result.edge_percent.toFixed(1)}% | Conf: ${result.confidence}/100`,
    txHash !== 'dry-run' ? `<b>Tx:</b> <code>${txHash}</code>` : `<i>(dry run — no real order)</i>`,
  ].join('\n');
  await sendMessage(msg);
}

// ── Send error/warning alert ──────────────────────────────────
export async function sendAlert(text: string): Promise<void> {
  await sendMessage(`⚠️ ${text}`);
}
