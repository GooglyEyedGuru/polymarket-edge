/**
 * PolymarketEdge — main bot loop.
 * Runs every SCAN_INTERVAL_MINUTES, finds markets with edge,
 * checks risk, auto-executes or sends Telegram approval alert.
 */
import 'dotenv/config';
import {
  SCAN_INTERVAL_MINUTES, AUTO_EXECUTE_EDGE_PCT,
  AUTO_EXECUTE_CONFIDENCE, AUTO_EXECUTE_MAX_USDC,
  EXIT_PROFIT_THRESHOLD, EXIT_STOP_LOSS_FRAC,
  printConfig,
} from '../config';
import { scanMarkets } from '../scanner';
import { priceMarket } from '../pricer';
import { checkRisk, loadState, recordOpen, recordClose, printRiskSummary } from '../risk';
import { placeOrder, sellPosition, getTokenIdFromMarket, getMarketPrice } from '../executor';
import { sendTradeAlert, sendExecutionConfirm, sendExitAlert, sendMessage } from '../alerts/telegram';
import axios from 'axios';
import { Position, PolymarketMarket, PricerResult } from '../types';
import { startControlServer } from '../control';
import { queueTrade, startApprovalPoller, stopApprovalPoller, setLastScanTime } from '../approvals';

let running = true;
process.on('SIGINT',  () => { running = false; stopApprovalPoller(); console.log('\n👋 Shutting down...'); });
process.on('SIGTERM', () => { running = false; stopApprovalPoller(); });

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Decide: auto-execute or alert for approval ────────────────
function shouldAutoExecute(result: PricerResult, sizeUsdc: number): boolean {
  return (
    result.edge_percent >= AUTO_EXECUTE_EDGE_PCT &&
    result.confidence   >= AUTO_EXECUTE_CONFIDENCE &&
    sizeUsdc            <= AUTO_EXECUTE_MAX_USDC
  );
}

// ── Look up token ID from Gamma when not stored (legacy positions) ────
async function resolveTokenId(pos: Position): Promise<string | null> {
  if (pos.token_id) return pos.token_id;
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { conditionId: pos.market_id },
      timeout: 8_000,
    });
    const m = r.data?.[0];
    if (!m) return null;
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const outcomes = JSON.parse(m.outcomes     || '[]');
    const idx = outcomes.findIndex((o: string) => o.toLowerCase() === pos.side.toLowerCase());
    return idx >= 0 ? tokenIds[idx] : null;
  } catch { return null; }
}

// ── Check Gamma for resolved outcome ─────────────────────────
async function checkResolution(pos: Position): Promise<{ resolved: boolean; won: boolean; exitPrice: number }> {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { conditionId: pos.market_id },
      timeout: 8_000,
    });
    const m = r.data?.[0];
    if (!m) {
      console.log(`   🔎 Gamma returned no market for conditionId: ${pos.market_id}`);
      return { resolved: false, won: false, exitPrice: 0 };
    }

    console.log(`   🔎 Gamma: closed=${m.closed} resolved=${m.resolved} question="${m.question?.slice(0,50)}"`);

    const resolved   = !!m.resolved || !!m.closed;
    const outcomes   = JSON.parse(m.outcomes      || '[]');
    const prices     = JSON.parse(m.outcomePrices  || '[]');
    const idx        = outcomes.findIndex((o: string) => o.toLowerCase() === pos.side.toLowerCase());
    const exitPrice  = idx >= 0 ? Number(prices[idx] ?? 0) : 0;
    const won        = exitPrice >= 0.99;   // resolved Yes = price snaps to 1.0
    console.log(`   🔎 outcome idx=${idx} price=${exitPrice} won=${won}`);
    return { resolved, won, exitPrice };
  } catch (e: any) {
    console.log(`   🔎 checkResolution error: ${e.message}`);
    return { resolved: false, won: false, exitPrice: 0 };
  }
}

