// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of a Kuru OrderBook proxy. Cell never calls this from a contract —
///         it is declared so the deployment scripts and the indexer share one source
///         of truth for the CLOB surface a cell exposes.
/// @dev Verified against `kuru-labs/kuru-sdk v0.0.95` (`abi/OrderBook.json`).
interface IKuruOrderBook {
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

    function addBuyOrder(uint32 _price, uint96 size, bool _postOnly) external;

    function addSellOrder(uint32 _price, uint96 size, bool _postOnly) external;

    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;

    function batchCancelOrders(uint40[] calldata _orderIds) external;

    function bestBidAsk() external view returns (uint256, uint256);

    function getL2Book() external view returns (bytes memory);
}
