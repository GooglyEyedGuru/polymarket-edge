/**
 * Executor — places limit orders on the Polymarket CLOB.
 * Uses @polymarket/clob-client for order signing and submission.
 * All trades go through the Polygon L2.
 */
import { ClobClient, ApiKeyCreds, Chain, Side, OrderType } from '@polymarket/clob-client';
import { POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE, POLY_WALLET_KEY } from '../config';
import { PricerResult, Position } from '../types';

const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';

// Use ethers v5 (bundled inside clob-client) for wallet signing
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

// ── Build authenticated CLOB client ──────────────────────────
function buildClient(): ClobClient {
  if (!POLY_WALLET_KEY) {
    throw new Error('POLYMARKET_WALLET_PRIVATE_KEY not set — cannot execute trades');
  }

  const key    = POLY_WALLET_KEY.startsWith('0x') ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`;
  const wallet = new ethers5.Wallet(key);

  const creds: ApiKeyCreds = {
    key:        POLY_API_KEY,
    secret:     POLY_API_SECRET,
    passphrase: POLY_API_PASSPHRASE,
  };

  // signatureType=0 = EOA (direct MetaMask/hardware wallet, no proxy)
  return new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, 0);
}

// ── Get token ID for the desired side ────────────────────────
function getTokenId(market: any, side: 'Yes' | 'No'): string {
  const token = market.tokens.find((t: any) =>
    t.outcome.toLowerCase() === side.toLowerCase()
  );
  if (!token?.token_id) throw new Error(`No token ID found for ${side} in market ${market.condition_id}`);
  return token.token_id;
}

// ── Place a limit order ───────────────────────────────────────
export async function placeOrder(
  pricerResult: PricerResult,
  market:       any,
  sizeUsdc:     number,
): Promise<{ txHash: string; orderId: string } | null> {
  if (!POLY_WALLET_KEY || !POLY_API_KEY) {
    console.log('   ⚠️  No credentials — dry run (order NOT placed)');
    return { txHash: 'dry-run', orderId: 'dry-run' };
  }

  try {
    const client  = buildClient();
    const tokenId = getTokenId(market, pricerResult.side as 'Yes' | 'No');
    const price   = pricerResult.implied_prob;   // buy at current implied, not our fair
    const size    = sizeUsdc / price;            // shares = USDC / price

    console.log(`   📤 Placing limit ${pricerResult.side} @ $${price.toFixed(4)} x ${size.toFixed(2)} shares ($${sizeUsdc.toFixed(2)})`);

    const orderArgs = {
      tokenID:   tokenId,
      price,
      size,
      side:      Side.BUY,
      orderType: OrderType.GTC,  // Good Till Cancelled
    };

    const signedOrder = await client.createOrder(orderArgs);
    const response    = await client.postOrder(signedOrder, OrderType.GTC);

    if (!response?.orderID) {
      throw new Error(`CLOB returned no orderID: ${JSON.stringify(response)}`);
    }

    console.log(`   ✅ Order placed: ${response.orderID}`);
    return { txHash: response.transactionHash ?? '', orderId: response.orderID };

  } catch (err: any) {
    console.error(`   ❌ Order failed: ${err.message}`);
    return null;
  }
}

// ── Fetch current position on-chain ──────────────────────────
export async function getMarketPrice(tokenId: string): Promise<number | null> {
  try {
    const client  = buildClient();
    const book    = await client.getOrderBook(tokenId);
    if (!book?.bids?.length && !book?.asks?.length) return null;
    const bestBid = book.bids?.[0]?.price  ?? 0;
    const bestAsk = book.asks?.[0]?.price  ?? 1;
    return (Number(bestBid) + Number(bestAsk)) / 2;
  } catch { return null; }
}

// ── Cancel an order ───────────────────────────────────────────
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const client = buildClient();
    await client.cancelOrder({ orderID: orderId });
    return true;
  } catch { return false; }
}
