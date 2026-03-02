/**
 * force-approval.ts
 * Force-submits setApprovalForAll(NegRiskAdapter, true) on CTF
 * with explicit nonce override and high gas — replaces any stuck mempool tx.
 */
import 'dotenv/config';
import path from 'path';

const ethers = require(path.join(process.cwd(), 'node_modules/@polymarket/clob-client/node_modules/ethers'));

const CTF_ADDRESS      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const CTF_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const RPCS = [
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com',
  'https://polygon-bor-rpc.publicnode.com',
];

async function main() {
  const privateKey = process.env.POLYMARKET_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error('POLYMARKET_WALLET_PRIVATE_KEY not set in .env');

  // Try each RPC until one works
  let provider: any = null;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpc);
      await p.getBlockNumber();
      provider = p;
      console.log(`✅ Connected to: ${rpc}`);
      break;
    } catch (e) {
      console.log(`⚠️  Failed: ${rpc}`);
    }
  }
  if (!provider) throw new Error('All RPCs failed');

  const wallet = new ethers.Wallet(
    privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
    provider,
  );

  console.log(`\n🔑 Wallet: ${wallet.address}`);

  // Check current approval state
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
  
  if (isApproved) {
    console.log('✅ Already approved! NegRiskAdapter is set on CTF.');
    console.log('→ Just run redeem-position.ts again — it will skip straight to redemption.');
    return;
  }

  // Get nonces
  const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest');
  const pendingNonce   = await provider.getTransactionCount(wallet.address, 'pending');
  console.log(`\n📊 Nonce — confirmed: ${confirmedNonce}, pending: ${pendingNonce}`);

  // Get current gas price from network
  const feeData = await provider.getFeeData();
  const currentBase = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('50', 'gwei');
  // Use 3× current base + 50 gwei tip to blast through
  const maxFee      = currentBase.mul(3).add(ethers.utils.parseUnits('50', 'gwei'));
  const priorityFee = ethers.utils.parseUnits('50', 'gwei');

  console.log(`⛽ Gas: maxFee=${ethers.utils.formatUnits(maxFee,'gwei').slice(0,6)} gwei, priority=50 gwei`);
  console.log(`🔢 Using nonce: ${confirmedNonce} (replaces any stuck pending tx)`);

  console.log('\n🔓 Sending setApprovalForAll(NegRiskAdapter, true)...');
  const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, {
    nonce:                confirmedNonce,
    gasLimit:             150000,
    maxFeePerGas:         maxFee,
    maxPriorityFeePerGas: priorityFee,
  });

  console.log(`📤 Tx sent: ${tx.hash}`);
  console.log('⏳ Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log(`✅ Confirmed! Block: ${receipt.blockNumber}`);
  console.log('\n→ Now run: npx ts-node scripts/redeem-position.ts');
}

main().catch(e => {
  console.error('❌', e.message || e);
  process.exit(1);
});
