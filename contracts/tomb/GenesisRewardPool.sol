// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GenesisRewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DEPOSIT_FEE_BPS = 1_00; // Max 1% deposit fee
    uint256 public constant MAX_ALLOC_POINT = 1_000_000;

    // Governance.
    address public operator;

    struct UserInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    struct PoolInfo {
        IERC20 token;
        uint256 allocPoint;
        uint256 lastRewardTime;
        uint256 accPegPerShare;
        uint16 depositFeeBps;
        uint256 totalStaked;
    }

    IERC20 public peg;
    address public feeRecipient;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    uint256 public totalAllocPoint;
    uint256 public poolStartTime;
    uint256 public poolEndTime;

    uint256 public pegPerSecond = 155 ether;
    uint256 public runningTime = 3 days;
    uint256 public constant TOTAL_REWARDS = 40176000 ether;

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event DepositFee(address indexed user, uint256 indexed pid, uint256 amount);
    event DepositFeeChanged(
        uint256 indexed pid,
        uint16 oldFeeBps,
        uint16 newFeeBps
    );
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);

    constructor(address _peg, uint256 _poolStartTime) {
        require(block.timestamp < _poolStartTime, "late");
        require(_peg != address(0), "Zero PEG");
        peg = IERC20(_peg);

        poolStartTime = _poolStartTime;
        poolEndTime = poolStartTime + runningTime;
        operator = msg.sender;
        feeRecipient = msg.sender;
    }

    modifier onlyOperator() {
        require(operator == msg.sender, "GenesisPool: caller is not the operator");
        _;
    }

    function checkPoolDuplicate(IERC20 _token) internal view {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            require(poolInfo[pid].token != _token, "GenesisPool: existing pool?");
        }
    }

    function add(
        uint256 _allocPoint,
        IERC20 _token,
        uint16 _depositFeeBps
    ) external onlyOperator {
        require(address(_token) != address(0), "GenesisPool: zero pool token");
        require(_depositFeeBps <= MAX_DEPOSIT_FEE_BPS, "deposit fee too high");
        require(_token != peg, "GenesisPool: PEG cannot be a pool token");
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
                accPegPerShare: 0,
                depositFeeBps: _depositFeeBps,
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

    function setDepositFee(uint256 _pid, uint16 _depositFeeBps) external onlyOperator {
        require(_depositFeeBps <= MAX_DEPOSIT_FEE_BPS, "deposit fee too high");

        PoolInfo storage pool = poolInfo[_pid];
        uint16 oldFeeBps = pool.depositFeeBps;
        pool.depositFeeBps = _depositFeeBps;

        emit DepositFeeChanged(_pid, oldFeeBps, _depositFeeBps);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOperator {
        require(_feeRecipient != address(0), "zero fee recipient");

        address oldRecipient = feeRecipient;
        feeRecipient = _feeRecipient;

        emit FeeRecipientChanged(oldRecipient, _feeRecipient);
    }

    function getGeneratedReward(
        uint256 _fromTime,
        uint256 _toTime
    ) public view returns (uint256) {
        if (_fromTime >= _toTime) return 0;

        if (_toTime >= poolEndTime) {
            if (_fromTime >= poolEndTime) return 0;
            if (_fromTime <= poolStartTime) {
                return (poolEndTime - poolStartTime) * pegPerSecond;
            }
            return (poolEndTime - _fromTime) * pegPerSecond;
        }

        if (_toTime <= poolStartTime) return 0;
        if (_fromTime <= poolStartTime) {
            return (_toTime - poolStartTime) * pegPerSecond;
        }
        return (_toTime - _fromTime) * pegPerSecond;
    }

    function pendingRewards(uint256 _pid, address _user) external view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        uint256 accPegPerShare = pool.accPegPerShare;
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
            uint256 pegReward = (generatedReward * pool.allocPoint) / totalAllocPoint;
            accPegPerShare += (pegReward * 1e18) / tokenSupply;
        }

        return (user.amount * accPegPerShare) / 1e18 - user.rewardDebt;
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
        uint256 pegReward = (generatedReward * pool.allocPoint) / totalAllocPoint;
        pool.accPegPerShare += (pegReward * 1e18) / tokenSupply;

        pool.lastRewardTime = block.timestamp;
    }

    function deposit(uint256 _pid, uint256 _amount) public nonReentrant {
        address sender = msg.sender;
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][sender];

        updatePool(_pid);

        if (user.amount > 0) {
            uint256 pending =
                (user.amount * pool.accPegPerShare) / 1e18 - user.rewardDebt;
            if (pending > 0) {
                require(peg.balanceOf(address(this)) >= pending, "GenesisPool: insufficient CASH rewards");
                safePegTransfer(sender, pending);
                emit RewardPaid(sender, pending);
            }
        }

        if (_amount > 0) {
            uint256 balanceBefore = pool.token.balanceOf(address(this));
            pool.token.safeTransferFrom(sender, address(this), _amount);

            uint256 received = pool.token.balanceOf(address(this)) - balanceBefore;
            uint256 fee = (received * pool.depositFeeBps) / BPS;
            uint256 credited = received - fee;

            if (fee > 0) {
                uint256 feeBalanceBefore = pool.token.balanceOf(address(this));
                pool.token.safeTransfer(feeRecipient, fee);
                require(feeBalanceBefore - pool.token.balanceOf(address(this)) == fee, "GenesisPool: unsupported token");
                emit DepositFee(sender, _pid, fee);
            }

            user.amount += credited;
            pool.totalStaked += credited;
        }

        user.rewardDebt = (user.amount * pool.accPegPerShare) / 1e18;
        emit Deposit(sender, _pid, _amount);
    }

    function withdraw(uint256 _pid, uint256 _amount) public nonReentrant {
        address sender = msg.sender;
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][sender];

        require(user.amount >= _amount, "withdraw: not good");
        updatePool(_pid);

        uint256 pending =
            (user.amount * pool.accPegPerShare) / 1e18 - user.rewardDebt;
        if (pending > 0) {
            require(peg.balanceOf(address(this)) >= pending, "GenesisPool: insufficient CASH rewards");
            safePegTransfer(sender, pending);
            emit RewardPaid(sender, pending);
        }

        if (_amount > 0) {
            user.amount -= _amount;
            pool.totalStaked -= _amount;
            uint256 beforeBalance = pool.token.balanceOf(address(this));
            uint256 recipientBefore = pool.token.balanceOf(sender);
            pool.token.safeTransfer(sender, _amount);
            require(beforeBalance - pool.token.balanceOf(address(this)) == _amount, "GenesisPool: unsupported token");
            require(pool.token.balanceOf(sender) - recipientBefore == _amount, "GenesisPool: unsupported token");
        }

        user.rewardDebt = (user.amount * pool.accPegPerShare) / 1e18;
        emit Withdraw(sender, _pid, _amount);
    }

    function emergencyWithdraw(uint256 _pid) public nonReentrant {
        updatePool(_pid);
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        uint256 amount = user.amount;

        user.amount = 0;
        user.rewardDebt = 0;
        pool.totalStaked -= amount;
        uint256 contractBefore = pool.token.balanceOf(address(this));
        uint256 recipientBefore = pool.token.balanceOf(msg.sender);

        pool.token.safeTransfer(msg.sender, amount);

        require(
            contractBefore - pool.token.balanceOf(address(this)) == amount,
            "unsupported token"
        );
        require(
            pool.token.balanceOf(msg.sender) - recipientBefore == amount,
            "unsupported token"
        );

        emit EmergencyWithdraw(msg.sender, _pid, amount);
    }

    function safePegTransfer(address _to, uint256 _amount) internal {
        uint256 pegBalance = peg.balanceOf(address(this));
        require(pegBalance >= _amount, "GenesisPool: insufficient CASH rewards");
        peg.safeTransfer(_to, _amount);
    }

    function setOperator(address _operator) external onlyOperator {
        operator = _operator;
    }

    function governanceRecoverUnsupported(
        IERC20 _token,
        uint256 amount,
        address to
    ) external onlyOperator {
        require(_token != peg, "cannot withdraw peg");
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; ++pid) {
            require(_token != poolInfo[pid].token, "pool.token");
        }
        _token.safeTransfer(to, amount);
    }
}
