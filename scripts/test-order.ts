/**
 * Place a tiny test limit order to validate the full execution pipeline.
 * Uses a real low-liquidity market with a far-from-market price (won't fill).
 */
import 'dotenv/config';
import { ClobClient, ApiKeyCreds, Chain, Side, OrderType } from '@polymarket/clob-client';

const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';

async function main() {
  const pk     = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const wallet = new ethers5.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);

  const creds: ApiKeyCreds = {
    key:        process.env.POLYMARKET_API_KEY!,
    secret:     process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
  };

  // signatureType=0 = EOA wallet, no funder proxy
  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, 0);

  console.log('Wallet:', wallet.address);

  // Use a real token ID from a live market — Dallas high temp > 74°F (Feb 27)
  // conditionId: 0xc9be93d0ff6c87db450fa659ad67a12ab7f1268a3722bf5930e913854645ac9a
  // We'll use the NO token so we bet at ~3¢ (very far from current 97¢ YES price)
  // Fetch the market first to get token IDs
  const market = await client.getMarket('0xc9be93d0ff6c87db450fa659ad67a12ab7f1268a3722bf5930e913854645ac9a');
  console.log('Market:', market.question);
  console.log('Tokens:', market.tokens.map((t: any) => `${t.outcome}: ${t.token_id}`).join(' | '));

  const noToken = market.tokens.find((t: any) => t.outcome === 'No');
  if (!noToken) throw new Error('No token not found');

  console.log(`\nPlacing $1 limit BUY on NO @ $0.02 (far from market — won't fill)...`);

  const order = await client.createOrder({
    tokenID:    noToken.token_id,
    price:      0.02,   // 2¢ — far below current ~3¢ NO price, very unlikely to fill
    size:       50,     // 50 shares × $0.02 = $1
    side:       Side.BUY,
    feeRateBps: 0,
  });

  const resp = await client.postOrder(order, OrderType.GTC);
  console.log('\n📨 Response:', JSON.stringify(resp, null, 2));

  if (resp?.orderID && resp.orderID !== 'error') {
    console.log(`\n✅ Order placed! ID: ${resp.orderID}`);
    console.log('Cancelling test order...');
    await client.cancelOrder({ orderID: resp.orderID });
    console.log('✅ Cancelled. Full pipeline working!');
  } else {
    console.log('\n⚠️  Order not placed:', JSON.stringify(resp));
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
