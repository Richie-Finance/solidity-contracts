import {
  address,
  code,
  context,
  deploy,
  entry,
  future,
  send,
  uint,
  type Context,
} from "./helpers.js";

export async function main(ctx?: Context) {
  ctx ??= await context();
  const peg = address("TOMB_PEG_ADDRESS");
  const share = address("TOMB_SHARE_ADDRESS");
  const oracle = address("TOMB_ORACLE_ADDRESS");
  const startTime = uint("TOMB_START_TIME");

  await Promise.all([code(ctx, peg), code(ctx, share), code(ctx, oracle)]);
  await future(ctx, startTime, "TOMB_START_TIME");

  console.log("Deployer:", ctx.signer.address);
  console.log("Start time:", startTime.toString());

  const boardroom = await deploy(ctx, "boardroom", "TOMB_BOARDROOM_ADDRESS", []);
  const treasury = await deploy(ctx, "treasury", "TOMB_TREASURY_ADDRESS", []);
  const boardroomAddress = await boardroom.getAddress();
  const treasuryAddress = await treasury.getAddress();

  await send("Initialize Treasury", () =>
    treasury.initialize(peg, share, oracle, boardroomAddress, startTime),
  );
  await send("Initialize Boardroom", () =>
    boardroom.initialize(peg, share, treasuryAddress),
  );

  console.log("Initialization complete.");
  return { boardroom, treasury };
}

await entry(import.meta.url, () => main());
