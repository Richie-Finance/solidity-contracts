import {
  AbiCoder,
  Contract,
  ZeroAddress,
  concat,
  getAddress,
  id,
  isAddress,
  keccak256,
} from "ethers";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { context, entry } from "./helpers.js";

const DEFAULT_PDAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const DEFAULT_DATA_PROVIDER = "0x2369CF50eE0e5727bd971c0d2D172Ea6f376EdaA";
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

const DATA_PROVIDER_ABI = [
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
];
const TOKEN_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

type Holder = {
  account: string;
  supplied: bigint;
  stableDebt: bigint;
  variableDebt: bigint;
  eligibleWeight: bigint;
  excluded: boolean;
};

type Claim = Holder & {
  leaf: string;
  proof: string[];
};

function envAddress(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!isAddress(value) || getAddress(value) === ZeroAddress) {
    throw new Error(`${name} must be a valid nonzero address`);
  }
  return getAddress(value);
}

function envBlock(name: string): number {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a block number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function topicAddress(topic: string): string {
  return getAddress(`0x${topic.slice(26)}`);
}

function snapshotLeaf(account: string, eligibleWeight: bigint): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    [account, eligibleWeight],
  );
  return keccak256(keccak256(encoded));
}

function hashPair(left: string, right: string): string {
  const ordered = BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return keccak256(concat(ordered));
}

function createMerkleClaims(holders: Holder[]): { root: string; claims: Claim[] } {
  const eligible = holders
    .filter((holder) => holder.eligibleWeight > 0n && !holder.excluded)
    .sort((left, right) => left.account.toLowerCase().localeCompare(right.account.toLowerCase()));
  if (eligible.length === 0) throw new Error("Snapshot has no eligible accounts");

  const leaves = eligible.map((holder) => snapshotLeaf(holder.account, holder.eligibleWeight));
  const levels: string[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index], current[index + 1] ?? current[index]));
    }
    levels.push(next);
  }

  const claims = eligible.map((holder, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const nodes = levels[level];
      const sibling = index ^ 1;
      proof.push(nodes[sibling] ?? nodes[index]);
      index = Math.floor(index / 2);
    }
    return { ...holder, leaf: leaves[leafIndex], proof };
  });

  return { root: levels[levels.length - 1][0], claims };
}

async function readBalance(
  token: Contract | undefined,
  account: string,
  snapshotBlock: number,
): Promise<bigint> {
  if (!token) return 0n;
  return BigInt(await token.balanceOf(account, { blockTag: snapshotBlock }));
}