// ── Check open positions for exit triggers ────────────────────
async function checkExits(): Promise<void> {
  const state = loadState();
  const open  = state.open_positions.filter(p => p.status === 'open');
  if (!open.length) return;

  console.log(`\n🔍 Checking ${open.length} open position(s) for exit signals...`);

  for (const pos of open) {
    // Resolve token_id — may be missing on positions created before this update
    const tokenId = await resolveTokenId(pos);
    if (!tokenId) {
      console.log(`   ⚠️  Cannot resolve token ID for: ${pos.question.slice(0, 50)}`);
      continue;
    }
    if (!pos.token_id) pos.token_id = tokenId;
    if (!pos.shares)   pos.shares   = pos.size_usdc / pos.entry_price;

    const currentPrice = await getMarketPrice(tokenId);

    // ── Market resolved (no order book) ──────────────────────
    if (currentPrice === null) {
      const { resolved, won, exitPrice } = await checkResolution(pos);
      if (!resolved) {
        console.log(`   ⚠️  No price for ${pos.question.slice(0, 50)} — skipping`);
        continue;
      }
      const pnlUsdc  = won
        ? pos.shares * (1 - pos.entry_price)   // full payout minus cost
        : -pos.size_usdc;                       // lost entire stake
      const freshState = loadState();
      recordClose(freshState, pos.id, exitPrice, 'resolved');
      const resultEmoji = won ? '✅ WON' : '❌ LOST';
      console.log(`   ${resultEmoji}: ${pos.question.slice(0, 55)} | PnL: $${pnlUsdc.toFixed(2)}`);
      await sendMessage(
        `${won ? '✅' : '❌'} <b>MARKET RESOLVED — ${won ? 'WIN' : 'LOSS'}</b>\n` +
        `<b>Market:</b> ${pos.question.slice(0, 80)}\n` +
        `<b>Side:</b> ${pos.side} | Entry: ${(pos.entry_price*100).toFixed(0)}¢\n` +
        `<b>Result:</b> ${won ? 'Resolved YES' : 'Resolved NO'}\n` +
        `<b>PnL: ${pnlUsdc >= 0 ? '+' : ''}$${pnlUsdc.toFixed(2)} USDC</b>`
      );
      continue;
    }

    // ── Still live — check take-profit / stop-loss ────────────
    const pnlPct       = ((currentPrice - pos.entry_price) / pos.entry_price * 100).toFixed(1);
    const overFair     = currentPrice - pos.fair_prob;
    const isStopLoss   = currentPrice < pos.entry_price * EXIT_STOP_LOSS_FRAC;
    const isTakeProfit = overFair > EXIT_PROFIT_THRESHOLD;

    console.log(`   📍 ${pos.question.slice(0, 50)} | entry:${(pos.entry_price*100).toFixed(0)}¢ now:${(currentPrice*100).toFixed(0)}¢ fair:${(pos.fair_prob*100).toFixed(0)}¢ (${pnlPct}%)`);

    if (!isTakeProfit && !isStopLoss) continue;

    const reason = isTakeProfit
      ? `Market ${(currentPrice*100).toFixed(0)}¢ exceeds fair ${(pos.fair_prob*100).toFixed(0)}¢ by >${(EXIT_PROFIT_THRESHOLD*100).toFixed(0)}pp — edge reversed`
      : `Price dropped to ${(currentPrice*100).toFixed(0)}¢ (<${(EXIT_STOP_LOSS_FRAC*100).toFixed(0)}% of entry) — stop-loss`;

    console.log(`   🚨 ${isTakeProfit ? 'TAKE PROFIT' : 'STOP LOSS'}: ${reason}`);

    const sellResult = await sellPosition(tokenId, pos.shares, currentPrice * 0.9);
    if (!sellResult) continue;

    const pnlUsdc = (sellResult.price - pos.entry_price) * pos.shares;
    const freshState = loadState();
    recordClose(freshState, pos.id, sellResult.price, sellResult.orderId);

    await sendExitAlert(
      pos.question,
      pos.side,
      pos.entry_price,
      sellResult.price,
      pos.shares,
      pnlUsdc,
      reason,
    );

    console.log(`   ✅ Sold ${pos.shares.toFixed(1)} shares @ ${(sellResult.price*100).toFixed(0)}¢ | PnL: $${pnlUsdc.toFixed(2)}`);
  }
}

