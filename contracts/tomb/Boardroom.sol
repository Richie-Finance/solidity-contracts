// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ContractGuard {
    mapping(uint256 => mapping(address => bool)) private _status;

    function checkSameOriginReentranted() internal view returns (bool) {
        return _status[block.number][tx.origin];
    }

    function checkSameSenderReentranted() internal view returns (bool) {
        return _status[block.number][msg.sender];
    }

    modifier onlyOneBlock() {
        require(
            !checkSameOriginReentranted(),
            "ContractGuard: one block, one function"
        );
        require(
            !checkSameSenderReentranted(),
            "ContractGuard: one block, one function"
        );

        _;

        _status[block.number][tx.origin] = true;
        _status[block.number][msg.sender] = true;
    }
}

interface ITreasury {
    function epoch() external view returns (uint256);

    function nextEpochPoint() external view returns (uint256);

    function getPegPrice() external view returns (uint256);
}

abstract contract ShareWrapper {
    using SafeERC20 for IERC20;

    IERC20 public share;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function stake(uint256 amount) public virtual {
        uint256 balanceBefore = share.balanceOf(address(this));
        share.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = share.balanceOf(address(this)) - balanceBefore;

        require(received == amount, "Boardroom: unsupported share token");

        _totalSupply += amount;
        _balances[msg.sender] += amount;
    }

    function withdraw(uint256 amount) public virtual {
        uint256 memberShare = _balances[msg.sender];
        require(
            memberShare >= amount,
            "Boardroom: withdraw request greater than staked amount"
        );

        _totalSupply -= amount;
        _balances[msg.sender] = memberShare - amount;

        uint256 balanceBefore = share.balanceOf(address(this));
        uint256 memberBalanceBefore = share.balanceOf(msg.sender);
        share.safeTransfer(msg.sender, amount);
        uint256 spent = balanceBefore - share.balanceOf(address(this));
        uint256 received = share.balanceOf(msg.sender) - memberBalanceBefore;

        require(
            spent == amount && received == amount,
            "Boardroom: unsupported share token"
        );
    }
}

