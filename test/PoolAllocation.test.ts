import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

describe("Pool allocation activation", () => {
  it("allows Genesis predeposits and activates, deactivates, and reactivates without retroactive rewards", async () => {
    const [, user] = await ethers.getSigners();
    const cash = await ethers.deployContract("TombScriptToken");
    const tokenA = await ethers.deployContract("TombScriptToken");
    const tokenB = await ethers.deployContract("TombScriptToken");
    const tokenC = await ethers.deployContract("TombScriptToken");
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const start = BigInt(latest) + 100n;
    const genesis = await ethers.deployContract("GenesisRewardPool", [
      await cash.getAddress(),
      start,
    ]);

    await genesis.add(100n, await tokenA.getAddress(), 0);
    await genesis.add(0n, await tokenB.getAddress(), 0);
    expect(await genesis.totalAllocPoint()).to.equal(100n);

    for (const token of [tokenA, tokenB, tokenC]) {
      await token.mint(user.address, ethers.parseEther("100"));
      await token.connect(user).approve(await genesis.getAddress(), ethers.MaxUint256);
    }

    await genesis.connect(user).deposit(0, ethers.parseEther("100"));
    await genesis.connect(user).deposit(1, ethers.parseEther("100"));
    expect((await genesis.userInfo(1, user.address)).amount).to.equal(ethers.parseEther("100"));

    await networkHelpers.time.increaseTo(start + 100n);
    expect(await genesis.pendingRewards(1, user.address)).to.equal(0n);
    expect(await genesis.pendingRewards(0, user.address)).to.be.greaterThan(0n);

    await genesis.set(1, 100n);
    expect(await genesis.totalAllocPoint()).to.equal(200n);
    expect(await genesis.pendingRewards(1, user.address)).to.equal(0n);

    await networkHelpers.time.increase(100);
    const activeReward = await genesis.pendingRewards(1, user.address);
    expect(activeReward).to.be.greaterThan(0n);

    await genesis.set(1, 0n);
    const rewardAtDeactivation = await genesis.pendingRewards(1, user.address);
    expect(await genesis.totalAllocPoint()).to.equal(100n);
    await networkHelpers.time.increase(100);
    expect(await genesis.pendingRewards(1, user.address)).to.equal(rewardAtDeactivation);

    await genesis.set(1, 100n);
    await networkHelpers.time.increase(100);
    expect(await genesis.pendingRewards(1, user.address)).to.be.greaterThan(rewardAtDeactivation);

    // A pool added after Genesis has started can accept deposits at zero
    // allocation and starts earning only after its allocation is raised.
    await genesis.add(0n, await tokenC.getAddress(), 0);
    await genesis.connect(user).deposit(2, ethers.parseEther("100"));
    await networkHelpers.time.increase(100);
    expect(await genesis.pendingRewards(2, user.address)).to.equal(0n);
    await genesis.set(2, 100n);
    await networkHelpers.time.increase(100);
    const poolCReward = await genesis.pendingRewards(2, user.address);
    expect(poolCReward).to.be.greaterThan(0n);

    // A fully inactive interval is also safe: pending views do not divide by
    // zero, rewards do not accrue, and a later set() starts a fresh interval.
    await genesis.set(0, 0n);
    await genesis.set(1, 0n);
    await genesis.set(2, 0n);
    expect(await genesis.totalAllocPoint()).to.equal(0n);
    const rewardBeforePause = await genesis.pendingRewards(2, user.address);
    await networkHelpers.time.increase(100);
    expect(await genesis.pendingRewards(2, user.address)).to.equal(rewardBeforePause);
    await genesis.set(2, 100n);
    await networkHelpers.time.increase(100);
    expect(await genesis.pendingRewards(2, user.address)).to.be.greaterThan(rewardBeforePause);
  });

  it("checkpoints Genesis rewards before emergency withdrawal changes total stake", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const cash = await ethers.deployContract("TombScriptToken");
    const stakeToken = await ethers.deployContract("TombScriptToken");
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const start = BigInt(latest) + 100n;
    const genesis = await ethers.deployContract("GenesisRewardPool", [
      await cash.getAddress(),
      start,
    ]);

    await genesis.add(100n, await stakeToken.getAddress(), 0);
    for (const account of [alice, bob]) {
      await stakeToken.mint(account.address, ethers.parseEther("100"));
      await stakeToken.connect(account).approve(await genesis.getAddress(), ethers.MaxUint256);
      await genesis.connect(account).deposit(0, ethers.parseEther("100"));
    }

    await networkHelpers.time.increaseTo(start + 100n);
    const receipt = await (await genesis.connect(alice).emergencyWithdraw(0)).wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const generated = await genesis.getGeneratedReward(start, BigInt(block!.timestamp));

    expect(await genesis.pendingRewards(0, bob.address)).to.equal(generated / 2n);
    expect((await genesis.poolInfo(0)).totalStaked).to.equal(ethers.parseEther("100"));
  });

  it("allows Farm predeposits and allocation-only activation for pools added later", async () => {
    const [, user, feeRecipient] = await ethers.getSigners();
    const rich = await ethers.deployContract("TombScriptToken");
    const tokenA = await ethers.deployContract("TombScriptToken");
    const tokenB = await ethers.deployContract("TombScriptToken");
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const start = BigInt(latest) + 100n;
    const farm = await ethers.deployContract("ShareRewardPool", [
      await rich.getAddress(),
      start,
      feeRecipient.address,
    ]);

    await farm.add(100n, await tokenA.getAddress());
    await tokenA.mint(user.address, ethers.parseEther("100"));
    await tokenA.connect(user).approve(await farm.getAddress(), ethers.MaxUint256);
    await farm.connect(user).deposit(0, ethers.parseEther("100"));

    await networkHelpers.time.increaseTo(start + 100n);
    const rewardBeforeAddition = await farm.pendingShare(0, user.address);
    expect(rewardBeforeAddition).to.be.greaterThan(0n);

    await farm.add(0n, await tokenB.getAddress());
    expect(await farm.totalAllocPoint()).to.equal(100n);
    expect(await farm.pendingShare(0, user.address)).to.be.greaterThanOrEqual(rewardBeforeAddition);

    await tokenB.mint(user.address, ethers.parseEther("100"));
    await tokenB.connect(user).approve(await farm.getAddress(), ethers.MaxUint256);
    await farm.connect(user).deposit(1, ethers.parseEther("100"));
    await networkHelpers.time.increase(100);
    expect(await farm.pendingShare(1, user.address)).to.equal(0n);

    await farm.set(1, 100n);
    await networkHelpers.time.increase(100);
    const activeReward = await farm.pendingShare(1, user.address);
    expect(activeReward).to.be.greaterThan(0n);

    await farm.set(1, 0n);
    const rewardAtDeactivation = await farm.pendingShare(1, user.address);
    await networkHelpers.time.increase(100);
    expect(await farm.pendingShare(1, user.address)).to.equal(rewardAtDeactivation);
  });

  it("bounds Genesis allocations without blocking rewards or principal exits", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const cash = await ethers.deployContract("TombScriptToken");
    const tokenA = await ethers.deployContract("TombScriptToken");
    const tokenB = await ethers.deployContract("TombScriptToken");
    const tokenC = await ethers.deployContract("TombScriptToken");
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const start = BigInt(latest) + 1000n;
    const genesis = await ethers.deployContract("GenesisRewardPool", [
      await cash.getAddress(),
      start,
    ]);
    const max = await genesis.MAX_ALLOC_POINT();

    await genesis.add(max, await tokenA.getAddress(), 0);
    await expect(
      genesis.add(max + 1n, await tokenB.getAddress(), 0),
    ).to.be.revertedWith("Pool: allocation too high");

    await genesis.add(0, await tokenB.getAddress(), 0);
    await expect(genesis.set(1, max + 1n)).to.be.revertedWith(
      "Pool: allocation too high",
    );
    await genesis.set(1, max);
    expect((await genesis.poolInfo(0)).allocPoint).to.equal(max);
    expect((await genesis.poolInfo(1)).allocPoint).to.equal(max);

    await expect(
      genesis.add(max + 1n, await tokenC.getAddress(), 0),
    ).to.be.revertedWith("Pool: allocation too high");

    for (const account of [alice, bob]) {
      await tokenA.mint(account.address, ethers.parseEther("100"));
      await tokenA
        .connect(account)
        .approve(await genesis.getAddress(), ethers.MaxUint256);
      await genesis.connect(account).deposit(0, ethers.parseEther("100"));
    }
    await cash.mint(
      await genesis.getAddress(),
      await genesis.TOTAL_REWARDS(),
    );

    await networkHelpers.time.increaseTo(start + 100n);
    expect(await genesis.pendingRewards(0, alice.address)).to.be.greaterThan(0n);
    expect(await genesis.pendingRewards(0, bob.address)).to.be.greaterThan(0n);

    await genesis.connect(alice).withdraw(0, ethers.parseEther("100"));
    await genesis.connect(bob).emergencyWithdraw(0);

    expect(await tokenA.balanceOf(alice.address)).to.equal(
      ethers.parseEther("100"),
    );
    expect(await tokenA.balanceOf(bob.address)).to.equal(
      ethers.parseEther("100"),
    );
    expect((await genesis.poolInfo(0)).totalStaked).to.equal(0n);
  });

  it("bounds Farm allocations without blocking rewards or principal exits", async () => {
    const [, alice, bob, feeRecipient] = await ethers.getSigners();
    const rich = await ethers.deployContract("TombScriptToken");
    const tokenA = await ethers.deployContract("TombScriptToken");
    const tokenB = await ethers.deployContract("TombScriptToken");
    const tokenC = await ethers.deployContract("TombScriptToken");
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const start = BigInt(latest) + 1000n;
    const farm = await ethers.deployContract("ShareRewardPool", [
      await rich.getAddress(),
      start,
      feeRecipient.address,
    ]);
    const max = await farm.MAX_ALLOC_POINT();

    await farm.add(max, await tokenA.getAddress());
    await expect(
      farm.add(max + 1n, await tokenB.getAddress()),
    ).to.be.revertedWith("Pool: allocation too high");

    await farm.add(0, await tokenB.getAddress());
    await expect(farm.set(1, max + 1n)).to.be.revertedWith(
      "Pool: allocation too high",
    );
    await farm.set(1, max);
    expect((await farm.poolInfo(0)).allocPoint).to.equal(max);
    expect((await farm.poolInfo(1)).allocPoint).to.equal(max);

    await expect(
      farm.add(max + 1n, await tokenC.getAddress()),
    ).to.be.revertedWith("Pool: allocation too high");

    for (const account of [alice, bob]) {
      await tokenA.mint(account.address, ethers.parseEther("100"));
      await tokenA
        .connect(account)
        .approve(await farm.getAddress(), ethers.MaxUint256);
      await farm.connect(account).deposit(0, ethers.parseEther("100"));
    }

    await networkHelpers.time.increaseTo(start + 100n);
    expect(await farm.pendingShare(0, alice.address)).to.be.greaterThan(0n);
    expect(await farm.pendingShare(0, bob.address)).to.be.greaterThan(0n);

    await farm.connect(alice).withdraw(0, ethers.parseEther("100"));
    await farm.connect(bob).emergencyWithdraw(0);

    expect(await tokenA.balanceOf(alice.address)).to.equal(
      ethers.parseEther("100"),
    );
    expect(await tokenA.balanceOf(bob.address)).to.equal(
      ethers.parseEther("100"),
    );
    expect((await farm.poolInfo(0)).totalStaked).to.equal(0n);
  });
});
