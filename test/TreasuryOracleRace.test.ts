import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

const HOUR = 60n * 60n;
const TREASURY_PERIOD = 6n * HOUR;
const STAKE = ethers.parseEther("1");

type FixtureOptions = {
  oraclePeriod?: bigint;
  treasuryStartDelay?: bigint;
  stakeBoardroom?: boolean;
};

async function deploySystem(options: FixtureOptions = {}) {
  const {
    oraclePeriod = HOUR,
    treasuryStartDelay = oraclePeriod + 100n,
    stakeBoardroom = true,
  } = options;
  const [operator, outsider, member] = await ethers.getSigners();
  const initialBlock = await ethers.provider.getBlock("latest");
  const shareStart = BigInt(initialBlock!.timestamp) + 365n * 24n * HOUR;

  const peg = await ethers.deployContract("contracts/tomb/Peg.sol:Peg");
  const share = await ethers.deployContract("contracts/tomb/Share.sol:Share", [
    shareStart,
    operator.address,
  ]);
  const quote = await ethers.deployContract("TombScriptToken");
  const pair = await ethers.deployContract("TombScriptPair", [
    await peg.getAddress(),
    await quote.getAddress(),
  ]);
  await pair.setReserves(
    ethers.parseEther("1"),
    ethers.parseEther("1.1"),
  );

  const oracleStartBlock = await ethers.provider.getBlock("latest");
  const oracle = await ethers.deployContract(
    "contracts/tomb/Oracle.sol:Oracle",
    [
      await pair.getAddress(),
      oraclePeriod,
      BigInt(oracleStartBlock!.timestamp),
    ],
  );

  const beforeCore = await ethers.provider.getBlock("latest");
  const treasuryStart = BigInt(beforeCore!.timestamp) + treasuryStartDelay;
  const treasury = await ethers.deployContract(
    "contracts/tomb/Treasury.sol:Treasury",
  );
  const boardroom = await ethers.deployContract(
    "contracts/tomb/Boardroom.sol:Boardroom",
  );

  await treasury.initialize(
    await peg.getAddress(),
    await share.getAddress(),
    await oracle.getAddress(),
    await boardroom.getAddress(),
    treasuryStart,
  );
  await boardroom.initialize(
    await peg.getAddress(),
    await share.getAddress(),
    await treasury.getAddress(),
  );

  if (stakeBoardroom) {
    await share.transfer(member.address, STAKE);
    await share.connect(member).approve(await boardroom.getAddress(), STAKE);
    await boardroom.connect(member).stake(STAKE);
  }

  await peg.transferOperator(await treasury.getAddress());
  await share.transferOperator(await treasury.getAddress());
  await boardroom.setOperator(await treasury.getAddress());

  return {
    operator,
    outsider,
    member,
    peg,
    share,
    pair,
    oracle,
    treasury,
    boardroom,
    treasuryStart,
  };
}

