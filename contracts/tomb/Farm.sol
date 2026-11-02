// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOracle} from "./interfaces/IOracle.sol";

interface IPairOracle is IOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

// This pool cannot mint its reward token. Governance must fund it before rewards begin.
contract ShareRewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PSM_FEE_BPS = 5000;
    uint256 public constant MAX_ALLOC_POINT = 1_000_000;
    address public constant WPLS =
        0xA1077a294dDE1B09bB078844df40758a5D0f9a27;

    address public operator;

    struct UserInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    struct PoolInfo {
        IERC20 token;
        uint256 allocPoint;
        uint256 lastRewardTime;
        uint256 accSharePerShare;
        uint256 totalStaked;
    }

    IERC20 public share;
    IPairOracle public shareOracle;

    bool public pegStabilityModuleFeeEnabled;
    uint256 public pegStabilityModuleFee = 3000;
    uint256 public minClaimThreshold = 1e12;
    uint256 public maxOracleAge = 2 hours;
    address payable public psmFeeRecipient;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;
    mapping(uint256 => mapping(address => uint256)) public pendingRewards;

    uint256 public totalAllocPoint;
    uint256 public poolStartTime;
    uint256 public poolEndTime;

    uint256 public constant RUNNING_TIME = 365 days;
    uint256 public constant TOTAL_REWARDS = 40_000 ether;
    // Informational average. Reward accounting uses cumulative pro-rata
    // emission below so the final interval includes all rounding dust.
    uint256 public sharePerSecond = TOTAL_REWARDS / RUNNING_TIME;
    uint256 public runningTime = RUNNING_TIME;

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event PegStabilityModuleFeeChanged(uint256 oldFeeBps, uint256 newFeeBps);
    event PegStabilityModuleFeeEnabledChanged(bool enabled);
    event ShareOracleChanged(address indexed oldOracle, address indexed newOracle);
    event PsmFeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event MinClaimThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    event MaxOracleAgeChanged(uint256 oldMaxAge, uint256 newMaxAge);
    event PsmFeesCollected(address indexed recipient, uint256 amount);

    constructor(address _share, uint256 _poolStartTime, address payable _recipient) {
        require(_share != address(0), "ShareRewardPool: zero reward token");
        require(_recipient != address(0), "ShareRewardPool: zero fee recipient");
        require(block.timestamp < _poolStartTime, "late");

        share = IERC20(_share);
        poolStartTime = _poolStartTime;
        poolEndTime = _poolStartTime + runningTime;
        operator = msg.sender;
        psmFeeRecipient = _recipient;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "ShareRewardPool: caller is not the operator");
        _;
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    function checkPoolDuplicate(IERC20 _token) internal view {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            require(poolInfo[pid].token != _token, "ShareRewardPool: existing pool?");
        }
    }

    function add(
        uint256 _allocPoint,
        IERC20 _token
    ) external onlyOperator {
        require(address(_token) != address(0), "ShareRewardPool: zero pool token");
        require(_token != share, "ShareRewardPool: reward token cannot be staked");
        require(_allocPoint <= MAX_ALLOC_POINT,"Pool: allocation too high");
        checkPoolDuplicate(_token);

        // Settle every existing pool with the old allocation weights before
        // the new pool changes totalAllocPoint. A zero-allocation pool can
        // accept deposits now and be activated later through set().
        massUpdatePools();

        uint256 lastRewardTime = block.timestamp < poolStartTime
            ? poolStartTime
            : block.timestamp;

        poolInfo.push(
            PoolInfo({
                token: _token,
                allocPoint: _allocPoint,
                lastRewardTime: lastRewardTime,
                accSharePerShare: 0,
                totalStaked: 0
            })
        );

        totalAllocPoint += _allocPoint;
    }

    function set(uint256 _pid, uint256 _allocPoint) public onlyOperator {
        require(_allocPoint <= MAX_ALLOC_POINT,"Pool: allocation too high");
        massUpdatePools();

        PoolInfo storage pool = poolInfo[_pid];
        totalAllocPoint = totalAllocPoint - pool.allocPoint + _allocPoint;
        pool.allocPoint = _allocPoint;
    }

    function getGeneratedReward(
        uint256 _fromTime,
        uint256 _toTime
    ) public view returns (uint256) {
        if (_fromTime >= _toTime) return 0;
        return _cumulativeReward(_toTime) - _cumulativeReward(_fromTime);
    }

    function _cumulativeReward(uint256 timestamp) internal view returns (uint256) {
        if (timestamp <= poolStartTime) return 0;
        if (timestamp >= poolEndTime) return TOTAL_REWARDS;
        return Math.mulDiv(
            timestamp - poolStartTime,
            TOTAL_REWARDS,
            RUNNING_TIME
        );
    }

    function pendingShare(uint256 _pid, address _user) public view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        uint256 accSharePerShare = pool.accSharePerShare;
        uint256 tokenSupply = pool.totalStaked;

        if (
            block.timestamp > pool.lastRewardTime &&
            tokenSupply != 0 &&
            totalAllocPoint != 0 &&
            pool.allocPoint != 0
        ) {
            uint256 generatedReward = getGeneratedReward(
                pool.lastRewardTime,
                block.timestamp
            );
            uint256 shareReward =
                (generatedReward * pool.allocPoint) / totalAllocPoint;
            accSharePerShare += (shareReward * 1e18) / tokenSupply;
        }

        return
            (user.amount * accSharePerShare) /
            1e18 -
            user.rewardDebt +
            pendingRewards[_pid][_user];
    }

    function pendingShareAndPendingRewards(
        uint256 _pid,
        address _user
    ) external view returns (uint256) {
        return pendingShare(_pid, _user);
    }

    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            updatePool(pid);
        }
    }

    function updatePool(uint256 _pid) public {
        PoolInfo storage pool = poolInfo[_pid];
        if (block.timestamp <= pool.lastRewardTime) {
            return;
        }

        uint256 tokenSupply = pool.totalStaked;
        if (
            tokenSupply == 0 ||
            totalAllocPoint == 0 ||
            pool.allocPoint == 0
        ) {
            pool.lastRewardTime = block.timestamp;
            return;
        }

        uint256 generatedReward = getGeneratedReward(
            pool.lastRewardTime,
            block.timestamp
        );
        uint256 shareReward =
            (generatedReward * pool.allocPoint) / totalAllocPoint;
        pool.accSharePerShare += (shareReward * 1e18) / tokenSupply;

        pool.lastRewardTime = block.timestamp;
    }

    function deposit(uint256 _pid, uint256 _amount) public nonReentrant {
        address sender = msg.sender;
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][sender];

        updatePool(_pid);
        _accruePendingRewards(_pid, sender, user, pool);

        if (_amount > 0) {
            uint256 balanceBefore = pool.token.balanceOf(address(this));
            pool.token.safeTransferFrom(sender, address(this), _amount);
            uint256 received = pool.token.balanceOf(address(this)) - balanceBefore;

            user.amount += received;
            pool.totalStaked += received;
        }

        user.rewardDebt = (user.amount * pool.accSharePerShare) / 1e18;
        emit Deposit(sender, _pid, _amount);
    }

    function withdraw(uint256 _pid, uint256 _amount) public nonReentrant {
        address sender = msg.sender;
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][sender];

        require(user.amount >= _amount, "withdraw: not good");
        updatePool(_pid);
        _accruePendingRewards(_pid, sender, user, pool);

        if (_amount > 0) {
            user.amount -= _amount;
            pool.totalStaked -= _amount;
            uint256 beforeBalance = pool.token.balanceOf(address(this));
            pool.token.safeTransfer(sender, _amount);
            require(beforeBalance - pool.token.balanceOf(address(this)) == _amount, "ShareRewardPool: unsupported token");
        }

        user.rewardDebt = (user.amount * pool.accSharePerShare) / 1e18;
        emit Withdraw(sender, _pid, _amount);
    }

    function harvest(uint256 _pid) external payable nonReentrant {
        address sender = msg.sender;
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][sender];

        updatePool(_pid);
        _accruePendingRewards(_pid, sender, user, pool);

        uint256 rewardsToClaim = pendingRewards[_pid][sender];
        require(
            rewardsToClaim >= minClaimThreshold,
            "ShareRewardPool: claim below minimum"
        );

        uint256 requiredFee = quotePegStabilityModuleFee(rewardsToClaim);
        _validatePsmPayment(requiredFee);
        require(
            share.balanceOf(address(this)) >= rewardsToClaim,
            "ShareRewardPool: insufficient rewards"
        );

        pendingRewards[_pid][sender] = 0;
        share.safeTransfer(sender, rewardsToClaim);

        emit RewardPaid(sender, rewardsToClaim);
        _refundExcessPsmPayment(requiredFee);
    }

    function harvestAll() external payable nonReentrant {
        address sender = msg.sender;
        uint256 length = poolInfo.length;
        uint256 rewardsToClaim;

        for (uint256 pid = 0; pid < length; ++pid) {
            PoolInfo storage pool = poolInfo[pid];
            UserInfo storage user = userInfo[pid][sender];

            updatePool(pid);
            _accruePendingRewards(pid, sender, user, pool);

            uint256 poolRewards = pendingRewards[pid][sender];
            if (poolRewards > 0) {
                pendingRewards[pid][sender] = 0;
                rewardsToClaim += poolRewards;
            }
        }

        require(
            rewardsToClaim >= minClaimThreshold,
            "ShareRewardPool: claim below minimum"
        );

        uint256 requiredFee = quotePegStabilityModuleFee(rewardsToClaim);
        _validatePsmPayment(requiredFee);
        require(
            share.balanceOf(address(this)) >= rewardsToClaim,
            "ShareRewardPool: insufficient rewards"
        );

        share.safeTransfer(sender, rewardsToClaim);

        emit RewardPaid(sender, rewardsToClaim);
        _refundExcessPsmPayment(requiredFee);
    }

    function _validatePsmPayment(uint256 _requiredFee) internal view {
        if (pegStabilityModuleFeeEnabled) {
            require(msg.value >= _requiredFee, "ShareRewardPool: insufficient PSM fee");
        } else {
            require(msg.value == 0, "ShareRewardPool: invalid msg.value");
        }
    }

    // The harvest entry points remain guarded during the refund callback.
    function _refundExcessPsmPayment(uint256 _requiredFee) internal {
        uint256 refund = msg.value - _requiredFee;
        if (refund > 0) {
            (bool success, ) = payable(msg.sender).call{value: refund}("");
            require(success, "ShareRewardPool: PLS refund failed");
        }
    }

    function quotePegStabilityModuleFee(
        uint256 _rewardAmount
    ) public view returns (uint256) {
        if (
            !pegStabilityModuleFeeEnabled ||
            _rewardAmount == 0 ||
            pegStabilityModuleFee == 0
        ) {
            return 0;
        }

        uint256 unitPriceInNative = _validatedUnitPriceInNative();
        uint256 rewardValueInNative = Math.mulDiv(
            _rewardAmount,
            unitPriceInNative,
            1e18
        );
        return Math.mulDiv(rewardValueInNative, pegStabilityModuleFee, BPS);
    }

    function _validatedUnitPriceInNative() internal view returns (uint256) {
        uint256 updatedAt = uint256(shareOracle.blockTimestampLast());
        require(updatedAt <= block.timestamp, "ShareRewardPool: future oracle timestamp");
        require(
            block.timestamp - updatedAt <= maxOracleAge,
            "ShareRewardPool: stale oracle"
        );

        uint256 unitPriceInNative = shareOracle.consult(address(share), 1e18);
        require(unitPriceInNative > 0, "ShareRewardPool: invalid oracle price");
        return unitPriceInNative;
    }

    function _accruePendingRewards(
        uint256 _pid,
        address _account,
        UserInfo storage _user,
        PoolInfo storage _pool
    ) internal {
        if (_user.amount > 0) {
            uint256 newlyAccrued =
                (_user.amount * _pool.accSharePerShare) /
                1e18 -
                _user.rewardDebt;
            if (newlyAccrued > 0) {
                pendingRewards[_pid][_account] += newlyAccrued;
            }
        }

        _user.rewardDebt = (_user.amount * _pool.accSharePerShare) / 1e18;
    }

    function emergencyWithdraw(uint256 _pid) public nonReentrant {
        updatePool(_pid);
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        uint256 amount = user.amount;

        user.amount = 0;
        user.rewardDebt = 0;
        pendingRewards[_pid][msg.sender] = 0;
        pool.totalStaked -= amount;
        uint256 contractBefore = pool.token.balanceOf(address(this));

        pool.token.safeTransfer(msg.sender, amount);

        require(
            contractBefore - pool.token.balanceOf(address(this)) == amount,
            "unsupported token"
        );

        emit EmergencyWithdraw(msg.sender, _pid, amount);
    }

    function setOperator(address _operator) external onlyOperator {
        require(_operator != address(0), "ShareRewardPool: zero operator");
        operator = _operator;
    }

    function setShareOracle(IPairOracle _shareOracle) external onlyOperator {
        require(address(_shareOracle) != address(0), "ShareRewardPool: zero oracle");

        address token0 = _shareOracle.token0();
        address token1 = _shareOracle.token1();
        require(
            (token0 == address(share) && token1 == WPLS) ||
                (token1 == address(share) && token0 == WPLS),
            "ShareRewardPool: oracle must be SHARE/WPLS"
        );

        address oldOracle = address(shareOracle);
        shareOracle = _shareOracle;

        if (pegStabilityModuleFeeEnabled) {
            _validatedUnitPriceInNative();
        }

        emit ShareOracleChanged(oldOracle, address(_shareOracle));
    }

    function setPegStabilityModuleFee(
        uint256 _feeBps
    ) external onlyOperator {
        require(_feeBps <= MAX_PSM_FEE_BPS, "ShareRewardPool: PSM fee too high");
        uint256 oldFeeBps = pegStabilityModuleFee;
        pegStabilityModuleFee = _feeBps;

        if (pegStabilityModuleFeeEnabled && _feeBps > 0) {
            _validatedUnitPriceInNative();
        }

        emit PegStabilityModuleFeeChanged(oldFeeBps, _feeBps);
    }

    function setPegStabilityModuleFeeEnabled(
        bool _enabled
    ) external onlyOperator {
        if (_enabled) {
            require(address(shareOracle) != address(0), "ShareRewardPool: oracle not set");
            _validatedUnitPriceInNative();
        }
        pegStabilityModuleFeeEnabled = _enabled;
        emit PegStabilityModuleFeeEnabledChanged(_enabled);
    }

    function setPsmFeeRecipient(address payable _recipient) external onlyOperator {
        require(_recipient != address(0), "ShareRewardPool: zero fee recipient");
        address oldRecipient = psmFeeRecipient;
        psmFeeRecipient = _recipient;
        emit PsmFeeRecipientChanged(oldRecipient, _recipient);
    }

    function setMinClaimThreshold(uint256 _threshold) external onlyOperator {
        require(_threshold <= 1e18, "ShareRewardPool: threshold too high");
        uint256 oldThreshold = minClaimThreshold;
        minClaimThreshold = _threshold;
        emit MinClaimThresholdChanged(oldThreshold, _threshold);
    }

    function setMaxOracleAge(uint256 _maxOracleAge) external onlyOperator {
        require(
            _maxOracleAge >= 5 minutes && _maxOracleAge <= 7 days,
            "ShareRewardPool: invalid oracle age"
        );
        uint256 oldMaxAge = maxOracleAge;
        maxOracleAge = _maxOracleAge;

        if (pegStabilityModuleFeeEnabled && pegStabilityModuleFee > 0) {
            _validatedUnitPriceInNative();
        }

        emit MaxOracleAgeChanged(oldMaxAge, _maxOracleAge);
    }

    function collectPsmFees(uint256 _amount) external onlyOperator nonReentrant {
        require(_amount <= address(this).balance, "ShareRewardPool: insufficient PLS");
        (bool success, ) = psmFeeRecipient.call{value: _amount}("");
        require(success, "ShareRewardPool: PLS transfer failed");
        emit PsmFeesCollected(psmFeeRecipient, _amount);
    }

    function governanceRecoverUnsupported(
        IERC20 _token,
        uint256 amount,
        address to
    ) external onlyOperator {
        require(to != address(0), "ShareRewardPool: zero recipient");
        require(_token != share, "cant remove reward token");
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            require(_token != poolInfo[pid].token, "pool.token");
        }
        _token.safeTransfer(to, amount);
    }
}
