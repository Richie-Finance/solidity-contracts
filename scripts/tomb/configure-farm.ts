import { address, authority, code, context, contract, entry, flag, jsonArray, jsonUint, send, uint, type Context } from "./helpers.js";
import { Contract, getAddress, isAddress, ZeroAddress } from "ethers";

type Pool = { token: string; allocPoint: string | number };
export async function main(ctx?: Context) {
  ctx ??= await context();
  const farm = await contract(ctx, "farm", "TOMB_FARM_ADDRESS");
  await authority(ctx, farm);
  const fee = uint("TOMB_PSM_FEE_BPS", 3000n);
  const age = uint("TOMB_PSM_MAX_ORACLE_AGE", 7200n);
  const threshold = uint("TOMB_MIN_CLAIM_THRESHOLD", 1000000000000n);
  const currentEnabled = await farm.pegStabilityModuleFeeEnabled();
  // An omitted flag means "leave the live setting unchanged". Defaulting an
  // active Farm to false would silently create a fee-free harvest state.
  const enabled = process.env.TOMB_PSM_ENABLED
    ? flag("TOMB_PSM_ENABLED")
    : currentEnabled;
  const recipient = address("TOMB_PSM_FEE_RECIPIENT");
  if (fee > 5000n || age < 300n || age > 604800n || threshold > 10n ** 18n) throw new Error("Invalid farm fee, max oracle age, or claim threshold");
  const pools = process.env.TOMB_FARM_POOLS ? jsonArray<Pool>("TOMB_FARM_POOLS") : [];
  const seen = new Set<string>();
  for (const pool of pools) {
    if (!isAddress(pool.token) || getAddress(pool.token) === ZeroAddress) throw new Error("Invalid farm pool token");
    pool.token = getAddress(pool.token);
    if (seen.has(pool.token) || pool.token === getAddress(await farm.share())) throw new Error("Duplicate pool or SHARE staking pool");
    seen.add(pool.token);
    jsonUint(pool.allocPoint, "allocPoint");
    if ("lastRewardTime" in pool) throw new Error("lastRewardTime is no longer supported; use allocPoint=0 for an inactive pool");
    await code(ctx, pool.token);
  }
  const oracleAddress = process.env.TOMB_SHARE_ORACLE_ADDRESS ? address("TOMB_SHARE_ORACLE_ADDRESS") : undefined;
  if (enabled && !oracleAddress && await farm.shareOracle() === ZeroAddress) throw new Error("TOMB_SHARE_ORACLE_ADDRESS is required to enable PSM");
  if (oracleAddress) await code(ctx, oracleAddress);
  if (oracleAddress) {
    const oracle = new Contract(oracleAddress, ["function token0() view returns(address)", "function token1() view returns(address)"], ctx.signer);
    const tokens = [getAddress(await oracle.token0()), getAddress(await oracle.token1())];
    if (!tokens.includes(getAddress(await farm.share())) || !tokens.includes(getAddress("0xA1077a294dDE1B09bB078844df40758a5D0f9a27"))) throw new Error("PSM oracle must price SHARE against WPLS");
  }
  if (enabled) {
    const oracle = await ctx.ethers.getContractAt("contracts/tomb/Oracle.sol:Oracle", oracleAddress ?? await farm.shareOracle());
    const block = await ctx.ethers.provider.getBlock("latest");
    const updated = await oracle.blockTimestampLast();
    if (!block || BigInt(block.timestamp) < updated || BigInt(block.timestamp) - updated > age || await oracle.consult(await farm.share(), 10n ** 18n) === 0n) {
      throw new Error("SHARE oracle needs a fresh nonzero observation; run update-oracles.ts first");
    }
    if (await oracle.getPeriod() > age) throw new Error("Max oracle age must cover the SHARE oracle update period");
  }
  const existing = new Map<string, bigint>();
  const length = await farm.poolLength();
  for (let pid = 0n; pid < length; pid++) existing.set(getAddress((await farm.poolInfo(pid)).token), pid);
  for (const pool of pools) {
    const allocation = jsonUint(pool.allocPoint, "allocPoint");
    const pid = existing.get(pool.token);
    if (pid === undefined) {
      await send(`Add farm pool ${pool.token}`, () => farm.add(allocation, pool.token));
    } else if ((await farm.poolInfo(pid)).allocPoint !== allocation) {
      await send(`Set farm allocation ${pid}`, () => farm.set(pid, allocation));
    }
  }
  // Keep an active PSM enabled while applying compatible settings. Farm's
  // setters validate live oracle-dependent changes and revert atomically.
  if (oracleAddress && getAddress(await farm.shareOracle()) !== oracleAddress) await send("Set SHARE oracle", () => farm.setShareOracle(oracleAddress));
  if (await farm.pegStabilityModuleFee() !== fee) await send("Set PSM fee", () => farm.setPegStabilityModuleFee(fee));
  if (await farm.maxOracleAge() !== age) await send("Set maximum oracle age", () => farm.setMaxOracleAge(age));
  if (await farm.minClaimThreshold() !== threshold) await send("Set claim threshold", () => farm.setMinClaimThreshold(threshold));
  if (getAddress(await farm.psmFeeRecipient()) !== recipient) await send("Set PSM fee recipient", () => farm.setPsmFeeRecipient(recipient));
  if (await farm.pegStabilityModuleFeeEnabled() !== enabled) {
    await send(`${enabled ? "Enable" : "Disable"} PSM`, () =>
      farm.setPegStabilityModuleFeeEnabled(enabled),
    );
  }
  console.log("Farm configuration complete. Reward funding is handled by configure-system.ts.");
}
await entry(import.meta.url, () => main());
