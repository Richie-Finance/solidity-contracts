# Richie Finance — PulseChain deployment guide

This guide covers the Tomb core contracts, optional redemption/zap/rebates,
oracle operation, and contract verification. Commands below use PowerShell from
`C:\repo\Richie-Finance` and select **PulseChain mainnet, chain ID 369**.

> These are real mainnet transactions. Deployment and configuration do not
> remove protocol or integration risks. Pin and record the exact Git commit,
> run the complete local test suite, and test with small amounts before opening
> deposits to users.

## Contents

- [1. Prepare the project](#1-prepare-the-project)
- [2. Configure the root .env](#2-configure-the-root-env)
- [3. Deploy the foundation](#3-deploy-the-foundation)
- [4. Create and fund liquidity pairs](#4-create-and-fund-liquidity-pairs)
- [5. Deploy the oracles](#5-deploy-the-oracles)
- [6. Deploy Treasury, Boardroom, and Farm](#6-deploy-treasury-boardroom-and-farm)
- [7. Configure pools and fees](#7-configure-pools-and-fees)
- [8. Fund and connect the core](#8-fund-and-connect-the-core)
- [9. Deploy PEG redemption](#9-deploy-peg-redemption)
- [10. Deploy the zap](#10-deploy-the-zap)
- [11. Deploy DAI, PLS, and configured-token rebates](#11-deploy-dai-pls-and-configured-token-rebates)
- [12. Prime and maintain the oracles](#12-prime-and-maintain-the-oracles)
- [13. Launch and operate Treasury](#13-launch-and-operate-treasury)
- [14. Verify the contracts](#14-verify-the-contracts)
- [15. Transfer administration](#15-transfer-administration)
- [Launch checklist](#launch-checklist)

## 1. Prepare the project

Use a Node.js version supported by the installed Hardhat version, then run:

```powershell
cd C:\repo\Richie-Finance
npm ci
npx hardhat compile
npm run tomb:check:scripts
npm run tomb:test:smoke
npm test
git rev-parse HEAD
```

Do not continue if compilation or tests fail. Local tests use mocks; passing
tests does not validate live liquidity or guarantee security.

Fund your deployment wallet with PLS for gas and the assets needed for liquidity
and reserves. Use the same deployment wallet throughout setup. Transfer
administration last.

## 2. Configure the root .env

The scripts read **`C:\repo\Richie-Finance\.env`**, not an `.env` inside the Tomb folder.
Merge [scripts/tomb/.env.example](scripts/tomb/.env.example) into the root file.
Do not overwrite existing settings blindly or commit your real `.env`.

```dotenv
PULSECHAIN_RPC_URL=https://rpc.pulsechain.com
PULSECHAIN_PRIVATE_KEY=YOUR_DEPLOYMENT_WALLET_PRIVATE_KEY

TOMB_START_TIME=YOUR_FUTURE_UNIX_TIMESTAMP
TOMB_COMMUNITY_FUND=0xYourCommunityWallet
```

All example addresses and uppercase placeholders must be replaced with actual
values. Never share your private key.

Generate a future launch timestamp, for example seven days ahead:

```powershell
[DateTimeOffset]::UtcNow.AddDays(7).ToUnixTimeSeconds()
```

Copy the result into `TOMB_START_TIME`. Keep this timestamp fixed throughout
deployment. Leave `TOMB_FARM_START_TIME` blank to use the same start time, or set
an intentional separate future farm start.

Leave optional settings blank to preserve defaults/current values. PowerShell
`$env:TOMB_...` variables override values in `.env`; remove stale overrides if
you expect changes in the file to take effect.

> Save every printed contract address in `.env` before the next step. Deployment
> scripts always deploy **new contracts**; rerunning them is not a resume action.
> Keep deployment transaction hashes and printed verification commands too.

## 3. Deploy the foundation

```powershell
npm run tomb:deploy:foundation -- --network pulse
```

This deploys PEG, SHARE, and GenesisRewardPool. Save:

```dotenv
TOMB_PEG_ADDRESS=0xDeployedPeg
TOMB_SHARE_ADDRESS=0xDeployedShare
TOMB_GENESIS_ADDRESS=0xDeployedGenesis
```

The deployer initially receives **1 PEG and 1 SHARE**. Plan how to obtain and
divide assets for liquidity, initial Boardroom staking, and rebate reserves.
Tiny liquidity pools are easily manipulated. The later 40,000 RICH Farm
allocation is committed reward funding, not spare liquidity or rebate funding.

## 4. Create and fund liquidity pairs

The scripts do not create pairs or add liquidity. Each oracle pair must contain
nonzero reserves. Use a **PulseX V2** PEG/PDAI pair for compatibility with the zap.

| Pair | Purpose | Environment setting |
| --- | --- | --- |
| PEG/PDAI | Treasury PEG price | `TOMB_PAIR_ADDRESS` |
| PEG/PDAI, same pair | Zap liquidity | `TOMB_PEG_PDAI_PAIR_ADDRESS` |
| SHARE/WPLS | Farm PLS fee pricing | `TOMB_SHARE_PAIR_ADDRESS` |
| SHARE/official DAI | Legacy direct rebate pricing only; NOT required with the composite oracle | `TOMB_REBATE_SHARE_PAIR_ADDRESS` |
| WPLS/official DAI | Native PLS and composite rebate pricing | `TOMB_REBATE_PLS_PAIR_ADDRESS` |

The rebate pairs/oracles are only required if deploying those optional features.
An existing suitable WPLS/official-DAI pair can be reused.

Token addresses used by the contracts:

| Token | Address | Decimals |
| --- | --- | --- |
| PDAI, forked Ethereum-address DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | 18 |
| Official PulseChain DAI | `0xefD766cCb38EaF1dfd701853BFCe31359239F305` | 18 |
| WPLS | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | 18 |
| USD Coin from Ethereum, bridged USDC | `0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07` | 6 |

Rebate prices use official DAI. A DAI-denominated quote does not guarantee a
dollar market value; market and depeg risks remain.

Save the actual **pair/LP contract addresses**, not router or underlying token
addresses:

```dotenv
TOMB_PDAI_ADDRESS=0x6B175474E89094C44Da98b954EedeAC495271d0F
TOMB_PAIR_ADDRESS=0xPegPdaiPair
TOMB_PEG_PDAI_PAIR_ADDRESS=0xPegPdaiPair
TOMB_SHARE_PAIR_ADDRESS=0xShareWplsPair
TOMB_REBATE_SHARE_PAIR_ADDRESS=0xShareDaiPair
TOMB_REBATE_PLS_PAIR_ADDRESS=0xWplsDaiPair
```

Treasury treats the quote token as the peg unit. Use PEG/PDAI for this PDAI peg;
do not substitute a 6-decimal USDC quote in the Treasury setup.

## 5. Deploy the oracles

Generate the **current** timestamp:

```powershell
[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
```

Use it for the oracle starts, not the future farming/launch timestamp:

```dotenv
TOMB_ORACLE_PERIOD=21600
TOMB_ORACLE_START_TIME=YOUR_CURRENT_TIMESTAMP
TOMB_SHARE_ORACLE_PERIOD=3600
TOMB_SHARE_ORACLE_START_TIME=YOUR_CURRENT_TIMESTAMP
TOMB_REBATE_ORACLE_PERIOD=3600
TOMB_REBATE_ORACLE_START_TIME=YOUR_CURRENT_TIMESTAMP
TOMB_REBATE_PLS_ORACLE_PERIOD=3600
TOMB_REBATE_PLS_ORACLE_START_TIME=YOUR_CURRENT_TIMESTAMP
```

Run the required deployments, skipping optional rebate oracles if unused:

```powershell
npm run tomb:deploy:oracle -- --network pulse
npm run tomb:deploy:share-oracle -- --network pulse
npm run tomb:deploy:rebate-pls-oracle -- --network pulse
npm run tomb:deploy:rebate-composite-oracle -- --network pulse
```

Save their distinct addresses:

```dotenv
TOMB_ORACLE_ADDRESS=0xPegOracle
TOMB_SHARE_ORACLE_ADDRESS=0xShareWplsOracle
TOMB_REBATE_SHARE_ORACLE_ADDRESS=0xCompositeAdapter
TOMB_REBATE_COMPOSITE_ORACLE_ADDRESS=0xCompositeAdapter
TOMB_REBATE_PLS_ORACLE_ADDRESS=0xWplsDaiOracle
```

Do not pass the SHARE/WPLS oracle directly to rebates: its quote is WPLS.
The composite adapter chains that oracle with WPLS/official DAI to return raw
18-decimal DAI units.
Save `TOMB_REBATE_PLS_ORACLE_ADDRESS` after deploying it, before deploying the adapter.
Keep the original constructor timestamps for verification.

**Deployment does not call `update()`.** The stored averages initially remain
zero, and `consult()` returns zero until the first successful price update.
See [oracle operation](#12-prime-and-maintain-the-oracles) before launch.

## 6. Deploy Treasury, Boardroom, and Farm

```powershell
npm run tomb:deploy:core -- --network pulse
```

This deploys and initializes Treasury and Boardroom. Save:

```dotenv
TOMB_BOARDROOM_ADDRESS=0xBoardroom
TOMB_TREASURY_ADDRESS=0xTreasury
```

Core deployment uses the same `TOMB_START_TIME` as SHARE, Genesis, and the
default Farm schedule. There is no separate `TOMB_TREASURY_START_TIME`.

Then deploy Farm:

Set the required native-PLS fee destination before deployment. Use the intended
PSM/reserve wallet; it must be capable of receiving native PLS.

```dotenv
TOMB_PSM_FEE_RECIPIENT=0xPsmReserveWallet
```

```powershell
npm run tomb:deploy:farm -- --network pulse
```

Save:

```dotenv
TOMB_FARM_ADDRESS=0xFarm
```

## 7. Configure pools and fees

Use actual staking ERC20 or LP-token addresses:

```dotenv
TOMB_GENESIS_POOLS='[{"token":"0xTokenA","allocPoint":"100","depositFeeBps":0},{"token":"0xTokenB","allocPoint":"50","depositFeeBps":100}]'
TOMB_GENESIS_FEE_RECIPIENT=0xFeeWallet
TOMB_FARM_POOLS='[{"token":"0xStakingToken","allocPoint":"100"}]'
TOMB_PSM_ENABLED=false
TOMB_PSM_FEE_BPS=3000
TOMB_PSM_MAX_ORACLE_AGE=7200
TOMB_PSM_FEE_RECIPIENT=0xFeeWallet
TOMB_MIN_CLAIM_THRESHOLD=1000000000000
```

On later configuration runs, omitting `TOMB_PSM_ENABLED` preserves the current
on-chain state. The configuration script does not temporarily disable an active
PSM while applying other settings.

In this example:

- Token A has no Genesis deposit fee; Token B has a 1% deposit fee.
- `100` and `50` allocations split rewards approximately two-thirds/one-third;
  these are relative weights, not percentages.
- Deposit fees use basis points: `100 = 1%`, which is the contract maximum.
- PSM fee `3000 = 30%` of the reward value, collected in native PLS at harvest;
  it is different from the Genesis deposit fee.
- The PSM fee cannot exceed `5000 = 50%`.
- PSM remains disabled until its oracle has a fresh nonzero price.

Run:

```powershell
npm run tomb:add:pools -- --network pulse
npm run tomb:configure:farm -- --network pulse
```

Eight-decimal staking tokens can be used, but token behavior still matters;
rebasing/sender-tax tokens carry the accounting risks noted in the review.
Native PLS is not an ERC20 staking token; use WPLS. SHARE cannot be a Farm stake
token, and PEG cannot be a Genesis stake token.

The contracts always checkpoint existing pools before adding another pool.
`lastRewardTime` is not configurable. Add a pool with `allocPoint: "0"` to let
users predeposit without earning rewards, then rerun the configuration with a
positive allocation to activate it. Setting the allocation back to zero stops
future rewards without blocking withdrawals.
Matching tokens are updated rather than duplicated. Unlisted existing pools
are not removed or zeroed. Multi-pool allocation changes are separate
transactions, not an atomic switch.

## 8. Fund and connect the core

```powershell
npm run tomb:configure -- --network pulse
```

This distributes **40,176,000 CASH to Genesis** and **40,000 RICH to Farm**, once per
token contract. It gives Treasury operational control of PEG, SHARE, and
Boardroom and applies supplied optional Treasury/Boardroom settings.

Blank optional values preserve current settings. DAO/dev fund changes require
all four related fund/address/fee settings together. Treasury, Genesis, and Farm
administration remains with the signer until the final handover.

Configuration consists of multiple transactions. Later failures do not roll
back earlier transactions. Inspect logs and state before retrying. The supplied
configuration scripts support matching existing pool/distribution setup, but
deployment scripts always create new contracts.

## 9. Deploy PEG redemption

Optional:

Choose the address that will receive redeemed CASH before deployment:

```dotenv
TOMB_REDEEM_PEG_RECIPIENT=0xCashReserveOrSink
```

```powershell
npm run tomb:deploy:redeem -- --network pulse
```

Save `TOMB_REDEEM_ADDRESS`, then set a desired PDAI reserve. For example, 1,000
PDAI in raw 18-decimal units:

```dotenv
TOMB_REDEEM_ADDRESS=0xPegRedeem
TOMB_REDEEM_PEG_RECIPIENT=0xCashReserveOrSink
TOMB_REDEEM_PDAI_RESERVE_WEI=1000000000000000000000
```

```powershell
npm run tomb:configure:redeem -- --network pulse
```

The owner must hold sufficient PDAI. The script approves and supplies only the
shortfall to the target reserve. `0` means no funding; an unfunded contract is
not ready to redeem. PEG/PDAI decimals must match. Received CASH goes to the
fixed `TOMB_REDEEM_PEG_RECIPIENT` selected at deployment rather than being
burned. The owner can retrieve PDAI reserves to an explicitly supplied address;
the contract still has no on-chain below-peg check or per-epoch redemption cap.

## 10. Deploy the zap

Optional, with both funded PulseX V2 PEG/pDAI and SHARE/WPLS pairs configured in the root `.env`:

```dotenv
TOMB_PEG_PDAI_PAIR_ADDRESS=0x74EDdc84AeCA6E1ccf96Be708f8f3b56F852BC45
TOMB_SHARE_PAIR_ADDRESS=0xA55F23241B3068D9aF3A7F3CA51747bD2d709A6f
```

Also set `TOMB_PEG_ADDRESS` and `TOMB_SHARE_ADDRESS` to the deployed tokens.
Use LP addresses here, never the PEG or SHARE token address.

```powershell
npm run tomb:deploy:zap -- --network pulse
```

This command deploys **two** contracts. Save `TOMB_ZAP_ADDRESS` (PEG/pDAI)
and `TOMB_SHARE_ZAP_ADDRESS` (SHARE/WPLS). It validates both pairs' tokens,
factory registration, and nonzero reserves before submitting either deployment.
No additional zap configuration script is required.
Its router/factory/WPLS/PDAI addresses are fixed to PulseChain mainnet.
Each contract accepts either underlying ERC20 token through `zapInToken` and
returns both underlying tokens through `zapOut`. Native PLS must first be wrapped
or swapped. The UI now connects PEG/pDAI to `0x350a687BdcfcfE011b4f9a6E5567c7A58Bfc4b31`
and SHARE/WPLS to `0x51d34399DE1645C1AFa681B77Ba3D5daaC54dE9c`.
Each zap's swap and liquidity creation are atomic; native PLS conversion/wrapping
and optional Farm deposit remain separate transactions. If redeploying, update
the matching zap address in the UI's `src/constants/contracts.ts`.
Do not repeat this command unintentionally: it deploys new addresses.

## 11. Deploy DAI, PLS, and configured-token rebates

Optional; requires Treasury, SHARE, and the composite RICH -> WPLS -> official
DAI oracle. No RICH/DAI LP is needed. Reuse the farm's RICH/WPLS oracle and an
existing WPLS/official-DAI oracle. Set their addresses, then deploy the adapter:

```powershell
npm run tomb:deploy:rebate-composite-oracle -- --network pulse
```

Save BOTH printed variables in the root `.env`:

```dotenv
TOMB_REBATE_COMPOSITE_ORACLE_ADDRESS=0xCompositeAdapter
TOMB_REBATE_SHARE_ORACLE_ADDRESS=0xCompositeAdapter
```

The adapter has immutable sources and maximum age (`TOMB_REBATE_MAX_ORACLE_AGE`
at deployment), and no owner/operator. Keep both variables set so administration
transfer skips it; transfer the underlying Oracle roles as usual. To change the
adapter's source addresses or age limit, deploy a new adapter.

Prime and maintain BOTH source observations:

```powershell
npm run tomb:update:rebate-oracles -- --network pulse
```

This command skips sources until both their epoch and full observation window
are due. Repeat after the printed timestamp if skipped. It leaves the general
`tomb:update:oracles` script untouched. Use comparable observation periods and
keep both within the adapter and treasury freshness limits. Quotes reject stale,
future, zero-timestamp, and zero-price sources. `1e18` raw RICH returns its quote
in raw 18-decimal official DAI units. This is a cross-price from two stored
TWAPs, not an exact direct-pair TWAP; liquidity, manipulation, and DAI market
risks remain. `twap()` on the adapter is a
compatibility alias for the stored quote, not a fresh shorter-window sample.

Important inherited limitation: Oracle.sol's epoch scheduling permits a caller
to overwrite a long average with a very short observation around an epoch
boundary. The adapter's update method and maintenance script avoid doing this,
but cannot prevent someone calling either source Oracle directly. Freshness is
not proof of a full-length TWAP. This adapter does NOT fix that existing Oracle
finding; address that separately before relying on the rebates in production.

For a new treasury:

```powershell
npm run tomb:deploy:rebates -- --network pulse
```

Save and configure:

```dotenv
TOMB_REBATES_ADDRESS=0xRebateTreasury
TOMB_REBATE_DISCOUNT=70000
TOMB_REBATE_VESTING_SECONDS=259200
TOMB_REBATE_MAX_ORACLE_AGE=86400
TOMB_REBATE_SHARE_RESERVE_WEI=YOUR_DESIRED_SHARE_RESERVE_IN_RAW_UNITS
TOMB_REBATE_PLS_ENABLED=true
TOMB_REBATE_PLS_MULTIPLIER=1000000
```

These settings mean a 7% bonus, three-day vesting, and a PLS multiplier of 1.
The discount uses 1e6 precision and cannot exceed `500000` (50%).
Leave `TOMB_REBATE_ASSETS` blank for the default official DAI setup. Leave PLS
enabled blank/false if not configuring PLS rebates. To add pDAI or another ERC20,
provide a direct token/official-DAI oracle:

```dotenv
TOMB_REBATE_ASSETS='[{"token":"0x6B175474E89094C44Da98b954EedeAC495271d0F","multiplier":"1000000","oracle":"0xPdaiDaiOracle"}]'
```

One SHARE is `1000000000000000000` raw units. Fund the rebate reserve using
SHARE the owner actually holds, separately from Farm reward obligations.

```powershell
npm run tomb:configure:rebates -- --network pulse
```

Official DAI is enabled by the constructor and needs no additional asset oracle.
pDAI and every other configured ERC20 require a direct token/official-DAI oracle.
The contract normalizes each configured token's native decimals into the
18-decimal DAI quote; tokens reporting more than 36 decimals are rejected.
Deploy a new RebateTreasury when migrating from the former USDC-denominated
version because its quote asset and constructor defaults have changed.

PLS requires the WPLS/official-DAI oracle. Both rebate price observations must be fresh
and nonzero before native PLS rebates work. LP rebate assets and LP reserve-based
pricing are not supported by the contract or configuration script.

Native deposits use payable `bondPLS(minShareOut)`, not a plain PLS transfer.
ERC20 deposits use approval followed by `bond(token, amount)`. The rebate
contract retains vesting/bond-named functions; it is optional and separate from
the bondless Treasury core. New deposits can restart the user's remaining
vesting schedule. Do not open rebates before reserve funding and prices are ready.

## 12. Prime and maintain the oracles

### First update

The deployment scripts do not call `update()`. A successful first update fills
the stored price averages. A transaction with no elapsed observation time can
return without populating a price.

The update script deliberately checks for a full observation period since the
oracle's `blockTimestampLast`. Initially this timestamp comes from the pair's
last reserve update, so the precise readiness time is not necessarily deployment
time. For a newly seeded pair, allow approximately:

| Oracle | Default observation period |
| --- | --- |
| PEG/PDAI | 21,600 seconds / 6 hours |
| SHARE/WPLS | 3,600 seconds / 1 hour |
| SHARE/official DAI, legacy direct alternative | 3,600 seconds / 1 hour |
| WPLS/official DAI | 3,600 seconds / 1 hour |

Run:

```powershell
cd C:\repo\Richie-Finance
npm run tomb:update:oracles -- --network pulse
```

### Exactly what the script does

It uses the wallet/network configured in the root `.env` and:

1. Reads the four oracle address settings listed in step 5.
2. Skips blank addresses and avoids updating duplicate addresses twice.
3. Reads each oracle's `blockTimestampLast()` and `getPeriod()`.
4. Compares the latest chain timestamp with `blockTimestampLast + period`.
5. If not ready, prints the Unix timestamp to wait until and skips that oracle.
6. If ready, sends `update()`, waits for confirmation, and prints its transaction
   hash. Each transaction costs PLS gas.

The script runs once and exits. It does **not** deploy contracts, wait until a
future time, schedule updates, allocate Treasury rewards, or update the frontend.
If a transaction fails, later oracles may not be processed; inspect the output
and retry after resolving the cause.

You can call `update()` manually through an explorer instead, but one call does
not start a continuous process. Verify that stored prices are nonzero afterward.

### Enable the Farm PSM

Once SHARE/WPLS pricing is fresh and nonzero, set:

```dotenv
TOMB_PSM_ENABLED=true
```

Then:

```powershell
npm run tomb:configure:farm -- --network pulse
```

### Ongoing updates

Use a keeper or regular manual calls. Update sufficiently often that prices do
not exceed their maximum age. Defaults are 7,200 seconds for the Farm PSM and
86,400 seconds for rebates. Keep observation periods within those limits and
allow operational headroom for transaction delays.

`Oracle.update()` now requires at least one complete observation period, so the
historical one-second stored-price overwrite does not apply to this release.
Treasury calls the PEG oracle update inside `allocateSeigniorage()`. If another
account has just updated it, Treasury accepts that stored observation only when
its timestamp is nonzero and no more than six hours old and its price is nonzero.
The failed not-yet-due update attempt cannot block the Treasury epoch. SHARE and
rebate source oracles still require regular external updates.

## 13. Launch and operate Treasury

At least one user must have SHARE staked in Boardroom before the first reward
allocation; allocation to an empty Boardroom can revert. Plan this alongside
the limited initial SHARE available for liquidity and reserves.

Treasury emissions are not automatic. After launch, call `allocateSeigniorage()`
when eligible, then maintain calls for the six-hour Treasury epochs. The call
updates the PEG oracle internally. A separate successful PEG update immediately
before allocation is safe; Treasury validates and uses the fresh stored price if
its own update attempt is not yet due.

To call Treasury manually:

```powershell
npx hardhat console --network pulse
```

Inside the console:

```javascript
const { ethers } = await network.connect();
const treasury = await ethers.getContractAt("contracts/tomb/Treasury.sol:Treasury", process.env.TOMB_TREASURY_ADDRESS);
await (await treasury.allocateSeigniorage()).wait();
```

Enter `.exit` to leave. Calling before eligibility or without required setup can
revert. Do not assume the scripts install a keeper or handle missed epochs.

Update your frontend with the deployed addresses and test deposits, fees,
withdrawals, harvests, Boardroom claims, redemption, zap, and rebate vesting as
applicable. Deployment scripts do not update the UI automatically.

## 14. Verify the contracts

Verification publishes matching source/build information; it does not redeploy
the contract or certify its security. Keep the exact deployment sources,
compiler settings, build-info files, constructor arguments, and creation hashes.

### Hardhat verification

Deployment scripts print verification commands. Replace `<network>` with
`pulse`. Examples, with placeholders to replace:

```powershell
cd C:\repo\Richie-Finance
npx hardhat verify --network pulse PEG_ADDRESS
npx hardhat verify --network pulse SHARE_ADDRESS ORIGINAL_START_TIMESTAMP COMMUNITY_WALLET
npx hardhat verify --network pulse GENESIS_ADDRESS PEG_ADDRESS ORIGINAL_START_TIMESTAMP
npx hardhat verify --network pulse TREASURY_ADDRESS
npx hardhat verify --network pulse BOARDROOM_ADDRESS
npx hardhat verify --network pulse --contract contracts/tomb/Oracle.sol:Oracle ORACLE_ADDRESS PAIR_ADDRESS ORIGINAL_PERIOD ORIGINAL_ORACLE_START_TIMESTAMP
```

Use the original deployment values, not current `.env` values if changed later.
Treasury and Boardroom initialization arguments are not constructor arguments.
For Farm, redemption, rebates, and zap, use their printed commands.

If explorer verification hangs, use Sourcify instead. A pending verification
request is not evidence that deployment failed. Do not redeploy just to retry
verification.

### Sourcify verification

The supplied script uses compiled build information and chain ID 369:

```powershell
npm run verify:sourcify -- --chain-id 369 --address YOUR_CONTRACT_ADDRESS --contract contracts/tomb/Peg.sol:Peg --creation-tx YOUR_CREATION_TRANSACTION_HASH
```

Treasury example:

```powershell
npm run verify:sourcify -- --chain-id 369 --address YOUR_TREASURY_ADDRESS --contract contracts/tomb/Treasury.sol:Treasury --creation-tx YOUR_TREASURY_CREATION_TRANSACTION_HASH
```

Repeat for every deployed contract, including each separate oracle. Change the
address, source/name, and creation transaction hash each time:

| Deployment | Exact `--contract` value |
| --- | --- |
| PEG | `contracts/tomb/Peg.sol:Peg` |
| SHARE | `contracts/tomb/Share.sol:Share` |
| Genesis | `contracts/tomb/GenesisRewardPool.sol:GenesisRewardPool` |
| Farm | `contracts/tomb/Farm.sol:ShareRewardPool` |
| Treasury | `contracts/tomb/Treasury.sol:Treasury` |
| Boardroom | `contracts/tomb/Boardroom.sol:Boardroom` |
| Each oracle | `contracts/tomb/Oracle.sol:Oracle` |
| PEG redemption | `contracts/tomb/PegRedeem.sol:PegRedeem` |
| Rebates | `contracts/tomb/Rebates.sol:RebateTreasury` |
| PEG/pDAI zap | `contracts/tomb/Zap.sol:PegPdaiZap` |
| SHARE/WPLS zap | `contracts/tomb/Zap.sol:ShareWplsZap` |

Use the transaction that **created** the contract, not a later initialization,
configuration, liquidity, or oracle-update transaction. Sourcify constructor
arguments are not passed separately on this command. `--creation-tx` is an
optional script argument, but supplying the correct hash is useful for matching.

The script selects the newest matching file in `artifacts/build-info` by default.
If multiple builds exist, or you changed sources after deployment, explicitly
select the original build:

```powershell
npm run verify:sourcify -- --chain-id 369 --address YOUR_CONTRACT_ADDRESS --contract contracts/tomb/Treasury.sol:Treasury --creation-tx YOUR_CREATION_TRANSACTION_HASH --build-info "artifacts/build-info/YOUR_ORIGINAL_BUILD.json"
```

Additional options:

```powershell
npm run verify:sourcify -- --help
```

Do not delete original artifacts to fix verification. A newly compiled modified
contract will not match an older deployment. Sourcify verification also does
not guarantee every explorer immediately displays that verification.

## 15. Transfer administration

After configuration, funding, oracle priming, verification, and small live tests:

```dotenv
TOMB_ADMIN_ADDRESS=0xYourAdminOrMultisig
```

```powershell
npm run tomb:transfer:admin -- --network pulse
```

Only contracts with nonempty address entries are processed. This transfers token
ownership; Treasury/Genesis/Farm operators; oracle ownership/operators; and
optional redemption/rebate/zap ownership. PEG, SHARE, and Boardroom operational
permissions stay with Treasury.

Future configuration requires the new authorized account. If it is a multisig,
perform administrative actions through that multisig rather than assuming the
old deployment private key still has authority. Community/dev fund roles remain
the addresses selected for those roles.

## Launch checklist

- [ ] Compilation, script checks, and local tests pass.
- [ ] Root `.env` is private and contains all intended deployed addresses.
- [ ] Deployment hashes, constructor values, and original builds are preserved.
- [ ] Launch/farm timestamps are intentional and unchanged accidentally.
- [ ] Correct pairs have adequately planned liquidity; quote currencies match.
- [ ] Genesis and Farm pools/allocations/fees are correct and rewards funded.
- [ ] Treasury controls PEG/SHARE/Boardroom operational permissions.
- [ ] Every required oracle has a successful update and nonzero usable price.
- [ ] Oracle update maintenance and Treasury allocation calls are arranged.
- [ ] Boardroom has SHARE staked before its first allocation.
- [ ] Redemption and rebate reserves are separately funded, if enabled.
- [ ] Small live tests and frontend address configuration are complete.
- [ ] Verification is checked; final administration handover is confirmed.
- [ ] Remaining security-review risks are understood, not assumed fixed by setup.

## Collecting Farm PSM fees (PLS)

Native PLS harvest fees remain in the Farm until its **operator** calls
`collectPsmFees(uint256 amount)`. Collection sends PLS to the configured
`psmFeeRecipient`, not necessarily the calling wallet. It does not withdraw
users' LP deposits or the Farm's SHARE reward tokens.

### Check authority, recipient, and available balance

Open PowerShell in the deployment repository:

```powershell
cd C:\repo\Richie-Finance
npx hardhat console --network pulse
```

Inside the console:

```javascript
const { ethers } = await network.connect();
const farm = await ethers.getContractAt("contracts/tomb/Farm.sol:ShareRewardPool", process.env.TOMB_FARM_ADDRESS);
const [signer] = await ethers.getSigners();
console.log("Calling wallet:", signer.address);
console.log("Operator:", await farm.operator());
console.log("Recipient:", await farm.psmFeeRecipient());
const balance = await ethers.provider.getBalance(await farm.getAddress());
console.log("Available PLS:", ethers.formatEther(balance));
```

For the current deployment, `TOMB_FARM_ADDRESS` is
`0xa0CBde0D37dFd1438A49A74fA47578439Ec35a23`. Confirm your root `.env` points
to the intended Farm before continuing.

The calling wallet must match `operator()`. Confirm that `psmFeeRecipient()` is
the intended destination. The wallet also needs its own PLS for transaction gas.
If administration was transferred to a multisig, execute the collection through
that multisig; its owner's ordinary wallet is not itself the Farm operator.

### Collect all available PLS

After confirming the checks above, fetch the latest balance and collect it:

```javascript
const amountToCollect = await ethers.provider.getBalance(await farm.getAddress());
if (amountToCollect > 0n) {
  const tx = await farm.collectPsmFees(amountToCollect);
  console.log("Collection transaction:", tx.hash);
  await tx.wait();
} else {
  console.log("No PLS available to collect.");
}
```

Fees received after this balance read are not included in that collection.

### Collect a specific amount

Instead of collecting the full balance, for example collect **100 PLS**:

```javascript
const tx = await farm.collectPsmFees(ethers.parseEther("100"));
console.log("Collection transaction:", tx.hash);
await tx.wait();
```

Run one collection option, not both unless you intentionally want two
transactions. The amount must not exceed the Farm's current native PLS balance.
`parseEther("100")` represents 100 PLS in raw 18-decimal units, not a USD amount.
An unauthorized caller, insufficient contract balance, or recipient that rejects
native PLS will cause the transaction to revert. Enter `.exit` to leave the console.

For further script-specific details, see [scripts/tomb/README.md](scripts/tomb/README.md).
