/**
 * Telegram Position Manager — /menu command
 *
 * Commands:
 *   /menu   → show open positions with inline action buttons
 *
 * Inline buttons per position:
 *   [❌ Close]  [➕ +$10]  [➖ -$5]
 *
 * Footer buttons:
 *   [🔄 Refresh]  [📋 Pending]  [💰 Balance]
 *
 * Callback data format (kept short for Telegram 64-byte limit):
 *   cl:<idx>        → close position at index
 *   ad:<idx>:<amt>  → add $amt to position
 *   rd:<idx>:<amt>  → reduce position by $amt (sell shares)
 *   rf              → refresh menu
 *   pd              → list pending trades
 *   bl              → show CLOB balance
 */
import axios from 'axios';
import path from 'path';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config';
import { loadState, recordClose, saveState } from './risk';
import { getMarketPrice, sellPosition } from './executor';
import { sendMessage } from './alerts/telegram';
import { Position, PricerResult } from './types';
import { ClobClient, ApiKeyCreds, Chain, Side, OrderType } from '@polymarket/clob-client';

const BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CLOB_HOST_VAL = process.env.CLOB_HOST || 'https://clob.polymarket.com';

const ethers5 = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));

// ── Build CLOB client ─────────────────────────────────────────
function buildClient(): ClobClient {
  const key    = (process.env.POLYMARKET_WALLET_PRIVATE_KEY ?? '');
  const wallet = new ethers5.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  const creds: ApiKeyCreds = {
    key:        process.env.POLYMARKET_API_KEY        ?? '',
    secret:     process.env.POLYMARKET_API_SECRET     ?? '',
    passphrase: process.env.POLYMARKET_API_PASSPHRASE ?? '',
  };
  return new ClobClient(CLOB_HOST_VAL, Chain.POLYGON, wallet, creds, 0);
}

// ── Fetch CLOB balance ────────────────────────────────────────
async function getClobBalance(): Promise<number> {
  try {
    const client = buildClient();
    const bal    = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
    return Number(bal.balance) / 1e6;
  } catch { return -1; }
}

// ── Look up current price for a position ─────────────────────
async function resolvePrice(pos: Position): Promise<number | null> {
  if (pos.token_id) return getMarketPrice(pos.token_id);

  // Fallback: look up from Gamma using condition_id
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { conditionId: pos.market_id }, timeout: 8_000,
    });
    const m = r.data?.[0];
    if (!m) return null;
    const outcomes = JSON.parse(m.outcomes      || '[]');
    const prices   = JSON.parse(m.outcomePrices || '[]');
    const idx      = outcomes.findIndex((o: string) => o.toLowerCase() === pos.side.toLowerCase());
    return idx >= 0 ? Number(prices[idx]) : null;
  } catch { return null; }
}

// ── Render the menu message and keyboard ─────────────────────
export async function buildMenuPayload(): Promise<{
  text: string;
  reply_markup: object;
}> {
  const state = loadState();
  const open  = state.open_positions.filter(p => p.status === 'open');

  let text = '📊 <b>Position Manager</b>\n';
  text    += `💼 Open: ${open.length} | Daily PnL: ${state.daily_pnl_usdc >= 0 ? '+' : ''}$${state.daily_pnl_usdc.toFixed(2)}\n\n`;

  const keyboard: object[][] = [];

  if (open.length === 0) {
    text += '📭 No open positions.\n';
  } else {
    for (let i = 0; i < open.length; i++) {
      const pos  = open[i];
      const now  = await resolvePrice(pos);
      const shares = pos.shares || (pos.size_usdc / pos.entry_price);

      let pnlStr  = '—';
      let nowStr  = '?¢';
      if (now !== null) {
        const pnl  = (now - pos.entry_price) * shares;
        const pct  = ((now - pos.entry_price) / pos.entry_price * 100).toFixed(0);
        pnlStr     = `${pnl >= 0 ? '🟢 +' : '🔴 '}$${pnl.toFixed(2)} (${pct}%)`;
        nowStr     = `${(now * 100).toFixed(0)}¢`;
      }

      text += `<b>${i + 1}. ${pos.question.slice(0, 58)}</b>\n`;
      text += `   ${pos.side} | Entry: ${(pos.entry_price * 100).toFixed(0)}¢ → Now: ${nowStr}\n`;
      text += `   Shares: ${shares.toFixed(1)} | Cost: $${pos.size_usdc.toFixed(2)} | ${pnlStr}\n\n`;

      keyboard.push([
        { text: `❌ Close #${i + 1}`, callback_data: `cl:${i}` },
        { text: `➕ +$10`,            callback_data: `ad:${i}:10` },
        { text: `➖ -$5`,             callback_data: `rd:${i}:5` },
      ]);
    }
  }

  keyboard.push([
    { text: '🔄 Refresh',   callback_data: 'rf' },
    { text: '📋 Pending',   callback_data: 'pd' },
    { text: '💰 Balance',   callback_data: 'bl' },
  ]);

  return {
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
}

// ── Send a fresh menu message ─────────────────────────────────
export async function sendMenu(): Promise<number | null> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const payload = await buildMenuPayload();
    const res = await axios.post(`${BASE}/sendMessage`, {
      chat_id:    TELEGRAM_CHAT_ID,
      parse_mode: 'HTML',
      ...payload,
    }, { timeout: 10_000 });
    return res.data?.result?.message_id ?? null;
  } catch (e: any) {
    console.error('sendMenu error:', e.message);
    return null;
  }
}

