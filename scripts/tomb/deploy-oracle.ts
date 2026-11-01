import { address, code, context, deploy, entry, uint, type Context } from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const pair = address("TOMB_PAIR_ADDRESS");
  const period = uint("TOMB_ORACLE_PERIOD", 6n * 60n * 60n);
  const startTime = uint("TOMB_ORACLE_START_TIME");
  if (period === 0n) throw new Error("TOMB_ORACLE_PERIOD must be positive");
  await code(ctx, pair);

  console.log("Deployer:", ctx.signer.address);
  console.log("Pair:", pair);
  console.log("Period:", period.toString());
  console.log("Start time:", startTime.toString());

  return deploy(ctx, "oracle", "TOMB_ORACLE_ADDRESS", [
    pair,
    period,
    startTime,
  ]);
}

await entry(import.meta.url, () => main());
