// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of the Kuru Router (market factory) that Cell depends on.
/// @dev Verified against the ABI shipped in `kuru-labs/kuru-sdk v0.0.95`
///      (`abi/Router.json`). Monad testnet: 0x7EFbE105Ca7415dE98F96622173458ac1c054630
interface IKuruRouter {
    /// @param _type 0 = base and quote are both ERC20, 1 = base is native MON, 2 = quote is native MON
    function deployProxy(
        uint8 _type,
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
    ) external returns (address proxy);
}
