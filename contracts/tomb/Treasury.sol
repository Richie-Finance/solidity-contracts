// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

interface IBasisAsset {
    function mint(address recipient, uint256 amount) external returns (bool);

    function operator() external view returns (address);
}

interface IOracle {
    function update() external;

    function blockTimestampLast() external view returns (uint32);

    function consult(
        address token,
        uint256 amountIn
    ) external view returns (uint144 amountOut);

}

interface IBoardroom {
    function operator() external view returns (address);

    function balanceOf(address member) external view returns (uint256);

    function earned(address member) external view returns (uint256);

    function canWithdraw(address member) external view returns (bool);

    function canClaimReward(address member) external view returns (bool);

    function epoch() external view returns (uint256);

    function nextEpochPoint() external view returns (uint256);

    function getPegPrice() external view returns (uint256);

    function setOperator(address newOperator) external;

    function setLockUp(
        uint256 withdrawLockupEpochs,
        uint256 rewardLockupEpochs
    ) external;

    function stake(uint256 amount) external;

    function withdraw(uint256 amount) external;

    function exit() external;

    function claimReward() external;

    function allocateSeigniorage(uint256 amount) external;

    function governanceRecoverUnsupported(
        address token,
        uint256 amount,
        address to
    ) external;
}

contract Treasury is ContractGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PERIOD = 6 hours;

    // Governance.
    address public operator;

    // Flags.
    bool public initialized;

    // Epoch.
    uint256 public startTime;
    uint256 public epoch;

    // Exclusions from circulating supply.
    address[] public excludedFromTotalSupply = [
        address(0x6831f815963FfCe95521271b94164eb4C82e7621), //DAO Multisig
        address(0xb4ABb8B0F27D1fF26eA39725D996613Fa1b43073), //Genesis contract
        address(0x5AC71BAd7DCc7A94EFb4704b21A85B58FaCb5633) //Redemption contract
    ];

    // Core components.
    address public peg;
    address public share;
    address public boardroom;
    address public pegOracle;

    // Price and treasury accounting.
    uint256 public pegPriceOne;
    uint256 public pegPriceCeiling;

    uint256[] public supplyTiers;
    uint256[] public maxExpansionTiers;

    uint256 public bootstrapEpochs;
    uint256 public bootstrapSupplyExpansionPercent;

    uint256 public previousEpochPegPrice;

    address public daoFund;
    uint256 public daoFundSharedPercent;

    address public devFund;
    uint256 public devFundSharedPercent;

    // Reentrancy and initialization protection. The immutable value is stored
    // in bytecode rather than contract storage.
    bool private _entered;
    address private immutable _initializerAuthority;

    event Initialized(address indexed executor, uint256 at);
    event BoardroomFunded(uint256 timestamp, uint256 seigniorage);
    event DaoFundFunded(uint256 timestamp, uint256 seigniorage);
    event DevFundFunded(uint256 timestamp, uint256 seigniorage);

    constructor() {
        _initializerAuthority = msg.sender;
    }

    modifier onlyOperator() {
        require(operator == msg.sender, "Treasury: caller is not the operator");
        _;
    }

    modifier checkCondition() {
        require(block.timestamp >= startTime, "Treasury: not started yet");
        _;
    }

    modifier checkEpoch() {
        require(
            block.timestamp >= nextEpochPoint(),
            "Treasury: not opened yet"
        );

        _;

        epoch += 1;
    }

    modifier checkOperator() {
        require(
            IBasisAsset(peg).operator() == address(this) &&
                IBasisAsset(share).operator() == address(this) &&
                IBoardroom(boardroom).operator() == address(this),
            "Treasury: need more permission"
        );
        _;
    }

    modifier notInitialized() {
        require(!initialized, "Treasury: already initialized");
        _;
    }

    modifier nonReentrant() {
        require(!_entered, "Treasury: reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    function isInitialized() public view returns (bool) {
        return initialized;
    }

    function nextEpochPoint() public view returns (uint256) {
        return startTime + epoch * PERIOD;
    }

    function getPegPrice() public view returns (uint256 pegPrice) {
        try IOracle(pegOracle).consult(peg, 1e18) returns (uint144 price) {
            return uint256(price);
        } catch {
            revert("Treasury: failed to consult peg price from the oracle");
        }
    }

    function initialize(
        address _peg,
        address _share,
        address _pegOracle,
        address _boardroom,
        uint256 _startTime
    ) public notInitialized {
        require(
            msg.sender == _initializerAuthority,
            "Treasury: caller cannot initialize"
        );
        require(_peg != address(0), "Treasury: zero peg address");
        require(_share != address(0), "Treasury: zero share address");
        require(_pegOracle != address(0), "Treasury: zero oracle address");
        require(_boardroom != address(0), "Treasury: zero boardroom address");
        require(
            _peg != _share,
            "Treasury: core tokens must differ"
        );

        peg = _peg;
        share = _share;
        pegOracle = _pegOracle;
        boardroom = _boardroom;
        startTime = _startTime;

        pegPriceOne = 1e18;
        pegPriceCeiling = Math.mulDiv(pegPriceOne, 101, 100);

        supplyTiers.push(0 ether);
        supplyTiers.push(100_000_000 ether);
        supplyTiers.push(250_000_000 ether);
        supplyTiers.push(500_000_000 ether);

        maxExpansionTiers.push(200);
        maxExpansionTiers.push(100);
        maxExpansionTiers.push(50);
        maxExpansionTiers.push(25);

        bootstrapEpochs = 28;
        bootstrapSupplyExpansionPercent = 250;

        initialized = true;
        operator = msg.sender;
        emit Initialized(msg.sender, block.number);
    }

    function setOperator(address newOperator) external onlyOperator {
        require(newOperator != address(0), "Treasury: zero operator address");
        operator = newOperator;
    }

    function setPegOracle(address newOracle) external onlyOperator {
        require(newOracle != address(0), "Treasury: zero oracle address");
        pegOracle = newOracle;
    }

    function setPegPriceCeiling(
        uint256 newPriceCeiling
    ) external onlyOperator {
        require(
            newPriceCeiling >= pegPriceOne &&
                newPriceCeiling <= Math.mulDiv(pegPriceOne, 120, 100),
            "out of range"
        );
        pegPriceCeiling = newPriceCeiling;
    }

    function setSupplyTiersEntry(
        uint8 index,
        uint256 value
    ) external onlyOperator returns (bool) {
        require(index < supplyTiers.length, "Index exceeds tier count");
        if (index > 0) {
            require(value > supplyTiers[index - 1], "Tier too low");
        }
        if (index + 1 < supplyTiers.length) {
            require(value < supplyTiers[index + 1], "Tier too high");
        }
        supplyTiers[index] = value;
        return true;
    }

    function setMaxExpansionTiersEntry(
        uint8 index,
        uint256 value
    ) external onlyOperator returns (bool) {
        require(index < maxExpansionTiers.length, "Index exceeds tier count");
        require(value >= 10 && value <= 1_000, "_value: out of range");
        maxExpansionTiers[index] = value;
        return true;
    }

    function setBootstrap(
        uint256 newBootstrapEpochs,
        uint256 newBootstrapExpansionPercent
    ) external onlyOperator {
        require(block.timestamp < startTime, "Treasury already started");
        require(newBootstrapEpochs <= 120, "_bootstrapEpochs: out of range");
        require(
            newBootstrapExpansionPercent >= 100 &&
                newBootstrapExpansionPercent <= 1_000,
            "_bootstrapSupplyExpansionPercent: out of range"
        );
        bootstrapEpochs = newBootstrapEpochs;
        bootstrapSupplyExpansionPercent = newBootstrapExpansionPercent;
    }

    function setExtraFunds(
        address newDaoFund,
        uint256 newDaoFundSharedPercent,
        address newDevFund,
        uint256 newDevFundSharedPercent
    ) external onlyOperator {
        require(newDaoFund != address(0), "zero dao fund");
        require(newDaoFundSharedPercent <= 2_500, "dao percent out of range");
        require(newDevFund != address(0), "zero dev fund");
        require(newDevFundSharedPercent <= 500, "dev percent out of range");
        require(
            newDaoFundSharedPercent + newDevFundSharedPercent <= 10_000,
            "combined percent out of range"
        );

        daoFund = newDaoFund;
        daoFundSharedPercent = newDaoFundSharedPercent;
        devFund = newDevFund;
        devFundSharedPercent = newDevFundSharedPercent;
    }

    function _updatePegPrice() internal {
        try IOracle(pegOracle).update() {} catch {}
    }

    function getPegCirculatingSupply() public view returns (uint256) {
        IERC20 pegToken = IERC20(peg);
        uint256 totalSupply = pegToken.totalSupply();
        uint256 balanceExcluded;
        uint256 length = excludedFromTotalSupply.length;

        for (uint256 entryId; entryId < length; ++entryId) {
            balanceExcluded += pegToken.balanceOf(
                excludedFromTotalSupply[entryId]
            );
        }

        return totalSupply - balanceExcluded;
    }

    function _sendToBoardroom(uint256 amount) internal {
        require(
            IBasisAsset(peg).mint(address(this), amount),
            "Treasury: peg mint failed"
        );

        uint256 daoFundSharedAmount;
        if (daoFundSharedPercent > 0) {
            daoFundSharedAmount = Math.mulDiv(
                amount,
                daoFundSharedPercent,
                10_000
            );
            IERC20(peg).safeTransfer(daoFund, daoFundSharedAmount);
            emit DaoFundFunded(block.timestamp, daoFundSharedAmount);
        }

        uint256 devFundSharedAmount;
        if (devFundSharedPercent > 0) {
            devFundSharedAmount = Math.mulDiv(
                amount,
                devFundSharedPercent,
                10_000
            );
            IERC20(peg).safeTransfer(devFund, devFundSharedAmount);
            emit DevFundFunded(block.timestamp, devFundSharedAmount);
        }

        amount = amount - daoFundSharedAmount - devFundSharedAmount;

        IERC20(peg).forceApprove(boardroom, amount);
        IBoardroom(boardroom).allocateSeigniorage(amount);
        emit BoardroomFunded(block.timestamp, amount);
    }

    function _getMaxSupplyExpansionPercent(
        uint256 pegSupply
    ) internal view returns (uint256) {
        uint256 tierId = supplyTiers.length;
        while (tierId > 0) {
            unchecked {
                --tierId;
            }
            if (pegSupply >= supplyTiers[tierId]) {
                return maxExpansionTiers[tierId];
            }
        }
        revert("Treasury: no expansion tier");
    }

    function allocateSeigniorage()
        external
        nonReentrant
        onlyOneBlock
        checkCondition
        checkEpoch
        checkOperator
    {
        _updatePegPrice();
        uint256 oracleUpdated = IOracle(pegOracle).blockTimestampLast();
        require(
            oracleUpdated != 0 &&
                oracleUpdated <= block.timestamp &&
                block.timestamp - oracleUpdated <= PERIOD,
            "Treasury: stale oracle"
        );
        uint256 pegPrice = getPegPrice();
        require(pegPrice > 0, "Treasury: invalid oracle price");

        previousEpochPegPrice = pegPrice;
        uint256 pegSupply = getPegCirculatingSupply();

        if (epoch < bootstrapEpochs) {
            _sendToBoardroom(
                Math.mulDiv(
                    pegSupply,
                    bootstrapSupplyExpansionPercent,
                    10_000
                )
            );
        } else if (previousEpochPegPrice > pegPriceCeiling) {
            uint256 percentage = previousEpochPegPrice - pegPriceOne;
            uint256 maxExpansion =
                _getMaxSupplyExpansionPercent(pegSupply) * 1e14;

            if (percentage > maxExpansion) {
                percentage = maxExpansion;
            }

            uint256 boardroomAmount = Math.mulDiv(
                pegSupply,
                percentage,
                1e18
            );

            if (boardroomAmount > 0) {
                _sendToBoardroom(boardroomAmount);
            }
        }
    }

    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyOperator nonReentrant {
        require(address(token) != peg, "peg");
        require(address(token) != share, "share");
        require(to != address(0), "Treasury: zero recipient address");
        token.safeTransfer(to, amount);
    }

    function boardroomSetOperator(
        address newOperator
    ) external onlyOperator nonReentrant {
        IBoardroom(boardroom).setOperator(newOperator);
    }

    function boardroomSetLockUp(
        uint256 withdrawLockupEpochs,
        uint256 rewardLockupEpochs
    ) external onlyOperator nonReentrant {
        IBoardroom(boardroom).setLockUp(
            withdrawLockupEpochs,
            rewardLockupEpochs
        );
    }

    function boardroomAllocateSeigniorage(
        uint256 amount
    ) external onlyOperator nonReentrant {
        IERC20(peg).forceApprove(boardroom, amount);
        IBoardroom(boardroom).allocateSeigniorage(amount);
    }

    function boardroomGovernanceRecoverUnsupported(
        address token,
        uint256 amount,
        address to
    ) external onlyOperator nonReentrant {
        IBoardroom(boardroom).governanceRecoverUnsupported(token, amount, to);
    }
}
