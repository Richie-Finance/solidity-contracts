import { Contract, getAddress } from "ethers";
import { address, code, context, deploy, entry, uint, type Context } from "./helpers.js";

const WPLS = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
const DAI = "0xefD766cCb38EaF1dfd701853BFCe31359239F305";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const asset = address("TOMB_REBATE_ASSET_TOKEN_ADDRESS");
  const pairAddress = address("TOMB_REBATE_ASSET_PAIR_ADDRESS");
  if (asset === getAddress(WPLS) || asset === getAddress(DAI)) {
    throw new Error("Rebate composite asset must be different from WPLS and official DAI");
  }
  await code(ctx, asset);
  await code(ctx, pairAddress);
  const pair = new Contract(pairAddress, [
    "function token0() view returns(address)",
    "function token1() view returns(address)",
    "function getReserves() view returns(uint112,uint112,uint32)",
  ], ctx.signer);
  const tokens = [getAddress(await pair.token0()), getAddress(await pair.token1())];
  if (!tokens.includes(asset) || !tokens.includes(getAddress(WPLS))) {
    throw new Error("Rebate asset pair must contain the configured asset and WPLS");
  }
  const reserves = await pair.getReserves();
  if (reserves[0] === 0n || reserves[1] === 0n) throw new Error("Rebate asset/WPLS pair needs liquidity first");
  const period = uint("TOMB_REBATE_ASSET_ORACLE_PERIOD", 3600n);
  const start = uint("TOMB_REBATE_ASSET_ORACLE_START_TIME");
  if (period < 3600n || period > 172800n || start < period) {
    throw new Error("Oracle period must be 1–48 hours and start >= period");
  }
  return deploy(ctx, "oracle", "TOMB_REBATE_ASSET_ORACLE_ADDRESS", [pairAddress, period, start]);
}
await entry(import.meta.url, () => main());
