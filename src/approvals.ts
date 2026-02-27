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

// ── Register bot commands (shows "/" menu button in Telegram) ─
async function registerCommands(): Promise<void> {
  try {
    await axios.post(`${BASE}/setMyCommands`, {
      commands: [
        { command: 'menu',    description: '📊 Position manager — open positions + actions' },
        { command: 'balance', description: '💰 CLOB wallet balance' },
        { command: 'pnl',     description: '📈 P&L summary (daily + all time)' },
        { command: 'pending', description: '📋 Pending trades awaiting approval' },
        { command: 'status',  description: '🤖 Bot status — uptime, last scan, positions' },
      ],
    }, { timeout: 8_000 });
    console.log('📱 Telegram commands registered (/menu /balance /pnl /pending /status)');
  } catch (e: any) {
    console.warn('⚠️  Could not register Telegram commands:', e.message);
  }
}

// ── Start polling Telegram for approve/reject replies ─────────
export function startApprovalPoller(): void {
  if (polling || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  polling = true;
  console.log('📬 Approval poller started (polling every 5s)');
  registerCommands(); // fire-and-forget — doesn't block polling
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
      } else if (text === '/balance' || text === 'balance') {
        await handleBalance();
      } else if (text === '/pnl' || text === 'pnl') {
        await handlePnl();
      } else if (text === '/status' || text === 'status') {
        await handleStatus();
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

// ── /balance ──────────────────────────────────────────────────
async function handleBalance(): Promise<void> {
  try {
    const path = require('path');
    const ethers5 = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));
    const { ClobClient, ApiKeyCreds, Chain } = require('@polymarket/clob-client');
    const key    = process.env.POLYMARKET_WALLET_PRIVATE_KEY ?? '';
    const wallet = new ethers5.Wallet(key.startsWith('0x') ? key : `0x${key}`);
    const creds  = {
      key:        process.env.POLYMARKET_API_KEY        ?? '',
      secret:     process.env.POLYMARKET_API_SECRET     ?? '',
      passphrase: process.env.POLYMARKET_API_PASSPHRASE ?? '',
    };
    const client = new ClobClient(
      process.env.CLOB_HOST || 'https://clob.polymarket.com',
      Chain.POLYGON, wallet, creds, 0
    );
    const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const usdc = Number(bal.balance) / 1e6;
    await sendMessage(`💰 <b>CLOB Balance</b>\n$${usdc.toFixed(2)} USDC.e`);
  } catch (e: any) {
    await sendMessage(`❌ Balance fetch failed: ${e.message?.slice(0, 80)}`);
  }
}

// ── /pnl ──────────────────────────────────────────────────────
async function handlePnl(): Promise<void> {
  const state = loadState();
  const open  = state.open_positions.filter(p => p.status === 'open');
  const closed = state.open_positions.filter(p => p.status === 'closed');

  const totalCost    = open.reduce((a, p) => a + p.size_usdc, 0);
  const closedPnl    = closed.reduce((a, p) => a + (p.pnl_usdc ?? 0), 0);
  const wins         = closed.filter(p => (p.pnl_usdc ?? 0) > 0).length;
  const losses       = closed.filter(p => (p.pnl_usdc ?? 0) <= 0).length;
  const wr           = closed.length > 0 ? (wins / closed.length * 100).toFixed(0) : '—';
  const daily        = state.daily_pnl_usdc;

  const lines = [
    `📈 <b>P&L Summary</b>`,
    ``,
    `  Today:       ${daily >= 0 ? '+' : ''}$${daily.toFixed(2)}`,
    `  All closed:  ${closedPnl >= 0 ? '+' : ''}$${closedPnl.toFixed(2)} (${closed.length} trades, WR ${wr}%)`,
    `  Open cost:   $${totalCost.toFixed(2)} across ${open.length} position(s)`,
    `  W/L:         ${wins} wins / ${losses} losses`,
  ];
  await sendMessage(lines.join('\n'));
}

// ── /status ───────────────────────────────────────────────────
const _botStartTime = Date.now();
let   _lastScanTime = 0;
export function setLastScanTime(ts: number): void { _lastScanTime = ts; }

async function handleStatus(): Promise<void> {
  const state    = loadState();
  const open     = state.open_positions.filter(p => p.status === 'open');
  const uptimeSec = Math.floor((Date.now() - _botStartTime) / 1000);
  const hours    = Math.floor(uptimeSec / 3600);
  const mins     = Math.floor((uptimeSec % 3600) / 60);
  const lastScan = _lastScanTime
    ? `${Math.floor((Date.now() - _lastScanTime) / 60_000)}m ago`
    : 'not yet';

  const lines = [
    `🤖 <b>Polymarket Bot Status</b>`,
    ``,
    `  Uptime:      ${hours}h ${mins}m`,
    `  Last scan:   ${lastScan}`,
    `  Open pos:    ${open.length}`,
    `  Exposure:    $${state.total_exposure_usdc.toFixed(2)}`,
    `  Daily PnL:   ${state.daily_pnl_usdc >= 0 ? '+' : ''}$${state.daily_pnl_usdc.toFixed(2)}`,
  ];
  await sendMessage(lines.join('\n'));
}

export function stopApprovalPoller(): void {
  polling = false;
}
