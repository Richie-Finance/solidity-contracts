import { expect } from "chai";
import { network } from "hardhat";
import { main as deployComposite } from "../scripts/tomb/deploy-rebate-composite-oracle.js";
import { main as deployAssetPlsOracle } from "../scripts/tomb/deploy-rebate-asset-pls-oracle.js";
import { main as deployAssetComposite } from "../scripts/tomb/deploy-rebate-asset-composite-oracle.js";
import { main as updateSources } from "../scripts/tomb/update-rebate-oracles.js";
import { main as configureRebates } from "../scripts/tomb/configure-rebates.js";
import { main as transferAdmin } from "../scripts/tomb/transfer-administration.js";
const { ethers, networkHelpers } = await network.connect();
const DAI = "0xefd766ccb38eaf1dfd701853bfce31359239f305";
const WPLS = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";

describe("Rebate composite cross-TWAP", () => {
  async function fixture() {
    const [owner, user] = await ethers.getSigners();
    const template = await ethers.deployContract("TombScriptToken");
    await ethers.provider.send("hardhat_setCode", [DAI, await ethers.provider.getCode(await template.getAddress())]);
    const dai = await ethers.getContractAt("TombScriptToken", DAI);
    const share = await ethers.deployContract("TombScriptToken");
    // 20,000 WPLS/RICH * 0.0001 DAI/WPLS = 2 DAI/RICH.
    const shareOracle = await ethers.deployContract("RebateSourceMock", [await share.getAddress(), WPLS, 20000n, 1n]);
    const plsOracle = await ethers.deployContract("RebateSourceMock", [WPLS, DAI, 10n ** 14n, 10n ** 18n]);
    const adapter = await ethers.deployContract("RebateCompositeOracle", [await share.getAddress(), await shareOracle.getAddress(), await plsOracle.getAddress(), 86400]);
    const rebates = await ethers.deployContract("RebateTreasury", [await share.getAddress(), await adapter.getAddress(), owner.address]);
    await share.mint(await rebates.getAddress(), ethers.parseEther("1000"));
    await dai.mint(user.address, ethers.parseEther("100"));
    await dai.connect(user).approve(await rebates.getAddress(), ethers.MaxUint256);
    return {owner, user, share, dai, shareOracle, plsOracle, adapter, rebates};
  }

  it("quotes both directions in raw units and handles zero/invalid inputs", async () => {
    const {share, adapter} = await networkHelpers.loadFixture(fixture);
    expect(await adapter.consult(await share.getAddress(), ethers.parseEther("1"))).to.equal(ethers.parseEther("2"));
    expect(await adapter.consult(DAI, ethers.parseEther("1"))).to.equal(ethers.parseEther("0.5"));
    expect(await adapter.twap(await share.getAddress(), ethers.parseEther("1"))).to.equal(ethers.parseEther("2"));
    expect(await adapter.consult(DAI, 0)).to.equal(0n);
    await expect(adapter.consult(WPLS, 1)).to.be.revertedWith("Composite: invalid token");
  });

  it("integrates official DAI and native PLS rebates with the existing treasury", async () => {
    const {user, share, plsOracle, rebates} = await networkHelpers.loadFixture(fixture);
    await rebates.setAsset(WPLS, true, 1000000n, await plsOracle.getAddress());
    expect(await rebates.getSharePrice()).to.equal(ethers.parseEther("2"));
    await rebates.connect(user).bond(DAI, ethers.parseEther("100"));
    await rebates.connect(user).bondPLS(ethers.parseEther("0.00535"), {value: ethers.parseEther("100")});
    const total = ethers.parseEther("53.50535");
    expect((await rebates.totalVested()) + await share.balanceOf(user.address)).to.equal(total);
    await networkHelpers.time.increase(3 * 86400);
    await rebates.connect(user).claimRewards();
    expect(await share.balanceOf(user.address)).to.equal(total);
  });

  for (const leg of ["shareOracle", "plsOracle"] as const) {
    it(`rejects stale/zero/future timestamps and zero prices on ${leg}`, async () => {
      const f = await networkHelpers.loadFixture(fixture);
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const oracle = f[leg];
      await oracle.setTimestamp(now - 86401);
      await expect(f.adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: stale source");
      await oracle.setTimestamp(0);
      await expect(f.adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: stale source");
      await oracle.setTimestamp(now + 10000);
      await expect(f.adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: stale source");
      await oracle.update();
      await oracle.setRate(0, 1);
      await expect(f.adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: zero quote");
    });
  }

  it("reports the oldest timestamp and longest period, rejecting period changes beyond age", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await f.shareOracle.setTimestamp(now - 100);
    expect(await f.adapter.blockTimestampLast()).to.equal(now - 100);
    await f.plsOracle.setPeriod(7200);
    expect(await f.adapter.getPeriod()).to.equal(7200n);
    await f.plsOracle.setPeriod(86401);
    await expect(f.adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: period exceeds age");
  });

  it("validates source pairs, reversed token ordering, and age limits", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const args = [await f.share.getAddress(), await f.shareOracle.getAddress(), await f.plsOracle.getAddress()];
    await expect(ethers.deployContract("RebateCompositeOracle", [...args, 299])).to.be.revertedWith("Composite: invalid age");
    await expect(ethers.deployContract("RebateCompositeOracle", [args[0], args[2], args[1], 86400])).to.be.revertedWith("Composite: wrong pair");
    const reversed = await ethers.deployContract("RebateSourceMock", [DAI, WPLS, 10000n, 1n]);
    const adapter = await ethers.deployContract("RebateCompositeOracle", [args[0], args[1], await reversed.getAddress(), 86400]);
    expect(await adapter.consult(args[0], 10n ** 18n)).to.equal(ethers.parseEther("2"));
  });

  it("updates only due sources and propagates source failures", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const before = await f.adapter.blockTimestampLast();
    await f.adapter.connect(f.user).update();
    expect(await f.adapter.blockTimestampLast()).to.equal(before);
    await networkHelpers.time.increase(3601);
    await f.plsOracle.setFailUpdate(true);
    await expect(f.adapter.update()).to.be.revertedWith("Mock: failed update");
    expect(await f.adapter.blockTimestampLast()).to.equal(before);
    await f.plsOracle.setFailUpdate(false);
    await f.adapter.connect(f.user).update();
    expect(await f.adapter.blockTimestampLast()).to.be.greaterThan(before);
  });

  it("deploys the adapter and safely updates both sources using scripts", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const keys = ["TOMB_SHARE_ADDRESS", "TOMB_SHARE_ORACLE_ADDRESS", "TOMB_REBATE_PLS_ORACLE_ADDRESS", "TOMB_REBATE_MAX_ORACLE_AGE"];
    const saved = keys.map(k => process.env[k]);
    try {
      process.env.TOMB_SHARE_ADDRESS = await f.share.getAddress();
      process.env.TOMB_SHARE_ORACLE_ADDRESS = await f.shareOracle.getAddress();
      process.env.TOMB_REBATE_PLS_ORACLE_ADDRESS = await f.plsOracle.getAddress();
      process.env.TOMB_REBATE_MAX_ORACLE_AGE = "86400";
      const ctx = {ethers, signer: f.owner};
      const adapter = await deployComposite(ctx);
      await updateSources(ctx); // skips early calls
      await networkHelpers.time.increase(3601);
      await updateSources(ctx);
      expect(await adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.equal(ethers.parseEther("2"));
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
  });

  it("deploys a second asset/WPLS composite without changing the RICH adapter", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const asset = await ethers.deployContract("TombScriptToken");
    const pair = await ethers.deployContract("TombScriptPair", [await asset.getAddress(), WPLS]);
    // 200 WPLS per asset * 0.0001 DAI per WPLS = 0.02 DAI per asset.
    await pair.setReserves(10n ** 18n, 200n * 10n ** 18n);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const keys = [
      "TOMB_REBATE_ASSET_TOKEN_ADDRESS",
      "TOMB_REBATE_ASSET_PAIR_ADDRESS",
      "TOMB_REBATE_ASSET_ORACLE_ADDRESS",
      "TOMB_REBATE_ASSET_ORACLE_PERIOD",
      "TOMB_REBATE_ASSET_ORACLE_START_TIME",
      "TOMB_REBATE_PLS_ORACLE_ADDRESS",
      "TOMB_REBATE_MAX_ORACLE_AGE",
    ];
    const saved = keys.map(k => process.env[k]);
    try {
      Object.assign(process.env, {
        TOMB_REBATE_ASSET_TOKEN_ADDRESS: await asset.getAddress(),
        TOMB_REBATE_ASSET_PAIR_ADDRESS: await pair.getAddress(),
        TOMB_REBATE_ASSET_ORACLE_PERIOD: "3600",
        TOMB_REBATE_ASSET_ORACLE_START_TIME: now.toString(),
        TOMB_REBATE_PLS_ORACLE_ADDRESS: await f.plsOracle.getAddress(),
        TOMB_REBATE_MAX_ORACLE_AGE: "7200",
      });
      const ctx = {ethers, signer: f.owner};
      const source = await deployAssetPlsOracle(ctx);
      process.env.TOMB_REBATE_ASSET_ORACLE_ADDRESS = await source.getAddress();
      const assetAdapter = await deployAssetComposite(ctx);
      expect(await f.adapter.token0()).to.equal(await f.share.getAddress());
      expect(await assetAdapter.token0()).to.equal(await asset.getAddress());
      await networkHelpers.time.increase(3601);
      await assetAdapter.update();
      expect(await assetAdapter.consult(await asset.getAddress(), 10n ** 18n)).to.equal(2n * 10n ** 16n);
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
  });

  it("uses the real unchanged 0.6 Oracle on both liquid pairs", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    const a = await ethers.deployContract("TombScriptPair", [await f.share.getAddress(), WPLS]);
    const b = await ethers.deployContract("TombScriptPair", [WPLS, DAI]);
    await a.setReserves(10n ** 18n, 20000n * 10n ** 18n);
    await b.setReserves(10n ** 18n, 10n ** 14n);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const first = await ethers.deployContract("contracts/tomb/Oracle.sol:Oracle", [await a.getAddress(), 3600, now]);
    const second = await ethers.deployContract("contracts/tomb/Oracle.sol:Oracle", [await b.getAddress(), 3600, now]);
    const adapter = await ethers.deployContract("RebateCompositeOracle", [await f.share.getAddress(), await first.getAddress(), await second.getAddress(), 86400]);
    await expect(adapter.consult(await f.share.getAddress(), 10n ** 18n)).to.be.revertedWith("Composite: zero quote");
    await networkHelpers.time.increase(3601);
    await adapter.connect(f.user).update();
    const quote = await adapter.consult(await f.share.getAddress(), 10n ** 18n);
    expect(quote).to.be.greaterThanOrEqual(ethers.parseEther("1.999999999999"));
    expect(quote).to.be.lessThanOrEqual(ethers.parseEther("2"));
    await adapter.update(); // safe no-op immediately after updating
  });

  it("configures an existing treasury without losing vesting and skips adapter role transfers", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    await f.rebates.connect(f.user).bond(DAI, ethers.parseEther("100"));
    const liability = await f.rebates.totalVested();
    const replacement = await ethers.deployContract("RebateCompositeOracle", [await f.share.getAddress(), await f.shareOracle.getAddress(), await f.plsOracle.getAddress(), 86400]);
    const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("TOMB_")));
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      Object.assign(process.env, {
        TOMB_REBATES_ADDRESS: await f.rebates.getAddress(),
        TOMB_REBATE_SHARE_ORACLE_ADDRESS: await replacement.getAddress(),
        TOMB_REBATE_COMPOSITE_ORACLE_ADDRESS: await replacement.getAddress(),
        TOMB_ADMIN_ADDRESS: f.user.address,
      });
      const ctx = {ethers, signer: f.owner};
      await configureRebates(ctx);
      await configureRebates(ctx);
      expect(await f.rebates.ShareOracle()).to.equal(await replacement.getAddress());
      expect(await f.rebates.totalVested()).to.equal(liability);
      await transferAdmin(ctx);
      expect(await f.rebates.owner()).to.equal(f.user.address);
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith("TOMB_")) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
