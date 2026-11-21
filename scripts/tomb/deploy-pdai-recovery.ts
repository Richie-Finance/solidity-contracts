import { Contract } from "ethers";
import {
  address,
  bytes32,
  code,
  context,
  deploy,
  entry,
  flag,
  uint,
  type Context,
} from "./helpers.js";

const DEFAULT_PDAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const MAX_CLAIM_PERIOD = 365n * 24n * 60n * 60n;

export async function main(ctx?: Context) {
  ctx ??= await context();
  const pdai = address("TOMB_PDAI_ADDRESS", DEFAULT_PDAI);
  const root = bytes32("TOMB_PDAI_RECOVERY_MERKLE_ROOT");
  const totalWeight = uint("TOMB_PDAI_RECOVERY_TOTAL_ELIGIBLE_WEIGHT");
  const accountCount = uint("TOMB_PDAI_RECOVERY_ELIGIBLE_ACCOUNT_COUNT");
  const initialClaimPeriod = uint("TOMB_PDAI_RECOVERY_INITIAL_CLAIM_PERIOD_SECONDS");
  const allowNonExpiring = flag("TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING", false);

  if (totalWeight === 0n) throw new Error("PDAI recovery total eligible weight must be positive");
  if (accountCount === 0n) throw new Error("PDAI recovery eligible account count must be positive");
  if (initialClaimPeriod > MAX_CLAIM_PERIOD) throw new Error("PDAI recovery claim period exceeds 365 days");
  if (initialClaimPeriod === 0n && !allowNonExpiring) {
    throw new Error(
      "Refusing a non-expiring recovery epoch configuration; set TOMB_PDAI_RECOVERY_ALLOW_NON_EXPIRING=true to confirm",
    );
  }

  await code(ctx, pdai);
  const token = new Contract(pdai, ["function decimals() view returns(uint8)"], ctx.signer);
  if (Number(await token.decimals()) !== 18) throw new Error("The configured pDAI token must use 18 decimals");

  return deploy(ctx, "pdaiRecovery", "TOMB_PDAI_RECOVERY_ADDRESS", [
    pdai,
    root,
    totalWeight,
    accountCount,
    initialClaimPeriod,
  ]);
}

await entry(import.meta.url, () => main());
