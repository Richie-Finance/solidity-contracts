import { Contract, ZeroAddress, getAddress, isAddress, isHexString } from "ethers";
import { network } from "hardhat";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTRACTS = {
  peg: "contracts/tomb/Peg.sol:Peg",
  share: "contracts/tomb/Share.sol:Share",
  genesis: "contracts/tomb/GenesisRewardPool.sol:GenesisRewardPool",
  farm: "contracts/tomb/Farm.sol:ShareRewardPool",
  oracle: "contracts/tomb/Oracle.sol:Oracle",
  treasury: "contracts/tomb/Treasury.sol:Treasury",
  boardroom: "contracts/tomb/Boardroom.sol:Boardroom",
  redeem: "contracts/tomb/PegRedeem.sol:PegRedeem",
  rebates: "contracts/tomb/Rebates.sol:RebateTreasury",
  rebateComposite: "contracts/tomb/RebateCompositeOracle.sol:RebateCompositeOracle",
  zap: "contracts/tomb/Zap.sol:PegPdaiZap",
  shareZap: "contracts/tomb/Zap.sol:ShareWplsZap",
  pdaiRecovery: "contracts/tomb/PDAIRecoveryDistributor.sol:PDAIRecoveryDistributor",
} as const;

export async function context() {
  const { ethers } = await network.connect();
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No deployment signer is configured");
  return { ethers, signer };
}
export type Context = Awaited<ReturnType<typeof context>>;

export function address(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value || !isAddress(value) || getAddress(value) === ZeroAddress) {
    throw new Error(`${name} must be a valid nonzero address`);
  }
  return getAddress(value);
}

export function uint(name: string, fallback?: bigint): bigint {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  const parsed = BigInt(value);
  if (parsed >= 2n ** 256n) throw new Error(`${name} exceeds uint256`);
  return parsed;
}

export function bytes32(name: string): string {
  const value = process.env[name];
  if (!value || !isHexString(value, 32)) throw new Error(`${name} must be a 32-byte hex value`);
  return value.toLowerCase();
}

export function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function jsonArray<T>(name: string): T[] {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${name} must be a nonempty JSON array`);
  return parsed as T[];
}

export function jsonUint(value: unknown, label: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must use a decimal string for large values`);
  }
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed >= 2n ** 256n) throw new Error(`${label} exceeds uint256`);
  return parsed;
}

export async function code(ctx: Context, target: string) {
  if (await ctx.ethers.provider.getCode(target) === "0x") throw new Error(`No contract at ${target}`);
}

export async function contract(ctx: Context, kind: keyof typeof CONTRACTS, env: string) {
  const target = address(env);
  await code(ctx, target);
  return await ctx.ethers.getContractAt(CONTRACTS[kind], target, ctx.signer) as unknown as Contract;
}

export async function authority(ctx: Context, target: Contract, role = "operator") {
  const current = getAddress(await target[role]());
  if (current !== getAddress(ctx.signer.address)) {
    throw new Error(`${await target.getAddress()}: signer ${ctx.signer.address} is not ${role} (${current})`);
  }
}

export async function send(label: string, transaction: () => Promise<any>) {
  console.log(label);
  const tx = await transaction();
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
}

export async function deploy(ctx: Context, kind: keyof typeof CONTRACTS, env: string, args: unknown[]) {
  const factory = await ctx.ethers.getContractFactory(CONTRACTS[kind], ctx.signer);
  const deployed = await factory.deploy(...args);
  await deployed.waitForDeployment();
  const target = await deployed.getAddress();
  console.log(`${env}=${target}`);
  console.log(`Verify: npx hardhat verify --network <network> --contract ${CONTRACTS[kind]} ${target} ${args.join(" ")}`);
  return deployed as unknown as Contract;
}

export async function future(ctx: Context, timestamp: bigint, label: string) {
  const block = await ctx.ethers.provider.getBlock("latest");
  if (!block || timestamp <= BigInt(block.timestamp)) throw new Error(`${label} must be in the future`);
}

export async function entry(url: string, action: () => Promise<unknown>) {
  // Hardhat 3 imports scripts in-process: argv[1] is the CLI, not the script.
  const direct = process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
  const hardhatRun = process.argv.includes("run") && process.argv.slice(2).some((arg) =>
    !arg.startsWith("-") && url === pathToFileURL(resolve(arg)).href);
  if (direct || hardhatRun) {
    try { await action(); } catch (error) { console.error(error); process.exitCode = 1; }
  }
}
