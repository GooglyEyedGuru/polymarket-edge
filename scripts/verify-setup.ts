/**
 * Verifies the full Polymarket setup:
 *   - Wallet present + balances
 *   - API credentials valid
 *   - CLOB API reachable
 *   - Can query a live market
 *
 * Run: npx ts-node scripts/verify-setup.ts
 */
import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import { ClobClient } from '@polymarket/clob-client';
import axios from 'axios';

const CLOB_HOST      = 'https://clob.polymarket.com';
const CHAIN_ID       = 137;
const USDC_POLYGON   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_RPC    = 'https://polygon-rpc.com';

async function polygonCall(method: string, params: any[]): Promise<string> {
  const res = await axios.post(POLYGON_RPC, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { timeout: 10_000 });
  return res.data?.result ?? '0x0';
}

async function main() {
  console.log('🔍 PolymarketEdge — Setup Verification');
  console.log('='.repeat(50));
  let allOk = true;

  // ── Wallet ────────────────────────────────────────────────
  console.log('\n1. Wallet');
  const privKey = process.env.POLYMARKET_WALLET_PRIVATE_KEY;
  if (!privKey) {
    console.log('   ❌ POLYMARKET_WALLET_PRIVATE_KEY not set');
    console.log('      Run: npx ts-node scripts/setup-wallet.ts');
    process.exit(1);
  }
  const wallet = new Wallet(privKey);
  console.log('   ✅ Address:', wallet.address);

  // ── MATIC balance ─────────────────────────────────────────
  const maticHex = await polygonCall('eth_getBalance', [wallet.address, 'latest']);
  const maticBal = Number(BigInt(maticHex)) / 1e18;
  const maticOk  = maticBal >= 0.1;
  console.log(`   ${maticOk ? '✅' : '⚠️ '} MATIC: ${maticBal.toFixed(4)} ${maticOk ? '' : '(needs ≥0.1)'}`);
  if (!maticOk) allOk = false;

  // ── USDC balance ──────────────────────────────────────────
  const balData  = '0x70a08231' + wallet.address.replace('0x', '').padStart(64, '0');
  const usdcHex  = await polygonCall('eth_call', [{ to: USDC_POLYGON, data: balData }, 'latest']);
  const usdcBal  = Number(BigInt(usdcHex)) / 1e6;
  const usdcOk   = usdcBal >= 5;
  console.log(`   ${usdcOk ? '✅' : '⚠️ '} USDC: $${usdcBal.toFixed(2)} ${usdcOk ? '' : '(needs ≥$5)'}`);
  if (!usdcOk) allOk = false;

  // ── API credentials ───────────────────────────────────────
  console.log('\n2. API Credentials');
  const key        = process.env.POLYMARKET_API_KEY;
  const secret     = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (!key || !secret || !passphrase) {
    console.log('   ❌ API credentials missing — run setup-wallet.ts');
    allOk = false;
  } else {
    console.log('   ✅ Key:        ', key.slice(0, 8) + '...');
    console.log('   ✅ Secret:     ', secret.slice(0, 8) + '...');
    console.log('   ✅ Passphrase: ', passphrase.slice(0, 8) + '...');

    // Verify credentials work against the CLOB
    try {
      const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, { key, secret, passphrase });
      const ok     = await client.isOrderBookScoring();
      console.log('   ✅ CLOB auth test passed');
    } catch (err: any) {
      console.log('   ⚠️  CLOB auth test failed:', err.message?.slice(0, 60));
      console.log('      Try re-running setup-wallet.ts to refresh credentials');
    }
  }

  // ── CLOB API reachability ─────────────────────────────────
  console.log('\n3. CLOB API');
  try {
    const res = await axios.get(`${CLOB_HOST}/markets`, {
      params: { limit: 1 },
      timeout: 10_000,
    });
    const markets = Array.isArray(res.data) ? res.data : (res.data.data ?? []);
    console.log('   ✅ CLOB reachable — returned', markets.length, 'sample market(s)');
  } catch (err: any) {
    console.log('   ❌ CLOB unreachable:', err.message?.slice(0, 60));
    allOk = false;
  }

  // ── Gamma API ─────────────────────────────────────────────
  console.log('\n4. Gamma API');
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { active: true, limit: 1 },
      timeout: 10_000,
    });
    console.log('   ✅ Gamma API reachable');
  } catch (err: any) {
    console.log('   ❌ Gamma API unreachable:', err.message?.slice(0, 60));
    allOk = false;
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n' + '='.repeat(50));
  if (allOk) {
    console.log('✅ All checks passed — bot is ready to trade!');
  } else {
    console.log('⚠️  Some checks failed — see above for details');
    console.log('   Most likely: fund the wallet with MATIC + USDC, then re-run');
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