// ── Process a single market opportunity ───────────────────────
async function processMarket(market: PolymarketMarket): Promise<void> {
  if (market.category === 'weather') {
    console.log(`\n🌤️  [WEATHER] "${market.question.slice(0, 70)}"`);
  } else {
    console.log(`\n🔎 Pricing: "${market.question.slice(0, 70)}"`);
  }

  const result = await priceMarket(market);
  if (!result) return;

  console.log(`   💡 Edge: ${result.edge_percent.toFixed(1)}% | Conf: ${result.confidence} | Side: ${result.side}`);

  const state = loadState();
  const riskCheck = checkRisk(result, market.category, state);

  if (!riskCheck.allowed) {
    console.log(`   🚫 Risk block: ${riskCheck.reason}`);
    return;
  }

  const sizeUsdc = riskCheck.sizeUsdc;
  console.log(`   💰 Approved size: $${sizeUsdc.toFixed(2)} USDC`);

  if (shouldAutoExecute(result, sizeUsdc)) {
    console.log(`   🚀 Auto-executing (edge ${result.edge_percent.toFixed(1)}% + conf ${result.confidence})`);
    const order = await placeOrder(result, market, sizeUsdc);

    if (order) {
      const tokenId = getTokenIdFromMarket(market, result.side as 'Yes' | 'No') ?? '';
      const shares  = sizeUsdc / result.implied_prob;
      const position: Position = {
        id:           `${market.condition_id}-${Date.now()}`,
        market_id:    market.condition_id,
        question:     market.question,
        side:         result.side as 'Yes' | 'No',
        size_usdc:    sizeUsdc,
        shares,
        token_id:     tokenId,
        entry_price:  result.implied_prob,
        fair_prob:    result.fair_prob,
        edge_pct:     result.edge_percent,
        confidence:   result.confidence,
        category:     market.category,
        status:       'open',
        opened_at:    Date.now(),
        reasoning:    result.reasoning_summary,
      };
      recordOpen(state, position);
      await sendExecutionConfirm(result, market, sizeUsdc, order.txHash);
    }
  } else {
    console.log(`   📱 Queuing for approval (edge ${result.edge_percent.toFixed(1)}% | conf ${result.confidence})`);
    queueTrade(result, market, sizeUsdc);
    await sendTradeAlert(result, market, sizeUsdc);
  }
}

// ── Main loop ─────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('🎯 PolymarketEdge — Starting');
  console.log('='.repeat(60));
  printConfig();
  console.log('');

  // Start control server + approval poller
  startControlServer(() => { running = false; stopApprovalPoller(); });
  startApprovalPoller();

  await sendMessage('🎯 PolymarketEdge bot started — reply <code>pending</code> to see queued trades');

  while (running) {
    try {
      console.log(`\n⏱️  [${new Date().toISOString()}] Starting scan...`);
      setLastScanTime(Date.now());
      printRiskSummary(loadState());

      // Check exits before scanning for new opportunities
      await checkExits();

      const markets = await scanMarkets();

      // Split by category — weather always runs in full, others capped
      const weather    = markets.filter(m => m.category === 'weather');
      const arb        = markets.filter(m => ['crypto_binary', 'correlated'].includes(m.category))
                                .sort((a, b) => b.volume - a.volume)
                                .slice(0, 100);
      const sponsored  = markets.filter(m => m.category === 'sponsored')
                                .sort((a, b) => (b.rewards_daily_rate ?? 0) - (a.rewards_daily_rate ?? 0))
                                .slice(0, 50);
      const priceable  = [...weather, ...arb, ...sponsored];

      console.log(`📋 ${markets.length} total → pricing ${weather.length} weather + ${arb.length} arb + ${sponsored.length} sponsored`);

      for (const market of priceable) {
        if (!running) break;
        await processMarket(market);
        await sleep(300);
      }

      console.log(`\n✅ Scan complete. Next scan in ${SCAN_INTERVAL_MINUTES} min.`);
      await sleep(SCAN_INTERVAL_MINUTES * 60 * 1_000);

    } catch (err: any) {
      console.error(`❌ Loop error: ${err.message}`);
      await sleep(60_000);
    }
  }

  console.log('🎯 PolymarketEdge stopped.');
}

main().catch(console.error);
