import { address, context, contract, entry, send, type Context } from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  // Updating sources directly also works after oracle administration is transferred.
  const seen = new Set<string>();
  const sources = ["TOMB_SHARE_ORACLE_ADDRESS", "TOMB_REBATE_PLS_ORACLE_ADDRESS"];
  if (process.env.TOMB_REBATE_ASSET_ORACLE_ADDRESS) sources.push("TOMB_REBATE_ASSET_ORACLE_ADDRESS");
  for (const env of sources) {
    const target = address(env);
    if (seen.has(target)) continue;
    seen.add(target);
    const oracle = await contract(ctx, "oracle", env);
    const block = await ctx.ethers.provider.getBlock("latest");
    if (!block) throw new Error("Latest block unavailable");
    const observationDue = await oracle.blockTimestampLast() + await oracle.getPeriod();
    const epochDue = await oracle.nextEpochPoint();
    const due = observationDue > epochDue ? observationDue : epochDue;
    if (BigInt(block.timestamp) < due) {
      console.log(`${env}: wait until Unix time ${due} for a full observation window.`);
      continue;
    }
    const estimate = await oracle.update.estimateGas();
    await send(`Update ${env}`, () => oracle.update({ gasLimit: (estimate * 150n + 99n) / 100n }));
  }
}
await entry(import.meta.url, () => main());
