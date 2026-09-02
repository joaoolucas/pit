// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IKuruRouter} from "../interfaces/IKuruRouter.sol";
import {MockKuruOrderBook} from "./MockKuruOrderBook.sol";

/// @notice Local stand-in for the Kuru Router, so PitFactory can be deployed and
///         exercised on a bare Hardhat node. Emits the same MarketRegistered shape
///         as the real Router (verified against kuru-labs/kuru-sdk v0.0.95).
contract MockKuruRouter is IKuruRouter {
    event MarketRegistered(
        address baseAsset,
        address quoteAsset,
        address market,
        address vaultAddress,
        uint32 pricePrecision,
        uint96 sizePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread
    );

    address[] public markets;

    function deployProxy(
        uint8,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy) {
        proxy = address(
            new MockKuruOrderBook(
                _baseAssetAddress, _quoteAssetAddress, _sizePrecision, _pricePrecision, _tickSize, _minSize
            )
        );
        markets.push(proxy);

        emit MarketRegistered(
            _baseAssetAddress,
            _quoteAssetAddress,
            proxy,
            address(0),
            _pricePrecision,
            _sizePrecision,
            _tickSize,
            _minSize,
            _maxSize,
            _takerFeeBps,
            _makerFeeBps,
            _kuruAmmSpread
        );
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }
}
