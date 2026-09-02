// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {OutcomeToken} from "./OutcomeToken.sol";
import {IKuruRouter} from "./interfaces/IKuruRouter.sol";

/// @title PitFactory
/// @notice Issues one YES/NO pair per short-horizon window, lists both legs as spot
///         markets on Kuru's onchain CLOB, and redeems the winning leg 1:1 after
///         settlement.
///
/// @dev The economics are deliberately boring, because a trader has to be able to
///      check them in thirty seconds:
///
///        * mintSet(id, n) locks n collateral and returns n YES + n NO.
///        * YES and NO each trade against collateral on their own Kuru book.
///        * After settle, the winning leg redeems 1:1; the loser is worth zero.
///        * Therefore the YES best ask is an upper bound on the market's implied
///          probability, and one minus the NO best bid is another. Both are read
///          straight off the book.
///
///      The factory holds exactly window.collateral for every window and never
///      touches it, so it can never be short. Trading happens entirely on Kuru;
///      this contract is issuance and settlement only.
contract PitFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    enum Outcome {
        Unresolved,
        Yes,
        No,
        Void
    }

    /// @notice Kuru listing parameters applied to every market this factory creates.
    /// @dev Outcome legs always trade in [0, 1] collateral, so one parameter set fits
    ///      every window. See docs/LIQUIDITY.md for how these numbers were picked.
    struct MarketConfig {
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint96 kuruAmmSpread;
    }

    struct Window {
        bytes32 underlying; // keccak256("BTC-USD")
        uint64 startTs; // trading opens
        uint64 endTs; // window closes; settlement reads the price at this instant
        uint256 strikeE8; // settles YES when price at endTs > strikeE8, 8 decimals
        address yes;
        address no;
        address yesMarket; // Kuru orderbook, YES/collateral
        address noMarket; // Kuru orderbook, NO/collateral
        uint256 collateral; // collateral locked by outstanding sets
        Outcome outcome;
        uint256 settlePriceE8;
        uint64 settledAt;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Collateral and quote asset for every market (e.g. USDC, 6 decimals).
    IERC20 public immutable collateralToken;

    /// @notice Decimals of collateralToken, mirrored onto both outcome legs so a set
    ///         is exactly one collateral unit with no scaling anywhere.
    uint8 public immutable collateralDecimals;

    /// @notice Kuru Router, used as the market factory.
    IKuruRouter public immutable kuruRouter;

    /// @notice Address allowed to call settle: the Chainlink CRE workflow's onchain
    ///         sender (a Forwarder in production).
    address public settler;

    /// @notice Address allowed to open new windows.
    address public operator;

    /// @notice Grace period after endTs before anyone may void a stuck window and let
    ///         both legs redeem at 0.5. This is the escape hatch that stops the
    ///         settler from being able to freeze collateral.
    uint64 public settleGrace = 1 hours;

    MarketConfig public marketConfig;

    Window[] private _windows;

    /// @notice keccak256(underlying, endTs, strikeE8) => windowId + 1 (0 means absent).
    mapping(bytes32 => uint256) private _windowIdByKey;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event WindowCreated(
        uint256 indexed windowId,
        bytes32 indexed underlying,
        uint64 startTs,
        uint64 endTs,
        uint256 strikeE8,
        address yes,
        address no,
        address yesMarket,
        address noMarket
    );
    event SetMinted(uint256 indexed windowId, address indexed account, uint256 amount);
    event SetBurned(uint256 indexed windowId, address indexed account, uint256 amount);
    event WindowSettled(uint256 indexed windowId, Outcome outcome, uint256 settlePriceE8, uint64 settledAt);
    event WindowVoided(uint256 indexed windowId, uint64 voidedAt);
    event Redeemed(uint256 indexed windowId, address indexed account, uint256 burned, uint256 payout);
    event SettlerUpdated(address indexed previous, address indexed next);
    event OperatorUpdated(address indexed previous, address indexed next);
    event MarketConfigUpdated(MarketConfig config);
    event SettleGraceUpdated(uint64 previous, uint64 next);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotSettler();
    error NotOperator();
    error UnknownWindow();
    error WindowExists();
    error BadWindowTimes();
    error WindowNotClosed();
    error AlreadyResolved();
    error NotResolved();
    error NothingToRedeem();
    error ZeroAmount();
    error GraceNotElapsed();
    error BadPrice();
    error ZeroAddress();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    constructor(address owner_, address collateral_, address kuruRouter_, address settler_, address operator_)
        Ownable(owner_)
    {
        if (collateral_ == address(0) || kuruRouter_ == address(0)) revert ZeroAddress();
        collateralToken = IERC20(collateral_);
        collateralDecimals = IERC20Metadata(collateral_).decimals();
        kuruRouter = IKuruRouter(kuruRouter_);
        settler = settler_;
        operator = operator_;

        // Outcome legs live in [0, 1] collateral. With pricePrecision 1e6 a tick of
        // 1000 is 0.001 collateral (10 bps of probability) and the widest possible
        // price, 1.0, is 1e6 -- comfortably inside uint32.
        marketConfig = MarketConfig({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: 1e3,
            minSize: 1e6, // one contract == $1 of max payout
            maxSize: 1e14,
            takerFeeBps: 0,
            makerFeeBps: 0,
            kuruAmmSpread: 500 // widest allowed; Pit never funds the Kuru AMM vault
        });

        emit SettlerUpdated(address(0), settler_);
        emit OperatorUpdated(address(0), operator_);
        emit MarketConfigUpdated(marketConfig);
    }

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setSettler(address next) external onlyOwner {
        emit SettlerUpdated(settler, next);
        settler = next;
    }

    function setOperator(address next) external onlyOwner {
        emit OperatorUpdated(operator, next);
        operator = next;
    }

    function setMarketConfig(MarketConfig calldata config) external onlyOwner {
        marketConfig = config;
        emit MarketConfigUpdated(config);
    }

    function setSettleGrace(uint64 next) external onlyOwner {
        emit SettleGraceUpdated(settleGrace, next);
        settleGrace = next;
    }

    // -----------------------------------------------------------------------
    // Issuance
    // -----------------------------------------------------------------------

    /// @notice Open a window and list both legs on Kuru.
    /// @param underlying keccak256 of the pair label, e.g. keccak256("BTC-USD").
    /// @param startTs    When the cell starts accepting flow (informational; the book
    ///                   is live as soon as it exists).
    /// @param endTs      Settlement timestamp. The CRE workflow reads the reference
    ///                   price at this instant.
    /// @param strikeE8   Settles YES when price(endTs) > strikeE8. For the 5m up/down
    ///                   cell the roller passes spot at creation time, which makes
    ///                   up/down exactly the at-the-money row of the same ladder.
    function createWindow(bytes32 underlying, uint64 startTs, uint64 endTs, uint256 strikeE8)
        external
        onlyOperator
        returns (uint256 windowId)
    {
        if (endTs <= startTs) revert BadWindowTimes();
        if (strikeE8 == 0) revert BadPrice();

        bytes32 key = windowKey(underlying, endTs, strikeE8);
        if (_windowIdByKey[key] != 0) revert WindowExists();

        windowId = _windows.length;

        string memory tag = _decimalString(windowId);
        OutcomeToken yes = new OutcomeToken(
            string.concat("Pit YES #", tag), string.concat("cYES", tag), collateralDecimals, windowId
        );
        OutcomeToken no = new OutcomeToken(
            string.concat("Pit NO #", tag), string.concat("cNO", tag), collateralDecimals, windowId
        );

        address yesMarket = _listOnKuru(address(yes));
        address noMarket = _listOnKuru(address(no));

        _windows.push(
            Window({
                underlying: underlying,
                startTs: startTs,
                endTs: endTs,
                strikeE8: strikeE8,
                yes: address(yes),
                no: address(no),
                yesMarket: yesMarket,
                noMarket: noMarket,
                collateral: 0,
                outcome: Outcome.Unresolved,
                settlePriceE8: 0,
                settledAt: 0
            })
        );
        _windowIdByKey[key] = windowId + 1;

        emit WindowCreated(
            windowId, underlying, startTs, endTs, strikeE8, address(yes), address(no), yesMarket, noMarket
        );
    }

    /// @notice Lock amount collateral, receive amount YES and amount NO.
    /// @dev This is how anyone -- including us, seeding the first bid and ask --
    ///      obtains inventory. There is no privileged mint.
    function mintSet(uint256 windowId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Window storage w = _requireWindow(windowId);
        if (w.outcome != Outcome.Unresolved) revert AlreadyResolved();

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        w.collateral += amount;

        OutcomeToken(w.yes).mint(msg.sender, amount);
        OutcomeToken(w.no).mint(msg.sender, amount);

        emit SetMinted(windowId, msg.sender, amount);
    }

    /// @notice Burn amount YES and amount NO, receive amount collateral back.
    ///         Available while the window is unresolved: this is how a maker pulls
    ///         inventory back out after quoting both sides.
    function burnSet(uint256 windowId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Window storage w = _requireWindow(windowId);
        if (w.outcome != Outcome.Unresolved) revert AlreadyResolved();

        OutcomeToken(w.yes).burn(msg.sender, amount);
        OutcomeToken(w.no).burn(msg.sender, amount);

        w.collateral -= amount;
        collateralToken.safeTransfer(msg.sender, amount);

        emit SetBurned(windowId, msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Settlement
    // -----------------------------------------------------------------------

    /// @notice Record the outcome of a closed window. Called by the Chainlink CRE
    ///         workflow, which reads the reference price off-chain and the window
    ///         clock on-chain.
    function settle(uint256 windowId, uint256 settlePriceE8) external onlySettler {
        Window storage w = _requireWindow(windowId);
        if (w.outcome != Outcome.Unresolved) revert AlreadyResolved();
        if (block.timestamp < w.endTs) revert WindowNotClosed();
        if (settlePriceE8 == 0) revert BadPrice();

        Outcome outcome = settlePriceE8 > w.strikeE8 ? Outcome.Yes : Outcome.No;
        w.outcome = outcome;
        w.settlePriceE8 = settlePriceE8;
        w.settledAt = uint64(block.timestamp);

        emit WindowSettled(windowId, outcome, settlePriceE8, w.settledAt);
    }

    /// @notice Escape hatch: if the settler has not resolved a window settleGrace
    ///         after it closed, anyone may void it. Both legs then redeem at 0.5, so
    ///         a silent oracle cannot trap collateral.
    function voidWindow(uint256 windowId) external {
        Window storage w = _requireWindow(windowId);
        if (w.outcome != Outcome.Unresolved) revert AlreadyResolved();
        if (block.timestamp < uint256(w.endTs) + settleGrace) revert GraceNotElapsed();

        w.outcome = Outcome.Void;
        w.settledAt = uint64(block.timestamp);
        emit WindowVoided(windowId, w.settledAt);
    }

    /// @notice Burn the caller's whole position in a resolved window and take the payout.
    /// @dev Settled: winner pays 1, loser pays 0. Void: each leg pays 0.5.
    function redeem(uint256 windowId) external nonReentrant returns (uint256 payout) {
        Window storage w = _requireWindow(windowId);
        if (w.outcome == Outcome.Unresolved) revert NotResolved();

        uint256 yesBal = IERC20(w.yes).balanceOf(msg.sender);
        uint256 noBal = IERC20(w.no).balanceOf(msg.sender);
        uint256 burned = yesBal + noBal;
        if (burned == 0) revert NothingToRedeem();

        if (w.outcome == Outcome.Yes) {
            payout = yesBal;
        } else if (w.outcome == Outcome.No) {
            payout = noBal;
        } else {
            payout = burned / 2;
        }

        if (yesBal != 0) OutcomeToken(w.yes).burn(msg.sender, yesBal);
        if (noBal != 0) OutcomeToken(w.no).burn(msg.sender, noBal);

        if (payout != 0) {
            w.collateral -= payout;
            collateralToken.safeTransfer(msg.sender, payout);
        }

        emit Redeemed(windowId, msg.sender, burned, payout);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function windowCount() external view returns (uint256) {
        return _windows.length;
    }

    function getWindow(uint256 windowId) external view returns (Window memory) {
        if (windowId >= _windows.length) revert UnknownWindow();
        return _windows[windowId];
    }

    /// @notice Page through windows, oldest first. Cheap enough for a UI cold start
    ///         before the indexer is warm.
    function getWindows(uint256 offset, uint256 limit) external view returns (Window[] memory page) {
        uint256 total = _windows.length;
        if (offset >= total) return new Window[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new Window[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _windows[i];
        }
    }

    /// @notice Windows that have closed and are still unresolved.
    /// @dev This exists for the Chainlink CRE workflow. Reading every window every
    ///      30 seconds to find the two or three that just closed is wasteful, and
    ///      paging through them off-chain would make the workflow stateful. Scanning
    ///      backwards is right because windows are created in `endTs` order, so the
    ///      ones that just closed are always near the end of the array.
    /// @param lookback   How many of the most recent windows to scan.
    /// @param maxResults Cap on the returned batch, which is also the cap on how many
    ///                   settlements one CRE report can carry.
    function pendingSettlement(uint256 lookback, uint256 maxResults) external view returns (uint256[] memory ids) {
        uint256 total = _windows.length;
        uint256 scan = lookback < total ? lookback : total;
        ids = new uint256[](maxResults);

        uint256 found;
        for (uint256 i; i < scan && found < maxResults; ++i) {
            uint256 windowId = total - 1 - i;
            Window storage w = _windows[windowId];
            if (w.outcome != Outcome.Unresolved) continue;
            if (w.endTs > block.timestamp) continue;
            ids[found++] = windowId;
        }

        assembly {
            mstore(ids, found)
        }
    }

    function windowKey(bytes32 underlying, uint64 endTs, uint256 strikeE8) public pure returns (bytes32) {
        return keccak256(abi.encode(underlying, endTs, strikeE8));
    }

    /// @return exists Whether a window with these coordinates has been opened.
    /// @return windowId Its id when it exists.
    function findWindow(bytes32 underlying, uint64 endTs, uint256 strikeE8)
        external
        view
        returns (bool exists, uint256 windowId)
    {
        uint256 stored = _windowIdByKey[windowKey(underlying, endTs, strikeE8)];
        return (stored != 0, stored == 0 ? 0 : stored - 1);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _listOnKuru(address leg) internal returns (address market) {
        MarketConfig memory c = marketConfig;
        market = kuruRouter.deployProxy(
            0, // both sides are ERC20
            leg,
            address(collateralToken),
            c.sizePrecision,
            c.pricePrecision,
            c.tickSize,
            c.minSize,
            c.maxSize,
            c.takerFeeBps,
            c.makerFeeBps,
            c.kuruAmmSpread
        );
    }

    function _requireWindow(uint256 windowId) internal view returns (Window storage w) {
        if (windowId >= _windows.length) revert UnknownWindow();
        w = _windows[windowId];
    }

    function _decimalString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 tmp = value;
        while (tmp != 0) {
            ++digits;
            tmp /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (value != 0) {
            buf[--digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buf);
    }
}
