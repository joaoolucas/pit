// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {PitFactory} from "./PitFactory.sol";

/// @notice The Keystone receiver interface a Chainlink Forwarder calls into.
/// @dev Declared here rather than imported so this repo has no dependency on a
///      package that would have to be pinned and audited separately. The shape is
///      fixed by the Forwarder: it checks ERC-165 for this interface id and then
///      calls onReport.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title PitSettlementReceiver
/// @notice The onchain half of Pit's Chainlink CRE settlement.
///
/// @dev The CRE workflow reads a reference price off-chain and the window clock
///      on-chain, decides which windows have closed, and writes one signed report.
///      The Forwarder delivers it here; this contract decodes it and calls
///      `PitFactory.settle` for each window in the batch.
///
///      Three deliberate choices:
///
///        * One report settles many windows. Seven strikes close at the same
///          instant on a 5-minute grid, and paying for seven reports to carry one
///          price would be silly.
///        * A window that reverts does not take the batch down. Settling is
///          idempotent-by-revert (`AlreadyResolved`), and a retried report must
///          not strand the windows that had not been settled yet.
///        * There is no privileged path back out. This contract can only call
///          `settle`, and `PitFactory.voidWindow` still lets anyone rescue a
///          window this receiver never resolves.
contract PitSettlementReceiver is IReceiver, Ownable2Step {
    /// @notice The Pit deployment this receiver settles for.
    PitFactory public immutable factory;

    /// @notice The Chainlink Forwarder allowed to deliver reports.
    address public forwarder;

    /// @notice Most recent price this receiver accepted, 1e8 USD. For monitoring.
    uint256 public lastPriceE8;
    uint64 public lastReportAt;

    event ForwarderUpdated(address indexed previous, address indexed next);
    event ReportAccepted(uint256 priceE8, uint256 windowCount, uint64 receivedAt);
    event WindowSettled(uint256 indexed windowId, uint256 priceE8);
    event WindowSkipped(uint256 indexed windowId, bytes reason);

    error NotForwarder();
    error EmptyReport();
    error BadPrice();

    constructor(address owner_, address factory_, address forwarder_) Ownable(owner_) {
        factory = PitFactory(factory_);
        forwarder = forwarder_;
        emit ForwarderUpdated(address(0), forwarder_);
    }

    function setForwarder(address next) external onlyOwner {
        emit ForwarderUpdated(forwarder, next);
        forwarder = next;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Called by the Chainlink Forwarder with a report the DON signed.
    /// @param report abi.encode(uint256 priceE8, uint256[] windowIds)
    /// @dev `metadata` carries the workflow id, owner and name. It is unused here:
    ///      the Forwarder is the trust boundary, and rotating `forwarder` is how a
    ///      workflow is swapped. Pinning the workflow id in this contract too is the
    ///      obvious next hardening step and is noted in docs/CRE.md.
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder();

        (uint256 priceE8, uint256[] memory windowIds) = abi.decode(report, (uint256, uint256[]));
        if (priceE8 == 0) revert BadPrice();
        if (windowIds.length == 0) revert EmptyReport();

        lastPriceE8 = priceE8;
        lastReportAt = uint64(block.timestamp);
        emit ReportAccepted(priceE8, windowIds.length, lastReportAt);

        for (uint256 i; i < windowIds.length; ++i) {
            // A window someone already settled, or one whose clock has not quite
            // reached endTs on this block, must not sink the rest of the batch.
            try factory.settle(windowIds[i], priceE8) {
                emit WindowSettled(windowIds[i], priceE8);
            } catch (bytes memory reason) {
                emit WindowSkipped(windowIds[i], reason);
            }
        }
    }
}
