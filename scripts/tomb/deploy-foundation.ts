import { address, context, deploy, entry, future, uint, type Context } from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const startTime = uint("TOMB_START_TIME");
  const communityFund = address("TOMB_COMMUNITY_FUND");
  await future(ctx, startTime, "TOMB_START_TIME");

  console.log("Deployer:", ctx.signer.address);
  console.log("Start time:", startTime.toString());

  const peg = await deploy(ctx, "peg", "TOMB_PEG_ADDRESS", []);
  const share = await deploy(ctx, "share", "TOMB_SHARE_ADDRESS", [
    startTime,
    communityFund,
  ]);
  const genesis = await deploy(ctx, "genesis", "TOMB_GENESIS_ADDRESS", [
    await peg.getAddress(),
    startTime,
  ]);

  return { peg, share, genesis };
}

await entry(import.meta.url, () => main());
