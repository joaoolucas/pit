// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OutcomeToken
/// @notice One leg (YES or NO) of a single Pit window. Freely transferable so it
///         can be listed as the base asset of a Kuru spot market; supply is only
///         ever created or destroyed by the PitFactory that deployed it.
/// @dev YES + NO are always minted and burned together as a "set" worth exactly
///      1 unit of collateral, so `yes.totalSupply() == no.totalSupply()` holds for
///      the whole life of a window and the factory is always fully collateralised.
contract OutcomeToken is ERC20 {
    /// @notice The PitFactory allowed to mint and burn. Immutable: a cell's supply
    ///         can never be moved under a different controller.
    address public immutable controller;

    /// @notice Id of the window this leg belongs to, inside `controller`.
    uint256 public immutable windowId;

    uint8 private immutable _decimals;

    error NotController();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 windowId_)
        ERC20(name_, symbol_)
    {
        controller = msg.sender;
        windowId = windowId_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    function mint(address to, uint256 amount) external onlyController {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyController {
        _burn(from, amount);
    }
}
