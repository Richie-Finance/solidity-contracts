import { getAddress } from "ethers";
import {
  address,
  authority,
  bytes32,
  context,
  contract,
  entry,
  flag,
  send,
  uint,
  type Context,
} from "./helpers.js";

const DEFAULT_PDAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const recovery = await contract(ctx, "pdaiRecovery", "TOMB_PDAI_RECOVERY_ADDRESS");
  await authority(ctx, recovery, "owner");

  const expectedPdai = address("TOMB_PDAI_ADDRESS", DEFAULT_PDAI);
  const expectedRoot = bytes32("TOMB_PDAI_RECOVERY_MERKLE_ROOT");
  const expectedWeight = uint("TOMB_PDAI_RECOVERY_TOTAL_ELIGIBLE_WEIGHT");
  const expectedAccounts = uint("TOMB_PDAI_RECOVERY_ELIGIBLE_ACCOUNT_COUNT");
  const targetClaimPeriod = uint("TOMB_PDAI_RECOVERY_CLAIM_PERIOD_SECONDS");
  const allowNonExpiring = flag("TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING", false);
  const maxClaimPeriod = await recovery.MAX_CLAIM_PERIOD();

  if (getAddress(await recovery.PDAI()) !== expectedPdai) throw new Error("Recovery pDAI does not match the environment");
  if ((await recovery.merkleRoot()).toLowerCase() !== expectedRoot) throw new Error("Recovery Merkle root does not match the environment");
  if (await recovery.totalEligibleWeight() !== expectedWeight) throw new Error("Recovery eligible weight does not match the environment");
  if (await recovery.eligibleAccountCount() !== expectedAccounts) throw new Error("Recovery account count does not match the environment");
  if (await recovery.emergencyShutdown()) throw new Error("Recovery deployment is permanently shut down");
  if (targetClaimPeriod > maxClaimPeriod) throw new Error("PDAI recovery claim period exceeds the contract maximum");
  if (targetClaimPeriod === 0n && !allowNonExpiring) {
    throw new Error(
      "Refusing to configure non-expiring epochs; set TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING=true to confirm",
    );
  }

  if (await recovery.claimPeriod() !== targetClaimPeriod) {
    await send("Set PDAI recovery claim period", () => recovery.setClaimPeriod(targetClaimPeriod));
  } else {
    console.log("PDAI recovery claim period already matches the target.");
  }

  console.log(`PDAI recovery epoch count: ${await recovery.epochCount()}`);
  console.log(`PDAI recovery rollover balance: ${await recovery.rolloverBalance()}`);
  console.log("PDAI recovery configuration complete; epoch funding is a separate explicit command.");
}

await entry(import.meta.url, () => main());
