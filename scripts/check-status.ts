/**
 * Check wallet status with Polymarket CLOB.
 */
import 'dotenv/config';
import { ClobClient, Chain } from '@polymarket/clob-client';
import axios from 'axios';

const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');
const CLOB_HOST = 'https://clob.polymarket.com';

async function main() {
  const key    = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const wallet = new ethers5.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  console.log('Wallet:', wallet.address);

  // Check ban status (L1 auth endpoint)
  const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);

  // Try readonly API key (no ToS needed?)
  try {
    console.log('\nTrying createApiKey...');
    const creds = await client.createApiKey(0);
    console.log('createApiKey response:', JSON.stringify(creds));
  } catch (e: any) {
    console.log('createApiKey error:', e.message);
  }

  // Check what ban-status says
  try {
    const resp = await axios.get(`${CLOB_HOST}/auth/ban-status/closed-only`);
    console.log('\nBan status:', resp.data);
  } catch (e: any) {
    console.log('\nBan status error:', e.response?.data ?? e.message);
  }

  // Try the gamma/trades endpoint to see if wallet has history  
  try {
    const resp = await axios.get(`https://gamma-api.polymarket.com/trades?maker=${wallet.address}&limit=5`);
    console.log('\nTrade history:', JSON.stringify(resp.data).substring(0, 200));
  } catch (e: any) {
    console.log('\nTrade history error:', e.response?.data ?? e.message);
  }
}

main().catch(console.error);
