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

let running = true;
process.on('SIGINT',  () => { running = false; console.log('\n👋 Shutting down...'); });
process.on('SIGTERM', () => { running = false; });

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
  console.log(`\n🔎 Pricing: "${market.question.slice(0, 70)}"`);

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
    console.log(`   📱 Sending for approval (edge ${result.edge_percent.toFixed(1)}% | conf ${result.confidence})`);
    await sendTradeAlert(result, market, sizeUsdc);
  }
}

// ── Main loop ─────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('🎯 PolymarketEdge — Starting');
  console.log('='.repeat(60));
  printConfig();
  console.log('');

  await sendMessage('🎯 PolymarketEdge bot started');

  while (running) {
    try {
      console.log(`\n⏱️  [${new Date().toISOString()}] Starting scan...`);
      printRiskSummary(loadState());

      const markets = await scanMarkets();

      // Price each market (highest volume first)
      const sorted = markets.sort((a, b) => b.volume - a.volume);

      for (const market of sorted) {
        if (!running) break;
        await processMarket(market);
        await sleep(500);  // gentle rate limit between pricer calls
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
