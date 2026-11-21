import { Contract } from "ethers";
import {
  authority,
  context,
  contract,
  entry,
  flag,
  send,
  uint,
  type Context,
} from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const recovery = await contract(ctx, "pdaiRecovery", "TOMB_PDAI_RECOVERY_ADDRESS");
  await authority(ctx, recovery, "owner");

  const expectedEpochId = uint("TOMB_PDAI_RECOVERY_EXPECTED_EPOCH_ID");
  const funding = uint("TOMB_PDAI_RECOVERY_EPOCH_FUNDING_WEI");
  const allowNonExpiring = flag("TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING", false);
  const currentEpochId = await recovery.epochCount();

  if (currentEpochId !== expectedEpochId) {
    throw new Error(`Expected epoch ${expectedEpochId}, but the next epoch is ${currentEpochId}; refusing a duplicate start`);
  }
  if (await recovery.emergencyShutdown()) throw new Error("Recovery deployment is permanently shut down");
  if (await recovery.emergencyWithdrawalUnlockAt() !== 0n) throw new Error("An emergency withdrawal is pending");
  if (await recovery.claimPeriod() === 0n && !allowNonExpiring) {
    throw new Error(
      "Refusing to start a non-expiring epoch; set TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING=true to confirm",
    );
  }
  if (expectedEpochId > 0n) {
    const previousEpoch = await recovery.epochs(expectedEpochId - 1n);
    if (!previousEpoch.finalized) throw new Error("Finalize the previous epoch before starting another one");
  }
  if (funding === 0n && await recovery.rolloverBalance() === 0n) {
    throw new Error("Epoch funding and rollover are both zero");
  }

  const recoveryAddress = await recovery.getAddress();
  const pdai = new Contract(await recovery.PDAI(), [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
  ], ctx.signer);

  if (funding > 0n) {
    if (await pdai.balanceOf(ctx.signer.address) < funding) throw new Error("Signer has insufficient pDAI for epoch funding");
    const allowance = await pdai.allowance(ctx.signer.address, recoveryAddress);
    if (allowance < funding) {
      if (allowance > 0n) await send("Reset pDAI recovery approval", () => pdai.approve(recoveryAddress, 0));
      await send("Approve pDAI recovery epoch funding", () => pdai.approve(recoveryAddress, funding));
    }
  }

  await send(`Start PDAI recovery epoch ${expectedEpochId}`, () => recovery.startEpoch(funding));
  const epoch = await recovery.epochs(expectedEpochId);
  console.log(`PDAI_RECOVERY_STARTED_EPOCH_ID=${expectedEpochId}`);
  console.log(`PDAI_RECOVERY_EPOCH_ALLOCATION_WEI=${epoch.allocation}`);
  console.log(`PDAI_RECOVERY_EPOCH_DEADLINE=${epoch.deadline}`);
}

await entry(import.meta.url, () => main());
