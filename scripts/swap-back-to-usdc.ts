/**
 * Swap USDC.e → native USDC via Uniswap V3 on Polygon (no API key needed)
 */
import 'dotenv/config';

const { ethers } = require('../node_modules/@polymarket/clob-client/node_modules/ethers');

const POLYGON_RPC  = 'https://polygon-bor-rpc.publicnode.com';
const PRIVATE_KEY  = (process.env.POLYGON_PRIVATE_KEY || process.env.POLYMARKET_WALLET_PRIVATE_KEY)!;
const WALLET_ADDR  = '0xf1F343E277cAAAd505DBe3723d583db37a0379BD';

const USDC_E       = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NATIVE_USDC  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// Uniswap V3 SwapRouter02 on Polygon
const SWAP_ROUTER  = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// exactInputSingle ABI
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

async function trySwap(provider: any, signer: any, srcAmount: string, fee: number, gasPrice: any): Promise<boolean> {
  const router  = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, signer);
  const minOut  = Math.floor(Number(srcAmount) * 0.96).toString(); // 4% slippage
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

  console.log(`  Trying fee tier ${fee / 10000}%...`);
  try {
    const tx = await router.exactInputSingle(
      {
        tokenIn:            USDC_E,
        tokenOut:           NATIVE_USDC,
        fee,
        recipient:          WALLET_ADDR,
        amountIn:           srcAmount,
        amountOutMinimum:   minOut,
        sqrtPriceLimitX96:  0,
      },
      { gasPrice, gasLimit: 300_000, type: 0 },
    );
    console.log(`  Swap tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 0) { console.log('  Reverted.'); return false; }
    console.log(`  ✅ Confirmed in block ${receipt.blockNumber}`);
    return true;
  } catch (e: any) {
    console.log(`  Failed: ${e.reason || e.message?.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  const usdce    = new ethers.Contract(USDC_E, ERC20_ABI, signer);

  // ── 1. Balance ─────────────────────────────────────────────
  const rawBal: bigint = await usdce.balanceOf(WALLET_ADDR);
  console.log(`USDC.e: $${(Number(rawBal) / 1e6).toFixed(2)}`);
  if (Number(rawBal) < 1_000_000) { console.log('Nothing to swap.'); return; }
  const srcAmount = rawBal.toString();

  // ── 2. Gas price ───────────────────────────────────────────
  const feeData  = await provider.getFeeData();
  const baseFee  = feeData.lastBaseFeePerGas ?? ethers.BigNumber.from('100000000000');
  const gasPrice = baseFee.mul(150).div(100).add(ethers.BigNumber.from('30000000000'));
  console.log(`Gas: ${ethers.utils.formatUnits(gasPrice, 'gwei')} Gwei`);

  // ── 3. Approve Uniswap router ─────────────────────────────
  const allowance: bigint = await usdce.allowance(WALLET_ADDR, SWAP_ROUTER);
  if (allowance < BigInt(srcAmount)) {
    console.log('Approving USDC.e for Uniswap V3...');
    const approveTx = await usdce.approve(
      SWAP_ROUTER,
      ethers.constants.MaxUint256,
      { gasPrice, gasLimit: 100_000, type: 0 },
    );
    await approveTx.wait();
    console.log(`✅ Approved: ${approveTx.hash}`);
  } else {
    console.log('Already approved');
  }

  // ── 4. Try fee tiers (0.01%, 0.05%, 0.3%) ─────────────────
  // Refresh gas after approval
  const feeData2  = await provider.getFeeData();
  const baseFee2  = feeData2.lastBaseFeePerGas ?? ethers.BigNumber.from('100000000000');
  const gasPrice2 = baseFee2.mul(150).div(100).add(ethers.BigNumber.from('30000000000'));

  const feeTiers = [100, 500, 3000];  // 0.01%, 0.05%, 0.3%
  for (const fee of feeTiers) {
    const ok = await trySwap(provider, signer, srcAmount, fee, gasPrice2);
    if (ok) break;
  }

  // ── 5. Final balances ──────────────────────────────────────
  const nativeUsdc = new ethers.Contract(NATIVE_USDC, ERC20_ABI, provider);
  const [nativeBal, usdceBal] = await Promise.all([
    nativeUsdc.balanceOf(WALLET_ADDR),
    usdce.balanceOf(WALLET_ADDR),
  ]);
  console.log(`\nNative USDC: $${(Number(nativeBal) / 1e6).toFixed(2)}`);
  console.log(`USDC.e:      $${(Number(usdceBal)   / 1e6).toFixed(2)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
