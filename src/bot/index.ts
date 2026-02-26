/**
 * PolymarketEdge — main bot loop.
 * Runs every SCAN_INTERVAL_MINUTES, finds markets with edge,
 * checks risk, auto-executes or sends Telegram approval alert.
 */
import 'dotenv/config';
import {
  SCAN_INTERVAL_MINUTES, AUTO_EXECUTE_EDGE_PCT,
  AUTO_EXECUTE_CONFIDENCE, AUTO_EXECUTE_MAX_USDC, printConfig,
} from '../config';
import { scanMarkets } from '../scanner';
import { priceMarket } from '../pricer';
import { checkRisk, loadState, recordOpen, printRiskSummary } from '../risk';
import { placeOrder } from '../executor';
import { sendTradeAlert, sendExecutionConfirm, sendMessage } from '../alerts/telegram';
import { Position, PolymarketMarket, PricerResult } from '../types';
import { startControlServer } from '../control';
import { queueTrade, startApprovalPoller, stopApprovalPoller } from '../approvals';

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
      const position: Position = {
        id:           `${market.condition_id}-${Date.now()}`,
        market_id:    market.condition_id,
        question:     market.question,
        side:         result.side as 'Yes' | 'No',
        size_usdc:    sizeUsdc,
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
      printRiskSummary(loadState());

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
