/**
 * Verify Polymarket API credentials with server time sync.
 */
import 'dotenv/config';
import { ClobClient, ApiKeyCreds, Chain } from '@polymarket/clob-client';

const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

const CLOB_HOST = 'https://clob.polymarket.com';

async function main() {
  const key    = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const wallet = new ethers5.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  console.log('Wallet:', wallet.address);

  const creds: ApiKeyCreds = {
    key:        process.env.POLYMARKET_API_KEY!,
    secret:     process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
  };

  // Use server time to avoid clock drift issues
  // constructor: host, chainId, signer, creds, signatureType, funderAddress, geoBlockToken, useServerTime
  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, undefined, undefined, undefined, true);

  // 1. Check server time
  const serverTime = await client.getServerTime();
  const localTime  = Math.floor(Date.now() / 1000);
  console.log(`Server time: ${serverTime} | Local time: ${localTime} | Drift: ${Math.abs(serverTime - localTime)}s`);

  // 2. Try re-deriving the key (deterministic)
  console.log('\nRe-deriving API key from wallet...');
  const derived = await client.deriveApiKey(0);
  console.log('Derived key:', derived.key);
  console.log('Matches stored key:', derived.key === creds.key);

  // 3. Check our API keys
  console.log('\nFetching API keys...');
  const apiKeys = await client.getApiKeys();
  console.log('Result:', JSON.stringify(apiKeys, null, 2));
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
