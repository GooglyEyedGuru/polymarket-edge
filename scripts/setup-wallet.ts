/**
 * Polymarket wallet + API key setup script.
 *
 * What this does:
 *   1. Generates a new Polygon EOA wallet (or loads existing from POLYMARKET_WALLET_PRIVATE_KEY)
 *   2. Calls Polymarket CLOB to derive API key/secret/passphrase from the wallet signature
 *   3. Writes all credentials to .env
 *   4. Prints a funding checklist
 *
 * Run: npx ts-node scripts/setup-wallet.ts
 * Re-run safely — if wallet already exists in .env it will just re-derive the API key.
 */
import * as fs   from 'fs';
import * as path from 'path';
import { Wallet } from '@ethersproject/wallet';
import { ClobClient } from '@polymarket/clob-client';

const ENV_PATH  = path.join(__dirname, '../.env');
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID  = 137;   // Polygon mainnet

// ── Read current .env ─────────────────────────────────────────
function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

// ── Write a key=value pair into .env (update existing or append) ──
function writeEnvKey(key: string, value: string): void {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line  = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content);
}

// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🎯 PolymarketEdge — Wallet & API Key Setup');
  console.log('='.repeat(50));

  const env = readEnv();

  // ── Step 1: Wallet ────────────────────────────────────────
  let wallet: Wallet;
  let isNew = false;

  if (env.POLYMARKET_WALLET_PRIVATE_KEY) {
    console.log('\n✅ Existing wallet found in .env');
    wallet = new Wallet(env.POLYMARKET_WALLET_PRIVATE_KEY);
    console.log('   Address:', wallet.address);
  } else {
    console.log('\n🔑 Generating new Polygon wallet...');
    wallet  = Wallet.createRandom();
    isNew   = true;
    writeEnvKey('POLYMARKET_WALLET_PRIVATE_KEY', wallet.privateKey);
    console.log('   ✅ New wallet created');
    console.log('   Address:     ', wallet.address);
    console.log('   Private key: ', wallet.privateKey);
    console.log('\n   ⚠️  SAVE THIS PRIVATE KEY SOMEWHERE SAFE — it is only shown once');
  }

  // ── Step 2: Derive API credentials ───────────────────────
  console.log('\n🔐 Deriving Polymarket API credentials...');
  console.log('   (This signs a message with your wallet — no gas needed)');

  try {
    const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds  = await client.createOrDeriveApiKey();

    console.log('   ✅ API credentials derived:');
    console.log('   Key:        ', creds.key);
    console.log('   Secret:     ', creds.secret.slice(0, 8) + '...');
    console.log('   Passphrase: ', creds.passphrase.slice(0, 8) + '...');

    writeEnvKey('POLYMARKET_API_KEY',        creds.key);
    writeEnvKey('POLYMARKET_API_SECRET',     creds.secret);
    writeEnvKey('POLYMARKET_API_PASSPHRASE', creds.passphrase);
    writeEnvKey('POLYMARKET_WALLET_ADDRESS', wallet.address);

    console.log('\n   ✅ Credentials written to .env');
  } catch (err: any) {
    console.error('\n❌ Failed to derive API key:', err.message);
    if (err.response?.data) {
      console.error('   API response:', JSON.stringify(err.response.data));
    }
    console.log('\n   This can happen if the wallet has never interacted with Polymarket.');
    console.log('   → Fund the wallet first (see checklist below), then re-run this script.');
    console.log('   → Or visit https://polymarket.com and connect this wallet manually.\n');
  }

  // ── Step 3: Funding checklist ─────────────────────────────
  console.log('\n─────────────────────────────────────────────────────');
  console.log('📋 Funding Checklist');
  console.log('─────────────────────────────────────────────────────');
  console.log('');
  console.log('Your Polygon wallet address:');
  console.log('  ' + wallet.address);
  console.log('');
  console.log('1. Fund with MATIC for gas (~0.5 MATIC is plenty)');
  console.log('   Bridge: https://wallet.polygon.technology/');
  console.log('   Or buy MATIC directly on Coinbase/Binance and withdraw to Polygon');
  console.log('');
  console.log('2. Fund with USDC on Polygon (your trading capital)');
  console.log('   Bridge USDC: https://across.to (cheapest) or https://app.hop.exchange');
  console.log('   Or buy USDC on an exchange and withdraw directly to Polygon');
  console.log('');
  console.log('3. Approve USDC for Polymarket CTF contract (one-time, ~$0.01 gas)');
  console.log('   This happens automatically on first trade via the CLOB client');
  console.log('');
  console.log('4. Verify everything works:');
  console.log('   npx ts-node scripts/verify-setup.ts');
  console.log('');

  // ── Check current status ──────────────────────────────────
  await checkOnChainStatus(wallet.address);
}

async function checkOnChainStatus(address: string) {
  try {
    const axios = (await import('axios')).default;

    // Check MATIC balance via Polygon RPC
    const rpcRes = await axios.post('https://polygon-rpc.com', {
      jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
      params: [address, 'latest'],
    }, { timeout: 10_000 });

    const maticWei = BigInt(rpcRes.data?.result ?? '0x0');
    const maticBal = Number(maticWei) / 1e18;

    // Check USDC balance (USDC on Polygon: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)
    const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const balanceData  = '0x70a08231' + address.replace('0x', '').padStart(64, '0');
    const usdcRes = await axios.post('https://polygon-rpc.com', {
      jsonrpc: '2.0', id: 2, method: 'eth_call',
      params: [{ to: USDC_POLYGON, data: balanceData }, 'latest'],
    }, { timeout: 10_000 });

    const usdcRaw = BigInt(usdcRes.data?.result ?? '0x0');
    const usdcBal = Number(usdcRaw) / 1e6;

    console.log('─────────────────────────────────────────────────────');
    console.log('💰 Current On-Chain Balances (Polygon)');
    console.log('─────────────────────────────────────────────────────');
    console.log(`   MATIC: ${maticBal.toFixed(4)} ${maticBal >= 0.1 ? '✅' : '⚠️  needs funding'}`);
    console.log(`   USDC:  $${usdcBal.toFixed(2)} ${usdcBal >= 10 ? '✅' : '⚠️  needs funding'}`);
    console.log('');

    if (maticBal < 0.1 || usdcBal < 10) {
      console.log('  Next step: fund the wallet, then re-run:');
      console.log('  npx ts-node scripts/setup-wallet.ts');
    } else {
      console.log('  ✅ Wallet looks funded. Ready to trade!');
    }
  } catch (err: any) {
    console.log('  (Could not check on-chain balance — check manually)');
  }
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
