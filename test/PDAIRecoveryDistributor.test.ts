import { expect } from "chai";
import { network } from "hardhat";
import {
  AbiCoder,
  concat,
  keccak256,
  type Signer,
} from "ethers";
import type { PDAIRecoveryDistributor } from "../types/ethers-contracts/tomb/PDAIRecoveryDistributor.sol/PDAIRecoveryDistributor.js";

const { ethers, networkHelpers } = await network.connect();

type SnapshotEntry = {
  account: string;
  weight: bigint;
};

function leaf(entry: SnapshotEntry): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    [entry.account, entry.weight],
  );
  return keccak256(keccak256(encoded));
}

function hashPair(left: string, right: string): string {
  const ordered = BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return keccak256(concat(ordered));
}

function merkleTree(entries: SnapshotEntry[]) {
  const leaves = entries.map(leaf);
  const levels: string[][] = [leaves];

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index], current[index + 1] ?? current[index]));
    }
    levels.push(next);
  }

  return {
    root: levels[levels.length - 1][0],
    proof(index: number) {
      const proof: string[] = [];
      for (let level = 0; level < levels.length - 1; level += 1) {
        const nodes = levels[level];
        const sibling = index ^ 1;
        proof.push(nodes[sibling] ?? nodes[index]);
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}

describe("PDAIRecoveryDistributor", () => {
  async function fixture() {
    const [owner, alice, bob, carol, relayer] = await ethers.getSigners();
    const pdai = await ethers.deployContract("TombScriptToken");
    const entries: SnapshotEntry[] = [
      { account: alice.address, weight: 60n },
      { account: bob.address, weight: 30n },
      { account: carol.address, weight: 10n },
    ];
    const tree = merkleTree(entries);
    const distributor = await ethers.deployContract("PDAIRecoveryDistributor", [
      await pdai.getAddress(),
      tree.root,
      100n,
      3n,
      30n * 24n * 60n * 60n,
    ]);

    await pdai.mint(owner.address, ethers.parseEther("1000"));
    await pdai.approve(await distributor.getAddress(), ethers.MaxUint256);

    return { owner, alice, bob, carol, relayer, pdai, distributor, entries, tree };
  }

  async function claim(
    distributor: PDAIRecoveryDistributor,
    signer: Signer,
    epochId: bigint,
    entry: SnapshotEntry,
    proof: string[],
  ) {
    return distributor
      .connect(signer)
      .claim(epochId, entry.account, entry.weight, proof);
  }

  it("allocates every epoch pro rata regardless of claim order", async () => {
    const { alice, bob, relayer, pdai, distributor, entries, tree } = await fixture();
    await distributor.startEpoch(ethers.parseEther("100"));

    await claim(distributor, relayer, 0n, entries[1], tree.proof(1));
    await claim(distributor, relayer, 0n, entries[0], tree.proof(0));

    expect(await pdai.balanceOf(alice.address)).to.equal(ethers.parseEther("60"));
    expect(await pdai.balanceOf(bob.address)).to.equal(ethers.parseEther("30"));
    expect((await distributor.epochs(0n)).totalClaimed).to.equal(ethers.parseEther("90"));
    await expect(
      claim(distributor, relayer, 0n, entries[0], tree.proof(0)),
    ).to.be.revertedWith("PDAIRecovery: already claimed");
  });

  it("expires missed claims and rolls the remainder into a later epoch", async () => {
    const { alice, bob, carol, relayer, pdai, distributor, entries, tree } = await fixture();
    await distributor.startEpoch(ethers.parseEther("100"));

    await claim(distributor, relayer, 0n, entries[0], tree.proof(0));
    await claim(distributor, relayer, 0n, entries[1], tree.proof(1));
    await networkHelpers.time.increase(30 * 24 * 60 * 60 + 1);

    await distributor.finalizeEpoch(0n);
    expect(await distributor.rolloverBalance()).to.equal(ethers.parseEther("10"));
    await expect(
      claim(distributor, relayer, 0n, entries[2], tree.proof(2)),
    ).to.be.revertedWith("PDAIRecovery: epoch finalized");

    await distributor.startEpoch(ethers.parseEther("90"));
    expect((await distributor.epochs(1n)).allocation).to.equal(ethers.parseEther("100"));

    await claim(distributor, relayer, 1n, entries[2], tree.proof(2));
    expect(await pdai.balanceOf(carol.address)).to.equal(ethers.parseEther("10"));
    expect(await distributor.rolloverBalance()).to.equal(0n);
  });

  it("supports non-expiring future epochs without changing existing deadlines", async () => {
    const { relayer, distributor, entries, tree } = await fixture();
    await distributor.startEpoch(100n);
    const originalDeadline = (await distributor.epochs(0n)).deadline;

    await distributor.setClaimPeriod(0n);
    expect((await distributor.epochs(0n)).deadline).to.equal(originalDeadline);
    await distributor.startEpoch(100n);
    expect((await distributor.epochs(1n)).deadline).to.equal(0n);

    await networkHelpers.time.increase(366 * 24 * 60 * 60);
    await claim(distributor, relayer, 1n, entries[0], tree.proof(0));
    await expect(distributor.finalizeEpoch(1n)).to.be.revertedWith(
      "PDAIRecovery: epoch still active",
    );

    await claim(distributor, relayer, 1n, entries[1], tree.proof(1));
    await claim(distributor, relayer, 1n, entries[2], tree.proof(2));
    await distributor.finalizeEpoch(1n);
    expect((await distributor.epochs(1n)).finalized).to.equal(true);
  });

  it("rejects periods over one year, invalid proofs, and non-owner funding", async () => {
    const { alice, bob, distributor, entries, tree } = await fixture();
    await expect(distributor.setClaimPeriod(365n * 24n * 60n * 60n + 1n)).to.be.revertedWith(
      "PDAIRecovery: period too long",
    );
    await expect(distributor.connect(alice).startEpoch(1n))
      .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);

    await distributor.startEpoch(100n);
    await expect(
      distributor.claim(0n, alice.address, entries[0].weight, tree.proof(1)),
    ).to.be.revertedWith("PDAIRecovery: invalid proof");
    await expect(
      distributor.claim(0n, bob.address, entries[0].weight, tree.proof(0)),
    ).to.be.revertedWith("PDAIRecovery: invalid proof");
  });

  it("timelocks emergency recovery, leaves a claim window, and permanently shuts down", async () => {
    const { owner, alice, bob, relayer, pdai, distributor, entries, tree } = await fixture();
    await distributor.startEpoch(ethers.parseEther("100"));
    await distributor.scheduleEmergencyWithdrawal();

    await expect(distributor.startEpoch(1n)).to.be.revertedWith(
      "PDAIRecovery: emergency pending",
    );
    await expect(
      distributor.executeEmergencyWithdrawal(owner.address),
    ).to.be.revertedWith("PDAIRecovery: emergency timelocked");

    // Existing claims remain available throughout the public emergency delay.
    await claim(distributor, relayer, 0n, entries[0], tree.proof(0));
    expect(await pdai.balanceOf(alice.address)).to.equal(ethers.parseEther("60"));

    await networkHelpers.time.increase(7 * 24 * 60 * 60);
    await expect(distributor.executeEmergencyWithdrawal(ethers.ZeroAddress)).to.be.revertedWith(
      "PDAIRecovery: zero recipient",
    );

    const ownerBefore = await pdai.balanceOf(owner.address);
    await distributor.executeEmergencyWithdrawal(owner.address);
    expect(await pdai.balanceOf(owner.address)).to.equal(ownerBefore + ethers.parseEther("40"));
    expect(await distributor.emergencyShutdown()).to.equal(true);
    expect(
      await distributor.claimable(0n, entries[1].account, entries[1].weight, tree.proof(1)),
    ).to.equal(0n);
    await expect(
      claim(distributor, relayer, 0n, entries[1], tree.proof(1)),
    ).to.be.revertedWith("PDAIRecovery: emergency shutdown");
    await expect(distributor.startEpoch(1n)).to.be.revertedWith(
      "PDAIRecovery: emergency shutdown",
    );
  });

  it("allows the owner to cancel an emergency withdrawal", async () => {
    const { distributor } = await fixture();
    await distributor.scheduleEmergencyWithdrawal();
    await distributor.cancelEmergencyWithdrawal();

    expect(await distributor.emergencyWithdrawalUnlockAt()).to.equal(0n);
    await distributor.startEpoch(100n);
    expect(await distributor.epochCount()).to.equal(1n);
  });
});
