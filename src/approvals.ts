/**
 * Approval queue — tracks pending trade alerts and executes them
 * when the user replies "approve" via Telegram.
 *
 * Commands:
 *   approve        → execute the oldest pending trade at default size
 *   approve 15     → execute at $15 USDC instead
 *   reject         → discard the oldest pending trade
 *   reject all     → clear the entire queue
 *   pending        → list all queued trades
 */
import axios from 'axios';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config';
import { placeOrder, getTokenIdFromMarket } from './executor';
import { loadState, recordOpen } from './risk';
import { sendExecutionConfirm, sendMessage } from './alerts/telegram';
import { sendMenu, handleCallback } from './menu';
import { PricerResult, PolymarketMarket, Position } from './types';

const BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

interface PendingTrade {
  id:       string;
  result:   PricerResult;
  market:   PolymarketMarket;
  sizeUsdc: number;
  addedAt:  number;
}

let queue:        PendingTrade[] = [];
let lastUpdateId: number = 0;
let polling       = false;

// ── Add a trade to the pending queue ─────────────────────────
export function queueTrade(
  result:   PricerResult,
  market:   PolymarketMarket,
  sizeUsdc: number,
): void {
  const id = `${Date.now()}`;
  queue.push({ id, result, market, sizeUsdc, addedAt: Date.now() });
  // Expire trades older than 2 hours automatically
  queue = queue.filter(t => Date.now() - t.addedAt < 2 * 60 * 60 * 1000);
}

// ── Start polling Telegram for approve/reject replies ─────────
export function startApprovalPoller(): void {
  if (polling || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  polling = true;
  console.log('📬 Approval poller started (polling every 5s)');
  poll();
}

async function poll(): Promise<void> {
  if (!polling) return;

  try {
    const res = await axios.get(`${BASE}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 5, allowed_updates: ['message', 'callback_query'] },
      timeout: 10_000,
    });

    for (const update of res.data.result ?? []) {
      lastUpdateId = update.update_id;

      // ── Inline button press ───────────────────────────────
      if (update.callback_query) {
        const cq     = update.callback_query;
        const chatId = String(cq.message?.chat?.id ?? '');
        if (chatId !== TELEGRAM_CHAT_ID) continue;
        await handleCallback(cq.id, cq.data ?? '', cq.message?.message_id ?? 0);
        continue;
      }

      // ── Text message ──────────────────────────────────────
      const text   = update.message?.text?.trim().toLowerCase() ?? '';
      const chatId = String(update.message?.chat?.id ?? '');
      if (chatId !== TELEGRAM_CHAT_ID) continue;

      if (text === '/menu' || text === 'menu') {
        await sendMenu();
      } else {
        await handleCommand(text);
      }
    }
  } catch { /* network blip — keep polling */ }

  setTimeout(poll, 5_000);
}

// ── Handle a command from the user ───────────────────────────
async function handleCommand(text: string): Promise<void> {
  if (text === 'pending' || text === '/pending') {
    await listPending();
    return;
  }

  if (text === 'reject all') {
    const n = queue.length;
    queue = [];
    await sendMessage(`🗑️ Cleared ${n} pending trade(s).`);
    return;
  }

  if (text.startsWith('reject')) {
    const trade = queue.shift();
    if (!trade) { await sendMessage('📭 No pending trades to reject.'); return; }
    await sendMessage(`❌ Rejected: ${trade.market.question.slice(0, 60)}`);
    return;
  }

  if (text.startsWith('approve')) {
    const parts    = text.split(' ');
    const override = parts[1] ? parseFloat(parts[1]) : null;
    const trade    = queue.shift();

    if (!trade) { await sendMessage('📭 No pending trades to approve.'); return; }

    const sizeUsdc = (override && override > 0) ? override : trade.sizeUsdc;
    await sendMessage(`⚙️ Executing: ${trade.market.question.slice(0, 60)}\nSize: $${sizeUsdc.toFixed(2)}`);

    const order = await placeOrder(trade.result, trade.market, sizeUsdc);

    if (order && order.txHash !== 'error') {
      const state    = loadState();
      const tokenId  = getTokenIdFromMarket(trade.market, trade.result.side as 'Yes' | 'No') ?? '';
      const shares   = sizeUsdc / trade.result.implied_prob;
      const position: Position = {
        id:          `${trade.market.condition_id}-${Date.now()}`,
        market_id:   trade.market.condition_id,
        question:    trade.market.question,
        side:        trade.result.side as 'Yes' | 'No',
        size_usdc:   sizeUsdc,
        shares,
        token_id:    tokenId,
        entry_price: trade.result.implied_prob,
        fair_prob:   trade.result.fair_prob,
        edge_pct:    trade.result.edge_percent,
        confidence:  trade.result.confidence,
        category:    trade.market.category,
        status:      'open',
        opened_at:   Date.now(),
        reasoning:   trade.result.reasoning_summary,
      };
      recordOpen(state, position);
      await sendExecutionConfirm(trade.result, trade.market, sizeUsdc, order.txHash);
    } else {
      await sendMessage(`❌ Order failed — check console for details.`);
    }
    return;
  }
}

// ── List all pending trades ───────────────────────────────────
async function listPending(): Promise<void> {
  if (queue.length === 0) {
    await sendMessage('📭 No pending trades.');
    return;
  }
  const lines = queue.map((t, i) =>
    `${i + 1}. ${t.market.question.slice(0, 50)} | ${t.result.side} | Edge: ${t.result.edge_percent.toFixed(1)}% | $${t.sizeUsdc.toFixed(0)}`
  );
  await sendMessage(`📋 <b>Pending trades (${queue.length}):</b>\n\n${lines.join('\n')}`);
}

export function stopApprovalPoller(): void {
  polling = false;
}
