/**
 * Force the Polymarket CLOB to refresh its view of your wallet balance/allowance.
 * Run this once with IPVanish connected to an EU server.
 */
import 'dotenv/config';
import { ClobClient, ApiKeyCreds, Chain, AssetType } from '@polymarket/clob-client';
import path from 'path';

const ethers5 = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));

const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';

async function main() {
  const pk     = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const wallet = new ethers5.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
  console.log('Wallet:', wallet.address);

  const creds: ApiKeyCreds = {
    key:        process.env.POLYMARKET_API_KEY!,
    secret:     process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
  };

  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, 0);

  console.log('\nChecking current CLOB balance...');
  const before = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('Before:', JSON.stringify(before));

  console.log('\nTriggering CLOB balance update...');
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });

  // Wait a moment for the update to propagate
  await new Promise(r => setTimeout(r, 3000));

  console.log('\nChecking updated CLOB balance...');
  const after = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('After:', JSON.stringify(after, null, 2));

  const bal = parseFloat(after?.balance ?? '0');
  if (bal > 0) {
    console.log(`\n✅ CLOB now sees $${bal / 1e6} USDC — ready to trade!`);
  } else {
    console.log('\n⚠️  Still showing 0 — may need a moment to propagate.');
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