// ── Edit an existing menu message with fresh prices ───────────
export async function refreshMenu(messageId: number): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const payload = await buildMenuPayload();
    await axios.post(`${BASE}/editMessageText`, {
      chat_id:    TELEGRAM_CHAT_ID,
      message_id: messageId,
      parse_mode: 'HTML',
      ...payload,
    }, { timeout: 10_000 });
  } catch (e: any) {
    if (!e.message?.includes('message is not modified')) {
      console.error('refreshMenu error:', e.message);
    }
  }
}

// ── Answer a callback query (clears loading spinner) ─────────
async function ack(queryId: string, text?: string): Promise<void> {
  try {
    await axios.post(`${BASE}/answerCallbackQuery`, {
      callback_query_id: queryId,
      text: text ?? '',
      show_alert: false,
    }, { timeout: 5_000 });
  } catch {}
}

// ── Handle inline button presses ─────────────────────────────
export async function handleCallback(
  queryId:   string,
  data:      string,
  messageId: number,
): Promise<void> {
  const state = loadState();
  const open  = state.open_positions.filter(p => p.status === 'open');

  // ── Refresh prices ────────────────────────────────────────
  if (data === 'rf') {
    await ack(queryId, '🔄 Refreshing...');
    await refreshMenu(messageId);
    return;
  }

  // ── Show CLOB balance ─────────────────────────────────────
  if (data === 'bl') {
    const bal = await getClobBalance();
    await ack(queryId, bal >= 0 ? `💰 CLOB Balance: $${bal.toFixed(2)} USDC` : '❌ Could not fetch balance');
    return;
  }

  // ── List pending trades ───────────────────────────────────
  if (data === 'pd') {
    await ack(queryId);
    await sendMessage('📋 Send <code>pending</code> to see queued trades.');
    return;
  }

  // ── Position actions (close / add / reduce) ───────────────
  const parts = data.split(':');
  const cmd   = parts[0];
  const idx   = Number(parts[1]);
  const amt   = parts[2] ? Number(parts[2]) : 0;

  if (isNaN(idx) || idx < 0 || idx >= open.length) {
    await ack(queryId, '⚠️ Position not found — try refreshing.');
    return;
  }

  const pos    = open[idx];
  const shares = pos.shares || (pos.size_usdc / pos.entry_price);
  const tokenId = pos.token_id;

  // ── CLOSE ─────────────────────────────────────────────────
  if (cmd === 'cl') {
    await ack(queryId, '⏳ Placing sell order...');
    if (!tokenId) {
      await sendMessage(`❌ Cannot close — no token ID for position #${idx + 1}. Sell manually on Polymarket.`);
      return;
    }
    const currentPrice = await getMarketPrice(tokenId);
    if (!currentPrice) {
      await sendMessage(`❌ No order book for position #${idx + 1} — market may have resolved.`);
      return;
    }
    const result = await sellPosition(tokenId, shares, currentPrice * 0.85);
    if (result) {
      const pnl = (result.price - pos.entry_price) * shares;
      const freshState = loadState();
      recordClose(freshState, pos.id, result.price, result.orderId);
      await sendMessage(
        `${pnl >= 0 ? '✅' : '🔴'} <b>Position closed</b>\n` +
        `<b>${pos.question.slice(0, 70)}</b>\n` +
        `Entry: ${(pos.entry_price * 100).toFixed(0)}¢ → Exit: ${(result.price * 100).toFixed(0)}¢\n` +
        `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDC`
      );
      await refreshMenu(messageId);
    } else {
      await sendMessage(`❌ Sell order failed for position #${idx + 1} — check console.`);
    }
    return;
  }

  // ── ADD to position ───────────────────────────────────────
  if (cmd === 'ad') {
    await ack(queryId, `⏳ Adding $${amt} to position...`);
    if (!tokenId) {
      await sendMessage(`❌ Cannot add — no token ID for position #${idx + 1}.`);
      return;
    }
    const currentPrice = await getMarketPrice(tokenId);
    if (!currentPrice) {
      await sendMessage(`❌ No order book — market may have closed.`);
      return;
    }
    try {
      const client    = buildClient();
      const addShares = amt / currentPrice;
      const orderArgs = {
        tokenID:   tokenId,
        price:     Math.round(currentPrice * 100) / 100,
        size:      addShares,
        side:      Side.BUY,
        orderType: OrderType.GTC,
      };
      const signed   = await client.createOrder(orderArgs);
      const response = await client.postOrder(signed, OrderType.GTC);
      if (response?.orderID) {
        const freshState = loadState();
        // Update exposure tracking
        freshState.total_exposure_usdc += amt;
        freshState.bucket_exposure[pos.category] = (freshState.bucket_exposure[pos.category] ?? 0) + amt;
        saveState(freshState);
        await sendMessage(
          `➕ <b>Position increased</b>\n` +
          `Added $${amt} (${addShares.toFixed(1)} shares @ ${(currentPrice * 100).toFixed(0)}¢)\n` +
          `<b>${pos.question.slice(0, 70)}</b>`
        );
        await refreshMenu(messageId);
      } else {
        await sendMessage(`❌ Add order failed.`);
      }
    } catch (e: any) {
      await sendMessage(`❌ Add failed: ${e.message?.slice(0, 80)}`);
    }
    return;
  }

  // ── REDUCE position ───────────────────────────────────────
  if (cmd === 'rd') {
    await ack(queryId, `⏳ Reducing position by $${amt}...`);
    if (!tokenId) {
      await sendMessage(`❌ Cannot reduce — no token ID for position #${idx + 1}.`);
      return;
    }
    const currentPrice = await getMarketPrice(tokenId);
    if (!currentPrice) {
      await sendMessage(`❌ No order book — market may have closed.`);
      return;
    }
    const sellShares = Math.min(amt / currentPrice, shares);
    const result     = await sellPosition(tokenId, sellShares, currentPrice * 0.85);
    if (result) {
      const pnl = (result.price - pos.entry_price) * sellShares;
      const freshState = loadState();
      // Partial close: reduce exposure without fully closing position
      freshState.total_exposure_usdc              = Math.max(0, freshState.total_exposure_usdc - amt);
      freshState.bucket_exposure[pos.category]    = Math.max(0, (freshState.bucket_exposure[pos.category] ?? 0) - amt);
      const posRef = freshState.open_positions.find(p => p.id === pos.id);
      if (posRef) {
        posRef.size_usdc -= amt;
        posRef.shares    = (posRef.shares || shares) - sellShares;
      }
      saveState(freshState);
      await sendMessage(
        `➖ <b>Position reduced</b>\n` +
        `Sold ${sellShares.toFixed(1)} shares @ ${(result.price * 100).toFixed(0)}¢ | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
        `<b>${pos.question.slice(0, 70)}</b>`
      );
      await refreshMenu(messageId);
    } else {
      await sendMessage(`❌ Reduce order failed — check console.`);
    }
    return;
  }

  await ack(queryId, '⚠️ Unknown action.');
}
