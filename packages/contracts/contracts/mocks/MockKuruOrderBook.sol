// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockKuruOrderBook
/// @notice A local stand-in for a Kuru OrderBook proxy.
///
/// @dev This exists for exactly two reasons and neither of them is the product:
///
///        1. CellFactory tests must run on a bare Hardhat node, where Kuru is not
///           deployed.
///        2. The Envio handlers need a local source of real logs with the real
///           event signatures, so `npm run indexer:dev` can be exercised without
///           waiting on testnet flow.
///
///      The event signatures below are byte-for-byte the ones emitted by Kuru
///      (verified against abi/OrderBook.json in kuru-labs/kuru-sdk v0.0.95), so an
///      indexer built against this is an indexer that works against the real book.
///      Matching is naive O(n) price-time priority -- adequate for a test double,
///      useless as an exchange. The app always points at the real Kuru markets.
contract MockKuruOrderBook {
    using SafeERC20 for IERC20;

    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    event OrdersCanceled(uint40[] orderId, address owner);
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );

    struct Order {
        address owner;
        uint96 size; // remaining, in sizePrecision units
        uint32 price; // in pricePrecision units
        bool isBuy;
        bool alive;
    }

    address public immutable baseAsset;
    address public immutable quoteAsset;
    uint96 public immutable sizePrecision;
    uint32 public immutable pricePrecision;
    uint32 public immutable tickSize;
    uint96 public immutable minSize;

    uint8 private immutable _baseDecimals;
    uint8 private immutable _quoteDecimals;

    uint40 public orderIdCounter;
    mapping(uint40 => Order) public orders;
    uint40[] private _openOrderIds;

    error BadTick();
    error BelowMinSize();
    error NotOwner();
    error PostOnlyCrossed();

    constructor(
        address baseAsset_,
        address quoteAsset_,
        uint96 sizePrecision_,
        uint32 pricePrecision_,
        uint32 tickSize_,
        uint96 minSize_
    ) {
        baseAsset = baseAsset_;
        quoteAsset = quoteAsset_;
        sizePrecision = sizePrecision_;
        pricePrecision = pricePrecision_;
        tickSize = tickSize_;
        minSize = minSize_;
        _baseDecimals = IERC20Metadata(baseAsset_).decimals();
        _quoteDecimals = IERC20Metadata(quoteAsset_).decimals();
    }

    // ------------------------------------------------------------------
    // Amount conversion
    // ------------------------------------------------------------------

    function baseAmount(uint96 size) public view returns (uint256) {
        return (uint256(size) * (10 ** _baseDecimals)) / sizePrecision;
    }

    function quoteAmount(uint96 size, uint32 price) public view returns (uint256) {
        return (uint256(size) * uint256(price) * (10 ** _quoteDecimals)) / (uint256(sizePrecision) * pricePrecision);
    }

    // ------------------------------------------------------------------
    // Order entry
    // ------------------------------------------------------------------

    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external {
        _place(price, size, true, postOnly);
    }

    function addSellOrder(uint32 price, uint96 size, bool postOnly) external {
        _place(price, size, false, postOnly);
    }

    /// @notice Cancel-and-requote in one call, the way a maker actually refreshes.
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external {
        _cancel(orderIdsToCancel);
        for (uint256 i; i < buyPrices.length; ++i) {
            _place(buyPrices[i], buySizes[i], true, postOnly);
        }
        for (uint256 i; i < sellPrices.length; ++i) {
            _place(sellPrices[i], sellSizes[i], false, postOnly);
        }
    }

    function batchCancelOrders(uint40[] calldata orderIds) external {
        _cancel(orderIds);
    }

    function _cancel(uint40[] calldata orderIds) internal {
        uint256 n = orderIds.length;
        uint40[] memory canceled = new uint40[](n);
        uint256 count;
        for (uint256 i; i < n; ++i) {
            Order storage o = orders[orderIds[i]];
            if (!o.alive) continue; // Kuru's cancel is idempotent
            if (o.owner != msg.sender) revert NotOwner();
            o.alive = false;
            _refund(o);
            canceled[count++] = orderIds[i];
        }
        assembly {
            mstore(canceled, count)
        }
        if (count != 0) emit OrdersCanceled(canceled, msg.sender);
    }

    function bestBidAsk() external view returns (uint256 bid, uint256 ask) {
        ask = type(uint256).max;
        for (uint256 i; i < _openOrderIds.length; ++i) {
            Order storage o = orders[_openOrderIds[i]];
            if (!o.alive || o.size == 0) continue;
            if (o.isBuy) {
                if (o.price > bid) bid = o.price;
            } else if (o.price < ask) {
                ask = o.price;
            }
        }
        if (ask == type(uint256).max) ask = 0;
    }

    function openOrderIds() external view returns (uint40[] memory) {
        return _openOrderIds;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _place(uint32 price, uint96 size, bool isBuy, bool postOnly) internal {
        if (price == 0 || price % tickSize != 0) revert BadTick();
        if (size < minSize) revert BelowMinSize();

        uint96 remaining = _match(price, size, isBuy, postOnly);
        if (remaining == 0) return;

        // Escrow the resting remainder, then rest it.
        if (isBuy) {
            IERC20(quoteAsset).safeTransferFrom(msg.sender, address(this), quoteAmount(remaining, price));
        } else {
            IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), baseAmount(remaining));
        }

        uint40 id = ++orderIdCounter;
        orders[id] = Order({owner: msg.sender, size: remaining, price: price, isBuy: isBuy, alive: true});
        _openOrderIds.push(id);

        emit OrderCreated(id, msg.sender, remaining, price, isBuy);
    }

    /// @dev Walks the opposite side taking anything that crosses. Naive but honest:
    ///      it moves the same tokens the real book would.
    function _match(uint32 price, uint96 size, bool isBuy, bool postOnly) internal returns (uint96 remaining) {
        remaining = size;
        for (uint256 i; i < _openOrderIds.length && remaining != 0; ++i) {
            Order storage maker = orders[_openOrderIds[i]];
            if (!maker.alive || maker.size == 0 || maker.isBuy == isBuy) continue;
            bool crosses = isBuy ? maker.price <= price : maker.price >= price;
            if (!crosses) continue;
            if (postOnly) revert PostOnlyCrossed();

            uint96 fill = remaining < maker.size ? remaining : maker.size;
            uint32 execPrice = maker.price;

            uint256 base = baseAmount(fill);
            uint256 quote = quoteAmount(fill, execPrice);

            if (isBuy) {
                // Taker buys base, pays quote. Maker's base is already escrowed here.
                IERC20(quoteAsset).safeTransferFrom(msg.sender, maker.owner, quote);
                IERC20(baseAsset).safeTransfer(msg.sender, base);
            } else {
                // Taker sells base. Maker's quote is already escrowed here.
                IERC20(baseAsset).safeTransferFrom(msg.sender, maker.owner, base);
                IERC20(quoteAsset).safeTransfer(msg.sender, quote);
            }

            maker.size -= fill;
            remaining -= fill;
            if (maker.size == 0) maker.alive = false;

            emit Trade(
                _openOrderIds[i], maker.owner, maker.isBuy, uint256(execPrice), maker.size, msg.sender, tx.origin, fill
            );
        }
    }

    function _refund(Order storage o) internal {
        if (o.size == 0) return;
        if (o.isBuy) {
            IERC20(quoteAsset).safeTransfer(o.owner, quoteAmount(o.size, o.price));
        } else {
            IERC20(baseAsset).safeTransfer(o.owner, baseAmount(o.size));
        }
    }
}
