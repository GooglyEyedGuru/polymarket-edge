/**
 * Generate Polymarket CLOB API credentials (v5 client, EOA/signatureType=0).
 * Run once: npx ts-node scripts/gen-api-key.ts
 */
import 'dotenv/config';
import { ClobClient, Chain } from '@polymarket/clob-client';

const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

const CLOB_HOST = 'https://clob.polymarket.com';
const PRIVATE_KEY = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;

async function main() {
  if (!PRIVATE_KEY) throw new Error('POLYMARKET_WALLET_PRIVATE_KEY not set');

  const key    = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers5.Wallet(key);
  console.log('Wallet address:', wallet.address);

  // signatureType=0 = EOA (direct MetaMask wallet, no funder proxy)
  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, undefined, 0);

  console.log('Calling createApiKey (nonce=0)...');
  try {
    const creds = await client.createApiKey(0);
    console.log('Raw createApiKey response:', JSON.stringify(creds, null, 2));

    if (creds.key) {
      console.log('\n✅ Add to .env:');
      console.log('POLYMARKET_API_KEY=' + creds.key);
      console.log('POLYMARKET_API_SECRET=' + creds.secret);
      console.log('POLYMARKET_API_PASSPHRASE=' + creds.passphrase);
    } else {
      console.log('\n⚠️  No key returned — trying deriveApiKey...');
      const derived = await client.deriveApiKey(0);
      console.log('Derived:', JSON.stringify(derived, null, 2));
    }
  } catch (e: any) {
    console.error('createApiKey error:', e.message);
    console.error('Full error:', JSON.stringify(e.response?.data ?? e, null, 2));
  }
}

main().catch(console.error);
