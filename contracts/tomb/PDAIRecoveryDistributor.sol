// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title PDAIRecoveryDistributor
 * @notice Distributes funded pDAI pro rata to a fixed snapshot of net BetterBank
 *         pDAI suppliers.
 *
 * The Merkle snapshot is built off-chain at one block. Each leaf contains:
 *
 *   keccak256(bytes.concat(keccak256(abi.encode(account, eligibleWeight))))
 *
 * where eligibleWeight is:
 *
 *   max(pDAI aToken balance - pDAI stable debt - pDAI variable debt, 0)
 *
 * Each funding epoch is independent. Missing an expiring epoch permanently
 * removes that epoch's entitlement. The unclaimed balance is rolled into a
 * future epoch and divided again across the complete snapshot.
 */
contract PDAIRecoveryDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_CLAIM_PERIOD = 365 days;
    uint256 public constant EMERGENCY_WITHDRAW_DELAY = 7 days;

    struct Epoch {
        uint256 allocation;
        uint256 totalClaimed;
        uint256 startedAt;
        uint256 deadline;
        uint256 claimantCount;
        bool finalized;
    }

    IERC20 public immutable PDAI;
    bytes32 public immutable merkleRoot;
    uint256 public immutable totalEligibleWeight;
    uint256 public immutable eligibleAccountCount;

    // Zero means that newly created epochs do not expire.
    uint256 public claimPeriod;
    uint256 public epochCount;
    uint256 public rolloverBalance;
    uint256 public emergencyWithdrawalUnlockAt;
    bool public emergencyShutdown;

    mapping(uint256 epochId => Epoch epoch) public epochs;
    mapping(uint256 epochId => mapping(address account => bool claimed)) public hasClaimed;

    event ClaimPeriodUpdated(uint256 previousPeriod, uint256 newPeriod);
    event EpochStarted(
        uint256 indexed epochId,
        uint256 newFunding,
        uint256 rollover,
        uint256 allocation,
        uint256 deadline
    );
    event Claimed(
        uint256 indexed epochId,
        address indexed account,
        uint256 eligibleWeight,
        uint256 amount
    );
    event EpochFinalized(uint256 indexed epochId, uint256 totalClaimed, uint256 rolledOver);
    event EmergencyWithdrawalScheduled(uint256 unlockAt);
    event EmergencyWithdrawalCancelled();
    event EmergencyWithdrawalExecuted(address indexed recipient, uint256 amount);

    constructor(
        IERC20 pdai,
        bytes32 snapshotMerkleRoot,
        uint256 snapshotTotalEligibleWeight,
        uint256 snapshotEligibleAccountCount,
        uint256 initialClaimPeriod
    ) Ownable(msg.sender) {
        require(address(pdai) != address(0), "PDAIRecovery: zero token");
        require(snapshotMerkleRoot != bytes32(0), "PDAIRecovery: zero root");
        require(snapshotTotalEligibleWeight != 0, "PDAIRecovery: zero weight");
        require(snapshotEligibleAccountCount != 0, "PDAIRecovery: zero accounts");
        require(initialClaimPeriod <= MAX_CLAIM_PERIOD, "PDAIRecovery: period too long");

        PDAI = pdai;
        merkleRoot = snapshotMerkleRoot;
        totalEligibleWeight = snapshotTotalEligibleWeight;
        eligibleAccountCount = snapshotEligibleAccountCount;
        claimPeriod = initialClaimPeriod;
    }

    /**
     * @notice Sets the expiry period used by future epochs.
     * @dev Existing epoch deadlines never change. Set to zero for no expiry.
     */
    function setClaimPeriod(uint256 newClaimPeriod) external onlyOwner {
        require(newClaimPeriod <= MAX_CLAIM_PERIOD, "PDAIRecovery: period too long");
        uint256 previousPeriod = claimPeriod;
        claimPeriod = newClaimPeriod;
        emit ClaimPeriodUpdated(previousPeriod, newClaimPeriod);
    }

    /**
     * @notice Starts a new distribution epoch with new pDAI plus all finalized
     *         rollover from earlier epochs.
     * @param fundingAmount Amount requested from the owner. The epoch credits
     *        the amount actually received, supporting tokens with transfer fees.
     */
    function startEpoch(uint256 fundingAmount) external onlyOwner nonReentrant returns (uint256 epochId) {
        require(!emergencyShutdown, "PDAIRecovery: emergency shutdown");
        require(emergencyWithdrawalUnlockAt == 0, "PDAIRecovery: emergency pending");
        uint256 balanceBefore = PDAI.balanceOf(address(this));
        if (fundingAmount != 0) {
            PDAI.safeTransferFrom(msg.sender, address(this), fundingAmount);
        }
        uint256 received = PDAI.balanceOf(address(this)) - balanceBefore;

        uint256 rollover = rolloverBalance;
        uint256 allocation = received + rollover;
        require(allocation != 0, "PDAIRecovery: zero allocation");

        rolloverBalance = 0;
        epochId = epochCount++;
        uint256 deadline = claimPeriod == 0 ? 0 : block.timestamp + claimPeriod;

        epochs[epochId] = Epoch({
            allocation: allocation,
            totalClaimed: 0,
            startedAt: block.timestamp,
            deadline: deadline,
            claimantCount: 0,
            finalized: false
        });

        emit EpochStarted(epochId, received, rollover, allocation, deadline);
    }

    /**
     * @notice Claims one snapshot account's allocation for an epoch.
     * @dev Anyone may relay the call, but payment always goes to the snapshot
     *      account, so a relayer cannot redirect funds.
     */
    function claim(
        uint256 epochId,
        address account,
        uint256 eligibleWeight,
        bytes32[] calldata proof
    ) external nonReentrant returns (uint256 amount) {
        require(!emergencyShutdown, "PDAIRecovery: emergency shutdown");
        require(account != address(0), "PDAIRecovery: zero account");
        Epoch storage epoch = _activeEpoch(epochId);
        require(epoch.deadline == 0 || block.timestamp <= epoch.deadline, "PDAIRecovery: claim expired");
        require(!hasClaimed[epochId][account], "PDAIRecovery: already claimed");
        require(eligibleWeight != 0, "PDAIRecovery: zero weight");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, eligibleWeight))));
        require(MerkleProof.verifyCalldata(proof, merkleRoot, leaf), "PDAIRecovery: invalid proof");

        hasClaimed[epochId][account] = true;
        epoch.claimantCount += 1;
        amount = Math.mulDiv(epoch.allocation, eligibleWeight, totalEligibleWeight);
        epoch.totalClaimed += amount;

        if (amount != 0) {
            PDAI.safeTransfer(account, amount);
        }
        emit Claimed(epochId, account, eligibleWeight, amount);
    }

    /**
     * @notice Finalizes an expired epoch and makes its unclaimed allocation
     *         available to the next epoch.
     * @dev A non-expiring epoch can be finalized only after every eligible
     *      account has claimed, allowing rounding dust to be rolled forward.
     */
    function finalizeEpoch(uint256 epochId) external returns (uint256 rolledOver) {
        Epoch storage epoch = _activeEpoch(epochId);
        bool allAccountsClaimed = epoch.claimantCount == eligibleAccountCount;
        bool expired = epoch.deadline != 0 && block.timestamp > epoch.deadline;
        require(allAccountsClaimed || expired, "PDAIRecovery: epoch still active");

        epoch.finalized = true;
        rolledOver = epoch.allocation - epoch.totalClaimed;
        rolloverBalance += rolledOver;

        emit EpochFinalized(epochId, epoch.totalClaimed, rolledOver);
    }

    /**
     * @notice Starts the delay before the owner can recover all pDAI and
     *         permanently shut down this deployment.
     * @dev New epochs are blocked while a withdrawal is pending. Existing
     *      claims remain open during the delay so users have time to claim.
     */
    function scheduleEmergencyWithdrawal() external onlyOwner {
        require(!emergencyShutdown, "PDAIRecovery: emergency shutdown");
        require(emergencyWithdrawalUnlockAt == 0, "PDAIRecovery: emergency pending");
        emergencyWithdrawalUnlockAt = block.timestamp + EMERGENCY_WITHDRAW_DELAY;
        emit EmergencyWithdrawalScheduled(emergencyWithdrawalUnlockAt);
    }

    /**
     * @notice Cancels a pending emergency withdrawal and restores the ability
     *         to start new epochs.
     */
    function cancelEmergencyWithdrawal() external onlyOwner {
        require(emergencyWithdrawalUnlockAt != 0, "PDAIRecovery: no emergency pending");
        emergencyWithdrawalUnlockAt = 0;
        emit EmergencyWithdrawalCancelled();
    }

    /**
     * @notice Recovers all pDAI after the emergency delay and permanently
     *         disables new epochs and claims on this deployment.
     * @dev This is an explicit escape hatch for a broken deployment. Recovery
     *      is publicly announced seven days in advance and cannot be used as
     *      an instant owner withdrawal.
     */
    function executeEmergencyWithdrawal(address recipient) external onlyOwner nonReentrant returns (uint256 amount) {
        require(recipient != address(0), "PDAIRecovery: zero recipient");
        uint256 unlockAt = emergencyWithdrawalUnlockAt;
        require(unlockAt != 0, "PDAIRecovery: no emergency pending");
        require(block.timestamp >= unlockAt, "PDAIRecovery: emergency timelocked");

        amount = PDAI.balanceOf(address(this));
        require(amount != 0, "PDAIRecovery: zero recovery");

        emergencyWithdrawalUnlockAt = 0;
        emergencyShutdown = true;
        PDAI.safeTransfer(recipient, amount);
        emit EmergencyWithdrawalExecuted(recipient, amount);
    }

    function claimable(
        uint256 epochId,
        address account,
        uint256 eligibleWeight,
        bytes32[] calldata proof
    ) external view returns (uint256) {
        if (emergencyShutdown) return 0;
        if (epochId >= epochCount || account == address(0) || eligibleWeight == 0) return 0;
        Epoch storage epoch = epochs[epochId];
        if (
            epoch.finalized ||
            hasClaimed[epochId][account] ||
            (epoch.deadline != 0 && block.timestamp > epoch.deadline)
        ) return 0;

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, eligibleWeight))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) return 0;
        return Math.mulDiv(epoch.allocation, eligibleWeight, totalEligibleWeight);
    }

    function _activeEpoch(uint256 epochId) private view returns (Epoch storage epoch) {
        require(epochId < epochCount, "PDAIRecovery: unknown epoch");
        epoch = epochs[epochId];
        require(!epoch.finalized, "PDAIRecovery: epoch finalized");
    }
}
