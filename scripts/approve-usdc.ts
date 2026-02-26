/**
 * Approve USDC for Polymarket CTF Exchange contracts on Polygon.
 * Must be run before placing any trades.
 */
import 'dotenv/config';

const ethers5 = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const SPENDERS = [
  { name: 'CTF Exchange',     addr: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
  { name: 'NegRisk Exchange', addr: '0xC5d563A36AE78145C45a50134d48A1215220f80a' },
  { name: 'NegRisk Adapter',  addr: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const MAX_UINT256 = ethers5.constants.MaxUint256;

async function getGasParams(provider: any) {
  const feeData = await provider.getFeeData();
  // Use 2x current gas price as maxFee, 1.5x as tip — ensures fast inclusion
  const baseFee = feeData.lastBaseFeePerGas ?? ethers5.utils.parseUnits('50', 'gwei');
  const maxPriorityFeePerGas = ethers5.utils.parseUnits('40', 'gwei');
  const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);
  console.log(`  Gas: maxFee=${ethers5.utils.formatUnits(maxFeePerGas, 'gwei')} gwei, tip=${ethers5.utils.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);
  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function main() {
  const pk     = process.env.POLYMARKET_WALLET_PRIVATE_KEY!;
  const key    = pk.startsWith('0x') ? pk : `0x${pk}`;
  const provider = new ethers5.providers.JsonRpcProvider(RPC);
  const wallet   = new ethers5.Wallet(key, provider);
  const usdc     = new ethers5.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  const bal = await usdc.balanceOf(wallet.address);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`USDC balance: $${ethers5.utils.formatUnits(bal, 6)}\n`);

  for (const spender of SPENDERS) {
    const current = await usdc.allowance(wallet.address, spender.addr);
    console.log(`${spender.name}: current allowance = ${ethers5.utils.formatUnits(current, 6)} USDC`);

    if (current.gte(ethers5.utils.parseUnits('1000000', 6))) {
      console.log(`  ✅ Already approved\n`);
      continue;
    }

    const gasParams = await getGasParams(provider);
    console.log(`  📤 Approving max USDC...`);
    const tx = await usdc.approve(spender.addr, MAX_UINT256, {
      gasLimit: 100000,
      ...gasParams,
    });
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  ✅ Confirmed in block ${receipt.blockNumber}\n`);
  }

  console.log('✅ All Polymarket contracts approved!');
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
