/**
 * redeem-position.ts
 * Redeems a resolved NegRisk YES position on Polymarket (Polygon).
 *
 * Usage: npx ts-node scripts/redeem-position.ts
 *
 * Reads POLYMARKET_WALLET_PRIVATE_KEY from .env — key stays on your machine.
 *
 * Steps:
 *   1. Checks your ERC1155 YES token balance in the CTF contract
 *   2. Approves NegRiskAdapter on CTF if not already approved
 *   3. Calls NegRiskAdapter.redeemPositions → receives USDC.e
 */

import 'dotenv/config';
import path from 'path';

// Use ethers bundled with clob-client (same as sell-position.ts)
const ethers = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));

// ── Polygon addresses ──────────────────────────────────────────
const POLYGON_RPC      = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const USDC_E           = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ── Ankara position (resolved YES ✅) ──────────────────────────
const CONDITION_ID  = '0x9c6f21408a7fc529cc3766c9c297a95eddb8d05276e0871235fbd56e28bae1a4';
const YES_TOKEN_ID  = '73487793052420733135660086895111207341021106965609716362284492205689704627677';

// ── Minimal ABIs ───────────────────────────────────────────────
const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts)',
  'function wcol() view returns (address)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function main() {
  const privateKey = process.env.POLYMARKET_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error('POLYMARKET_WALLET_PRIVATE_KEY not set in .env');

  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  const wallet   = new ethers.Wallet(
    privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
    provider,
  );

  console.log(`\n🔑 Wallet:    ${wallet.address}`);
  console.log(`📍 Network:   Polygon`);
  console.log(`🎯 Position:  Ankara 8°C or higher (resolved YES ✅)\n`);

  const ctf       = new ethers.Contract(CTF_ADDRESS,      CTF_ABI,      wallet);
  const adapter   = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
  const usdc      = new ethers.Contract(USDC_E,           USDC_ABI,     provider);

  // ── 1. Check USDC.e balance before ──────────────────────────
  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log(`💵 USDC.e before: $${(usdcBefore / 1e6).toFixed(2)}`);

  // ── 2. Get wcol address and compute YES position ID ──────────
  const wcolAddress  = await adapter.wcol();
  console.log(`🏦 wcol address:  ${wcolAddress}`);

  // YES = indexSet 1 (0b01), NO = indexSet 2 (0b10)
  const yesCollectionId = await ctf.getCollectionId(
    ethers.constants.HashZero,
    CONDITION_ID,
    1,
  );
  const yesPositionId = await ctf.getPositionId(wcolAddress, yesCollectionId);
  console.log(`🪙  YES token ID: ${yesPositionId.toString()}`);

  // Also check using the Polymarket API token ID directly
  const balanceFromApi = await ctf.balanceOf(wallet.address, YES_TOKEN_ID);
  const balanceComputed = await ctf.balanceOf(wallet.address, yesPositionId.toString());
  console.log(`📊 Balance (API token ID):      ${balanceFromApi.toString()}`);
  console.log(`📊 Balance (computed token ID): ${balanceComputed.toString()}`);

  const balance = balanceComputed.gt(0) ? balanceComputed : balanceFromApi;

  if (balance.eq(0)) {
    console.log('\n⚠️  No YES tokens found in wallet — may already be redeemed or held elsewhere');
    console.log('Checking Polymarket API...');
    console.log('If balance shows on polymarket.com but not here, tokens may be in a proxy contract.');
    process.exit(0);
  }

  console.log(`\n✅ Found ${(balance / 1e6).toFixed(4)} YES tokens worth ~$${(balance / 1e6).toFixed(2)} USDC.e`);

  // ── 3. Check / set approval for NegRiskAdapter ───────────────
  const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
  if (!isApproved) {
    console.log('\n🔓 Approving NegRiskAdapter on CTF...');
    const approveTx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, {
      gasLimit: 100000,
      maxFeePerGas:         ethers.utils.parseUnits('200', 'gwei'),
      maxPriorityFeePerGas: ethers.utils.parseUnits('30',  'gwei'),
    });
    await approveTx.wait();
    console.log(`✅ Approved — tx: ${approveTx.hash}`);
  } else {
    console.log('✅ NegRiskAdapter already approved on CTF');
  }

  // ── 4. Redeem — [yesAmount, 0 noTokens] ──────────────────────
  const useBalance = balanceComputed.gt(0) ? balanceComputed : balanceFromApi;
  const amounts    = [useBalance, ethers.BigNumber.from(0)];
  const useCondition = CONDITION_ID;

  console.log(`\n💸 Redeeming ${(useBalance / 1e6).toFixed(4)} YES tokens...`);

  const tx = await adapter.redeemPositions(useCondition, amounts, {
    gasLimit: 300000,
    maxFeePerGas:         ethers.utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('30',  'gwei'),
  });

  console.log(`📤 Transaction sent: ${tx.hash}`);
  console.log('⏳ Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

  // ── 5. Check USDC.e balance after ────────────────────────────
  const usdcAfter = await usdc.balanceOf(wallet.address);
  const received  = (usdcAfter - usdcBefore) / 1e6;

  console.log(`\n🎉 Done!`);
  console.log(`   USDC.e before: $${(usdcBefore / 1e6).toFixed(2)}`);
  console.log(`   USDC.e after:  $${(usdcAfter  / 1e6).toFixed(2)}`);
  console.log(`   Received:      $${received.toFixed(2)} 💵`);
  console.log(`\nNext step: bridge USDC.e (Polygon) → USDC (Solana) to top up the trading bot.`);
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  if (e.data) console.error('   Data:', e.data);
  process.exit(1);
});