contract Boardroom is ShareWrapper, ContractGuard {
    using SafeERC20 for IERC20;

    struct Memberseat {
        uint256 lastSnapshotIndex;
        uint256 rewardEarned;
        uint256 epochTimerStart;
    }

    struct BoardroomSnapshot {
        uint256 time;
        uint256 rewardReceived;
        uint256 rewardPerShare;
    }

    address public operator;
    bool public initialized;

    IERC20 public peg;
    ITreasury public treasury;

    mapping(address => Memberseat) public members;
    BoardroomSnapshot[] public boardroomHistory;

    uint256 public withdrawLockupEpochs;
    uint256 public rewardLockupEpochs;

    // Appended after the legacy state so existing storage positions are not
    // shifted. Immutables are kept in bytecode and consume no storage slot.
    bool private _entered;
    address private immutable _initializerAuthority;

    event Initialized(address indexed executor, uint256 at);
    event OperatorTransferred(
        address indexed previousOperator,
        address indexed newOperator
    );
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(address indexed user, uint256 reward);

    modifier onlyOperator() {
        require(operator == msg.sender, "Boardroom: caller is not the operator");
        _;
    }

    modifier memberExists() {
        require(
            balanceOf(msg.sender) > 0,
            "Boardroom: the member does not exist"
        );
        _;
    }

    modifier updateReward(address member) {
        if (member != address(0)) {
            Memberseat memory seat = members[member];
            seat.rewardEarned = earned(member);
            seat.lastSnapshotIndex = latestSnapshotIndex();
            members[member] = seat;
        }
        _;
    }

    modifier notInitialized() {
        require(!initialized, "Boardroom: already initialized");
        _;
    }

    modifier nonReentrant() {
        require(!_entered, "Boardroom: reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    // Keeps the existing no-argument deployment and initialize(...) flow while
    // preventing another account from front-running initialization.
    constructor() {
        _initializerAuthority = msg.sender;
    }

    function initialize(
        IERC20 _peg,
        IERC20 _share,
        ITreasury _treasury
    ) public notInitialized {
        require(
            msg.sender == _initializerAuthority,
            "Boardroom: caller cannot initialize"
        );
        require(address(_peg) != address(0), "Boardroom: zero peg address");
        require(address(_share) != address(0), "Boardroom: zero share address");
        require(
            address(_treasury) != address(0),
            "Boardroom: zero treasury address"
        );
        require(
            address(_peg) != address(_share),
            "Boardroom: peg and share must differ"
        );

        peg = _peg;
        share = _share;
        treasury = _treasury;

        BoardroomSnapshot memory genesisSnapshot = BoardroomSnapshot({
            time: block.number,
            rewardReceived: 0,
            rewardPerShare: 0
        });
        boardroomHistory.push(genesisSnapshot);

        withdrawLockupEpochs = 4;
        rewardLockupEpochs = 2;
        initialized = true;
        operator = msg.sender;

        emit OperatorTransferred(address(0), msg.sender);
        emit Initialized(msg.sender, block.number);
    }

    function setOperator(address _operator) external onlyOperator {
        require(_operator != address(0), "Boardroom: zero operator address");
        emit OperatorTransferred(operator, _operator);
        operator = _operator;
    }

    function setLockUp(
        uint256 _withdrawLockupEpochs,
        uint256 _rewardLockupEpochs
    ) external onlyOperator {
        require(
            _withdrawLockupEpochs >= _rewardLockupEpochs,
            "Boardroom: withdraw lockup must be at least reward lockup"
        );
        require(
            _withdrawLockupEpochs <= 12,
            "Boardroom: withdraw lockup must not exceed 56 epochs"
        );
        require(
            _rewardLockupEpochs <= 12,
            "Boardroom: reward lockup must not exceed 56 epochs"
        );

        withdrawLockupEpochs = _withdrawLockupEpochs;
        rewardLockupEpochs = _rewardLockupEpochs;
    }

    function latestSnapshotIndex() public view returns (uint256) {
        return boardroomHistory.length - 1;
    }

    function getLatestSnapshot()
        internal
        view
        returns (BoardroomSnapshot memory)
    {
        return boardroomHistory[latestSnapshotIndex()];
    }

    function getLastSnapshotIndexOf(address member)
        public
        view
        returns (uint256)
    {
        return members[member].lastSnapshotIndex;
    }

    function getLastSnapshotOf(address member)
        internal
        view
        returns (BoardroomSnapshot memory)
    {
        return boardroomHistory[getLastSnapshotIndexOf(member)];
    }

    function canWithdraw(address member) external view returns (bool) {
        return
            members[member].epochTimerStart + withdrawLockupEpochs <=
            treasury.epoch();
    }

    function canClaimReward(address member) external view returns (bool) {
        return
            members[member].epochTimerStart + rewardLockupEpochs <=
            treasury.epoch();
    }

    function epoch() external view returns (uint256) {
        return treasury.epoch();
    }

    function nextEpochPoint() external view returns (uint256) {
        return treasury.nextEpochPoint();
    }

    function getPegPrice() external view returns (uint256) {
        return treasury.getPegPrice();
    }

    function rewardPerShare() public view returns (uint256) {
        return getLatestSnapshot().rewardPerShare;
    }

    function earned(address member) public view returns (uint256) {
        uint256 latestRewardPerShare = rewardPerShare();
        uint256 storedRewardPerShare = getLastSnapshotOf(member).rewardPerShare;

        return
            (balanceOf(member) *
                (latestRewardPerShare - storedRewardPerShare)) /
            1e18 +
            members[member].rewardEarned;
    }

    function stake(uint256 amount)
        public
        override
        nonReentrant
        onlyOneBlock
        updateReward(msg.sender)
    {
        require(amount > 0, "Boardroom: cannot stake 0");

        super.stake(amount);
        members[msg.sender].epochTimerStart = treasury.epoch();

        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount)
        public
        override
        nonReentrant
        onlyOneBlock
        memberExists
        updateReward(msg.sender)
    {
        require(amount > 0, "Boardroom: cannot withdraw 0");
        require(
            members[msg.sender].epochTimerStart + withdrawLockupEpochs <=
                treasury.epoch(),
            "Boardroom: still in withdraw lockup"
        );

        _claimReward();
        super.withdraw(amount);

        emit Withdrawn(msg.sender, amount);
    }

    function exit() external {
        withdraw(balanceOf(msg.sender));
    }

    function claimReward()
        public
        nonReentrant
        updateReward(msg.sender)
    {
        _claimReward();
    }

    function _claimReward() internal {
        uint256 reward = members[msg.sender].rewardEarned;
        if (reward > 0) {
            require(
                members[msg.sender].epochTimerStart + rewardLockupEpochs <=
                    treasury.epoch(),
                "Boardroom: still in reward lockup"
            );

            members[msg.sender].epochTimerStart = treasury.epoch();
            members[msg.sender].rewardEarned = 0;

            uint256 balanceBefore = peg.balanceOf(address(this));
            uint256 memberBalanceBefore = peg.balanceOf(msg.sender);
            peg.safeTransfer(msg.sender, reward);
            uint256 spent = balanceBefore - peg.balanceOf(address(this));
            uint256 received = peg.balanceOf(msg.sender) - memberBalanceBefore;

            require(
                spent == reward && received == reward,
                "Boardroom: unsupported peg token"
            );

            emit RewardPaid(msg.sender, reward);
        }
    }

    function allocateSeigniorage(uint256 amount)
        external
        nonReentrant
        onlyOneBlock
        onlyOperator
    {
        require(amount > 0, "Boardroom: cannot allocate 0");
        require(totalSupply() > 0, "Boardroom: cannot allocate when empty");

        uint256 balanceBefore = peg.balanceOf(address(this));
        peg.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = peg.balanceOf(address(this)) - balanceBefore;

        require(received == amount, "Boardroom: unsupported peg token");

        uint256 prevRewardPerShare = rewardPerShare();
        uint256 nextRewardPerShare = prevRewardPerShare +
            (amount * 1e18) /
            totalSupply();

        BoardroomSnapshot memory newSnapshot = BoardroomSnapshot({
            time: block.number,
            rewardReceived: amount,
            rewardPerShare: nextRewardPerShare
        });
        boardroomHistory.push(newSnapshot);

        emit RewardAdded(msg.sender, amount);
    }

    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyOperator nonReentrant {
        require(address(token) != address(peg), "Boardroom: peg");
        require(address(token) != address(share), "Boardroom: share");
        require(to != address(0), "Boardroom: zero recipient address");

        token.safeTransfer(to, amount);
    }
}
