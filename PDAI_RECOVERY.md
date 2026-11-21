# BetterBank pDAI recovery distribution

This recovery system consists of:

- `contracts/tomb/PDAIRecoveryDistributor.sol`: an immutable snapshot-based,
  pro-rata pDAI distributor.
- `scripts/tomb/build-pdai-recovery-snapshot.ts`: discovers pDAI aToken holders
  and generates the Merkle root and proofs used by the distributor.

## Eligibility calculation

At one fixed PulseChain block, each address receives this weight:

```text
eligibleWeight = max(
  pDAI aToken balance - pDAI stable debt - pDAI variable debt,
  0
)
```

Only debt denominated in pDAI is subtracted. Debt or deposits belonging to a
different asset are not included.

The snapshot script discovers candidate addresses from the pDAI aToken's
`Transfer` events and reads all three balances at the same historical block.
It refuses to create a root when the discovered aToken holder balances do not
reconcile with the aToken's `totalSupply()` within per-account rounding dust.

An archive-capable PulseChain RPC is required because the balances are read at
a historical block.

## Generate the snapshot

Choose and publish the cutoff block before generating the final root. Also find
the block at or before the pDAI aToken deployment.

PowerShell example:

```powershell
$env:PULSECHAIN_RPC_URL="https://your-archive-pulsechain-rpc"
$env:PDAI_SNAPSHOT_BLOCK="YOUR_CUTOFF_BLOCK"
$env:PDAI_ATOKEN_START_BLOCK="ATOKEN_DEPLOYMENT_BLOCK"
$env:PDAI_EXCLUDED_ADDRESSES="0xOptionalTreasury,0xOptionalProtocolAddress"
npx hardhat run scripts/tomb/build-pdai-recovery-snapshot.ts --network pulse
```

The defaults are:

- pDAI: `0x6B175474E89094C44Da98b954EedeAC495271d0F`
- BetterBank data provider: `0x2369CF50eE0e5727bd971c0d2D172Ea6f376EdaA`

Override them with `PDAI_ADDRESS` and `PDAI_DATA_PROVIDER_ADDRESS` if required.
For RPC rate limits, adjust `PDAI_LOG_CHUNK_SIZE` and
`PDAI_BALANCE_BATCH_SIZE`.

The script writes:

```text
output/pdai-recovery-snapshot-<block>.json
```

The JSON includes every address, supply, pDAI debts, final eligible weight,
leaf and proof. Publish this file and allow a review/challenge period before
deploying the immutable root.

## Deploy the distributor

Constructor arguments:

```text
pdai                         pDAI token address
snapshotMerkleRoot           PDAI_RECOVERY_MERKLE_ROOT from the snapshot
snapshotTotalEligibleWeight  PDAI_RECOVERY_TOTAL_ELIGIBLE from the snapshot
snapshotEligibleAccountCount PDAI_RECOVERY_ACCOUNT_COUNT from the snapshot
initialClaimPeriod           seconds, from 0 through 31,536,000
```

Claim-period meanings:

- `0`: no expiry. Unclaimed allocations remain reserved indefinitely.
- `2,592,000`: 30 days.
- `31,536,000`: maximum period of 365 days.

Changing `claimPeriod` only affects future epochs. It cannot retroactively
shorten an existing claim window.

## Monthly operation

1. Approve the distributor to spend the new pDAI funding.
2. Call `startEpoch(newFundingAmount)`.
3. Users call `claim(epochId, account, eligibleWeight, proof)`. Anyone may relay
   the call, but pDAI is always sent to the snapshot account.
4. After the epoch deadline, call `finalizeEpoch(epochId)`.
5. The expired, unclaimed pDAI becomes `rolloverBalance`.
6. The next `startEpoch` combines new pDAI funding with all rollover and divides
   the complete amount across the original snapshot again.

## Emergency recovery

The owner can schedule an emergency recovery if a deployment is broken. The
schedule is public and starts a fixed seven-day delay. New epochs are blocked
during that delay, but existing claims remain available so users have time to
claim.

After the delay, `executeEmergencyWithdrawal(recipient)` transfers the complete
pDAI balance to the chosen nonzero recipient and permanently shuts down claims
and new epochs on that deployment. The intended response is to fix the issue,
deploy a replacement contract, and fund the replacement. The owner can call
`cancelEmergencyWithdrawal()` before execution to restore normal operation.

This escape hatch changes the trust model: allocated pDAI is recoverable by the
owner after public notice rather than being permanently inaccessible to the
owner. It cannot be withdrawn instantly.

Missing one epoch permanently removes that epoch's allocation from the wallet.
The wallet remains eligible for later epochs under the same fixed snapshot.

## Important properties

- Claim order does not affect payout amounts.
- Each account can claim an epoch only once.
- Expired allocations cannot be claimed from that epoch later.
- The Merkle root and eligibility totals cannot be changed after deployment.
- Emergency pDAI recovery requires seven days of public notice and permanently
  shuts down that deployment.
- Several epochs may be open simultaneously, but only finalized balances are
  included in rollover.
- A non-expiring epoch can only be finalized after every eligible account has
  claimed, allowing rounding dust to roll forward without expiring a user.

Before mainnet funding, independently reproduce the snapshot, review every
excluded address, verify the constructor values and audit the deployed bytecode.
