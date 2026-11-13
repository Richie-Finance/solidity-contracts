import { address, code, context, deploy, entry, uint, type Context } from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const asset = address("TOMB_REBATE_ASSET_TOKEN_ADDRESS");
  const assetPlsOracle = address("TOMB_REBATE_ASSET_ORACLE_ADDRESS");
  const plsDaiOracle = address("TOMB_REBATE_PLS_ORACLE_ADDRESS");
  for (const target of [asset, assetPlsOracle, plsDaiOracle]) await code(ctx, target);
  const age = uint("TOMB_REBATE_MAX_ORACLE_AGE", 86400n);
  const adapter = await deploy(ctx, "rebateComposite", "TOMB_REBATE_ASSET_COMPOSITE_ORACLE_ADDRESS", [
    asset,
    assetPlsOracle,
    plsDaiOracle,
    age,
  ]);
  console.log(`Use ${await adapter.getAddress()} as this asset's oracle in TOMB_REBATE_ASSETS.`);
  console.log("Keep the existing RICH composite unchanged and update both composite adapters hourly.");
  return adapter;
}
await entry(import.meta.url, () => main());
