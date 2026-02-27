/**
 * sell-position.ts
 * Manually sell a position by token ID via the CLOB.
 * Usage: npx ts-node scripts/sell-position.ts <tokenId> <shares>
 * Example: npx ts-node scripts/sell-position.ts 55001453... 90.5
 *
 * If shares is omitted, it will attempt to sell 100% of available shares.
 */
import 'dotenv/config';
import path from 'path';
import { ClobClient, ApiKeyCreds, Chain, Side, OrderType } from '@polymarket/clob-client';

const ethers5 = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));

const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';

const tokenId  = process.argv[2];
const sharesArg = process.argv[3] ? Number(process.argv[3]) : null;

if (!tokenId) {
  console.error('Usage: npx ts-node scripts/sell-position.ts <tokenId> [shares]');
  process.exit(1);
}

async function main() {
  const key    = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const wallet = new ethers5.Wallet(key.startsWith('0x') ? key : `0x${key}`);

  const creds: ApiKeyCreds = {
    key:        process.env.POLYMARKET_API_KEY!,
    secret:     process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
  };

  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, 0);

  // Get current order book
  console.log('📖 Fetching order book...');
  const book    = await client.getOrderBook(tokenId);
  const bestBid = book?.bids?.[0]?.price ? Number(book.bids[0].price) : null;
  const bestAsk = book?.asks?.[0]?.price ? Number(book.asks[0].price) : null;

  console.log(`   Best bid: ${bestBid ? (bestBid * 100).toFixed(1) + '¢' : 'none'}`);
  console.log(`   Best ask: ${bestAsk ? (bestAsk * 100).toFixed(1) + '¢' : 'none'}`);

  if (!bestBid) {
    console.error('❌ No bids available — cannot sell right now');
    process.exit(1);
  }

  const price  = Math.round(bestBid * 100) / 100;
  const shares = sharesArg ?? 90.5;   // default to Seoul position size

  console.log(`\n📤 Placing SELL: ${shares} shares @ ${(price * 100).toFixed(0)}¢`);
  console.log(`   Estimated proceeds: $${(shares * price).toFixed(2)} USDC`);

  const orderArgs = {
    tokenID:   tokenId,
    price,
    size:      shares,
    side:      Side.SELL,
    orderType: OrderType.GTC,
  };

  const signedOrder = await client.createOrder(orderArgs);
  const response    = await client.postOrder(signedOrder, OrderType.GTC);

  if (!response?.orderID) {
    console.error('❌ No orderID returned:', JSON.stringify(response));
    process.exit(1);
  }

  console.log(`\n✅ Sell order placed!`);
  console.log(`   Order ID: ${response.orderID}`);
  console.log(`   Tx:       ${response.transactionHash ?? 'pending'}`);
  console.log(`   Expected PnL vs 13¢ entry: +$${((price - 0.13) * shares).toFixed(2)} USDC`);
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
