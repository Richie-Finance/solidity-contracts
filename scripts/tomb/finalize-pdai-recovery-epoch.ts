import {
  context,
  contract,
  entry,
  send,
  uint,
  type Context,
} from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const recovery = await contract(ctx, "pdaiRecovery", "TOMB_PDAI_RECOVERY_ADDRESS");
  const epochId = uint("TOMB_PDAI_RECOVERY_FINALIZE_EPOCH_ID");
  const epochCount = await recovery.epochCount();

  if (epochId >= epochCount) throw new Error(`Epoch ${epochId} does not exist; epoch count is ${epochCount}`);
  const epoch = await recovery.epochs(epochId);
  if (epoch.finalized) {
    console.log(`PDAI recovery epoch ${epochId} is already finalized.`);
    return;
  }

  const eligibleAccountCount = await recovery.eligibleAccountCount();
  const allAccountsClaimed = epoch.claimantCount === eligibleAccountCount;
  const latestBlock = await ctx.ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Unable to read the latest block");
  const expired = epoch.deadline !== 0n && BigInt(latestBlock.timestamp) > epoch.deadline;

  if (!allAccountsClaimed && !expired) {
    throw new Error(
      `Epoch ${epochId} is still active. Deadline ${epoch.deadline}; latest timestamp ${latestBlock.timestamp}; ` +
      `${epoch.claimantCount} of ${eligibleAccountCount} accounts claimed`,
    );
  }

  await send(`Finalize PDAI recovery epoch ${epochId}`, () => recovery.finalizeEpoch(epochId));
  const finalized = await recovery.epochs(epochId);
  console.log(`PDAI_RECOVERY_FINALIZED_EPOCH_ID=${epochId}`);
  console.log(`PDAI_RECOVERY_EPOCH_TOTAL_CLAIMED_WEI=${finalized.totalClaimed}`);
  console.log(`PDAI_RECOVERY_ROLLOVER_BALANCE_WEI=${await recovery.rolloverBalance()}`);
}

await entry(import.meta.url, () => main());