export async function main() {
  const ctx = await context();
  const provider = ctx.ethers.provider;
  const pdai = envAddress("PDAI_ADDRESS", DEFAULT_PDAI);
  const dataProviderAddress = envAddress("PDAI_DATA_PROVIDER_ADDRESS", DEFAULT_DATA_PROVIDER);
  const snapshotBlock = envBlock("PDAI_SNAPSHOT_BLOCK");
  const aTokenStartBlock = envBlock("PDAI_ATOKEN_START_BLOCK");
  const logChunkSize = envPositiveInteger("PDAI_LOG_CHUNK_SIZE", 50_000);
  const balanceBatchSize = envPositiveInteger("PDAI_BALANCE_BATCH_SIZE", 25);

  if (aTokenStartBlock > snapshotBlock) {
    throw new Error("PDAI_ATOKEN_START_BLOCK must not exceed PDAI_SNAPSHOT_BLOCK");
  }
  const latestBlock = await provider.getBlockNumber();
  if (snapshotBlock > latestBlock) throw new Error("PDAI_SNAPSHOT_BLOCK is in the future");

  const dataProvider = new Contract(dataProviderAddress, DATA_PROVIDER_ABI, provider);
  const reserveTokens = await dataProvider.getReserveTokensAddresses(pdai, {
    blockTag: snapshotBlock,
  });
  const aTokenAddress = getAddress(reserveTokens.aTokenAddress);
  const stableDebtAddress = getAddress(reserveTokens.stableDebtTokenAddress);
  const variableDebtAddress = getAddress(reserveTokens.variableDebtTokenAddress);
  if (aTokenAddress === ZeroAddress) throw new Error("The pDAI reserve has no aToken");

  const aToken = new Contract(aTokenAddress, TOKEN_ABI, provider);
  const stableDebt = stableDebtAddress === ZeroAddress
    ? undefined
    : new Contract(stableDebtAddress, TOKEN_ABI, provider);
  const variableDebt = variableDebtAddress === ZeroAddress
    ? undefined
    : new Contract(variableDebtAddress, TOKEN_ABI, provider);

  const candidates = new Set<string>();
  for (let fromBlock = aTokenStartBlock; fromBlock <= snapshotBlock; fromBlock += logChunkSize) {
    const toBlock = Math.min(fromBlock + logChunkSize - 1, snapshotBlock);
    const logs = await provider.getLogs({
      address: aTokenAddress,
      topics: [TRANSFER_TOPIC],
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (log.topics.length < 3) continue;
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      if (from !== ZeroAddress) candidates.add(from);
      if (to !== ZeroAddress) candidates.add(to);
    }
    console.log(`Scanned aToken transfers through block ${toBlock}; ${candidates.size} candidates`);
  }

  const excluded = new Set(
    (process.env.PDAI_EXCLUDED_ADDRESSES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        if (!isAddress(value)) throw new Error(`Invalid excluded address: ${value}`);
        return getAddress(value);
      }),
  );

  const accounts = [...candidates].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()),
  );
  const holders: Holder[] = [];
  for (let offset = 0; offset < accounts.length; offset += balanceBatchSize) {
    const batch = accounts.slice(offset, offset + balanceBatchSize);
    const rows = await Promise.all(
      batch.map(async (account): Promise<Holder> => {
        const [supplied, stableDebtBalance, variableDebtBalance] = await Promise.all([
          readBalance(aToken, account, snapshotBlock),
          readBalance(stableDebt, account, snapshotBlock),
          readBalance(variableDebt, account, snapshotBlock),
        ]);
        const debt = stableDebtBalance + variableDebtBalance;
        return {
          account,
          supplied,
          stableDebt: stableDebtBalance,
          variableDebt: variableDebtBalance,
          eligibleWeight: supplied > debt ? supplied - debt : 0n,
          excluded: excluded.has(account),
        };
      }),
    );
    holders.push(...rows.filter((row) => row.supplied > 0n));
    console.log(`Read ${Math.min(offset + batch.length, accounts.length)} of ${accounts.length} candidates`);
  }

  const totalATokenSupply = BigInt(await aToken.totalSupply({ blockTag: snapshotBlock }));
  const discoveredSupply = holders.reduce((total, holder) => total + holder.supplied, 0n);
  const reconciliationDifference = discoveredSupply > totalATokenSupply
    ? discoveredSupply - totalATokenSupply
    : totalATokenSupply - discoveredSupply;
  const roundingTolerance = BigInt(holders.length + 1);
  if (reconciliationDifference > roundingTolerance) {
    throw new Error(
      `Holder balances do not reconcile with aToken totalSupply. Difference: ${reconciliationDifference}. ` +
      "Check PDAI_ATOKEN_START_BLOCK and archive RPC support.",
    );
  }

  const { root, claims } = createMerkleClaims(holders);
  const totalEligibleWeight = claims.reduce((total, claim) => total + claim.eligibleWeight, 0n);
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chainId: Number((await provider.getNetwork()).chainId),
    snapshotBlock,
    aTokenStartBlock,
    pdai,
    dataProvider: dataProviderAddress,
    aToken: aTokenAddress,
    stableDebtToken: stableDebtAddress,
    variableDebtToken: variableDebtAddress,
    merkleRoot: root,
    totalEligibleWeight: totalEligibleWeight.toString(),
    eligibleAccountCount: claims.length,
    totalATokenSupply: totalATokenSupply.toString(),
    discoveredSupply: discoveredSupply.toString(),
    reconciliationDifference: reconciliationDifference.toString(),
    excludedAddresses: [...excluded],
    claims: claims.map((claim) => ({
      account: claim.account,
      supplied: claim.supplied.toString(),
      stableDebt: claim.stableDebt.toString(),
      variableDebt: claim.variableDebt.toString(),
      eligibleWeight: claim.eligibleWeight.toString(),
      leaf: claim.leaf,
      proof: claim.proof,
    })),
  };

  const outputDirectory = resolve("output");
  const outputPath = resolve(outputDirectory, `pdai-recovery-snapshot-${snapshotBlock}.json`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`PDAI_RECOVERY_MERKLE_ROOT=${root}`);
  console.log(`PDAI_RECOVERY_TOTAL_ELIGIBLE=${totalEligibleWeight}`);
  console.log(`PDAI_RECOVERY_ACCOUNT_COUNT=${claims.length}`);
  console.log(`Snapshot written to ${outputPath}`);
}

await entry(import.meta.url, () => main());