describe("Treasury PEG oracle update ordering", () => {
  it("updates a due Oracle during normal Treasury allocation and preserves the short-window guard", async () => {
    const { operator, member, oracle, treasury, boardroom, treasuryStart } =
      await deploySystem();

    await networkHelpers.time.increaseTo(treasuryStart);
    await treasury.allocateSeigniorage();

    expect(await treasury.epoch()).to.equal(1n);
    expect(await treasury.previousEpochPegPrice()).to.be.greaterThan(0n);
    expect(await boardroom.earned(member.address)).to.be.greaterThan(0n);
    await expect(oracle.connect(operator).update()).to.be.revertedWith(
      "Oracle: PERIOD_NOT_ELAPSED",
    );
  });

  it("accepts a fresh observation updated by a third party immediately before allocation", async () => {
    const {
      operator,
      outsider,
      member,
      oracle,
      treasury,
      boardroom,
      treasuryStart,
    } = await deploySystem();

    await networkHelpers.time.increaseTo(treasuryStart);
    await oracle.connect(outsider).update();
    const thirdPartyUpdate = await oracle.blockTimestampLast();

    await expect(oracle.connect(operator).update()).to.be.revertedWith(
      "Oracle: PERIOD_NOT_ELAPSED",
    );
    await treasury.allocateSeigniorage();

    expect(await treasury.epoch()).to.equal(1n);
    expect(await oracle.blockTimestampLast()).to.equal(thirdPartyUpdate);
    expect(await treasury.previousEpochPegPrice()).to.be.greaterThan(0n);
    expect(await boardroom.earned(member.address)).to.be.greaterThan(0n);
  });

  it("advances repeated pre-updated epochs so Boardroom locks mature", async () => {
    const {
      outsider,
      member,
      share,
      oracle,
      treasury,
      boardroom,
      treasuryStart,
    } = await deploySystem();

    for (let index = 0; index < 4; index += 1) {
      const epochPoint = treasuryStart + BigInt(index) * TREASURY_PERIOD;
      await networkHelpers.time.increaseTo(epochPoint);
      await oracle.connect(outsider).update();

      if (index === 0) {
        await expect(
          boardroom.connect(member).withdraw(STAKE),
        ).to.be.revertedWith("Boardroom: still in withdraw lockup");
      }

      await treasury.allocateSeigniorage();
      expect(await treasury.epoch()).to.equal(BigInt(index + 1));
    }

    expect(await boardroom.canClaimReward(member.address)).to.equal(true);
    expect(await boardroom.canWithdraw(member.address)).to.equal(true);
    await boardroom.connect(member).withdraw(STAKE);
    expect(await boardroom.balanceOf(member.address)).to.equal(0n);
    expect(await share.balanceOf(member.address)).to.equal(STAKE);
  });

  it("rejects a fresh timestamp whose Oracle price has not been initialized", async () => {
    const { oracle, treasury, treasuryStart } = await deploySystem({
      oraclePeriod: 12n * HOUR,
      treasuryStartDelay: 100n,
    });

    expect(await oracle.blockTimestampLast()).to.not.equal(0n);
    expect(
      await oracle.consult(await treasury.peg(), ethers.parseEther("1")),
    ).to.equal(0n);

    await networkHelpers.time.increaseTo(treasuryStart);
    await expect(treasury.allocateSeigniorage()).to.be.revertedWith(
      "Treasury: invalid oracle price",
    );
    expect(await treasury.epoch()).to.equal(0n);
  });

  it("rejects a positive stored observation after the Treasury freshness window", async () => {
    const {
      outsider,
      oracle,
      treasury,
      treasuryStart,
    } = await deploySystem({
      oraclePeriod: 12n * HOUR,
      treasuryStartDelay: 18n * HOUR + 300n,
    });

    const initialTimestamp = await oracle.blockTimestampLast();
    await networkHelpers.time.increaseTo(initialTimestamp + 12n * HOUR + 1n);
    await oracle.connect(outsider).update();
    expect(
      await oracle.consult(await treasury.peg(), ethers.parseEther("1")),
    ).to.be.greaterThan(0n);

    await networkHelpers.time.increaseTo(treasuryStart);
    await expect(treasury.allocateSeigniorage()).to.be.revertedWith(
      "Treasury: stale oracle",
    );
    expect(await treasury.epoch()).to.equal(0n);
  });

  it("reports an empty Boardroom instead of masking it as an oracle-ordering failure", async () => {
    const { outsider, oracle, treasury, treasuryStart } = await deploySystem({
      stakeBoardroom: false,
    });

    await networkHelpers.time.increaseTo(treasuryStart);
    await oracle.connect(outsider).update();
    await expect(treasury.allocateSeigniorage()).to.be.revertedWith(
      "Boardroom: cannot allocate when empty",
    );
    expect(await treasury.epoch()).to.equal(0n);
  });
});
