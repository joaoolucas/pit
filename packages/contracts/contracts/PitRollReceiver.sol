// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {PitFactory} from "./PitFactory.sol";

/// @notice The Keystone receiver interface a Chainlink Forwarder calls into.
/// @dev Declared here for the same reason it is declared in PitSettlementReceiver:
///      the shape is fixed by the Forwarder and pinning a package for two function
///      signatures would be a dependency to audit for no benefit.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title PitRollReceiver
/// @notice Opens the next columns of the board from a CRE report, so the grid
///         has no keeper.
///
/// @dev A board of five-minute markets is an operation, not a deployment: every
///      five minutes a column closes and another has to exist ahead of it. That
///      was a script on somebody's laptop holding the operator key, which is the
///      single point of failure the rest of this design does not have.
///
///      Rolling needs exactly what settling needs — the clock, which is onchain,
///      and the price, which is not, because the strike ladder is anchored to
///      spot. That is the whole reason CRE is in this repo, so the roller belongs
///      there too.
///
///      Why this is a second receiver rather than a second field in the
///      settlement report:
///
///        * Gas. Opening one cell deploys two ERC20s and lists two Kuru markets.
///          A settlement report carrying a roll would put settlement — which is
///          time-critical, and where somebody's money is waiting — behind the
///          most expensive write in the system, under one gas limit sized for
///          whichever of them is larger. They get their own budgets.
///        * Blast radius. This contract cannot settle and cannot touch a price.
///          The worst a bad roll report can do is open markets nobody asked for,
///          which is noise on the board and not a loss.
///
///      A cell that reverts does not take the batch down, for the same reason it
///      does not in settlement: `createWindow` reverts `WindowExists` on a cell
///      that already exists, and a retried report must still open the others.
contract PitRollReceiver is IReceiver, Ownable2Step {
    /// @notice The Pit deployment this receiver opens windows on.
    PitFactory public immutable factory;

    /// @notice The Chainlink Forwarder allowed to deliver reports.
    address public forwarder;

    /// @notice Cells opened so far, and when the last report landed. For monitoring.
    uint256 public totalOpened;
    uint64 public lastReportAt;

    event ForwarderUpdated(address indexed previous, address indexed next);
    event ReportAccepted(bytes32 indexed underlying, uint256 cellCount, uint64 receivedAt);
    event WindowOpened(uint256 indexed windowId, uint64 endTs, uint256 strikeE8);
    event WindowSkipped(uint64 endTs, uint256 strikeE8, bytes reason);

    error NotForwarder();
    error EmptyReport();
    error LengthMismatch();
    error BadWindowSeconds();

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
    /// @param report abi.encode(bytes32 underlying, uint64 windowSeconds, uint64[] ends, uint256[] strikeE8s)
    /// @dev `ends` and `strikeE8s` are parallel: one cell per index, already
    ///      filtered by `PitFactory.missingWindows` so a report only carries work
    ///      that still needs doing. `metadata` is unused — the Forwarder is the
    ///      trust boundary, as it is for settlement.
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder();

        (bytes32 underlying, uint64 windowSeconds, uint64[] memory ends, uint256[] memory strikeE8s) =
            abi.decode(report, (bytes32, uint64, uint64[], uint256[]));

        if (ends.length == 0) revert EmptyReport();
        if (ends.length != strikeE8s.length) revert LengthMismatch();
        if (windowSeconds == 0) revert BadWindowSeconds();

        lastReportAt = uint64(block.timestamp);
        emit ReportAccepted(underlying, ends.length, lastReportAt);

        for (uint256 i; i < ends.length; ++i) {
            uint64 endTs = ends[i];
            // A column that closed between the workflow reading the chain and the
            // report landing is not worth opening: nobody could trade it and
            // settlement would immediately have to clean it up.
            if (endTs <= block.timestamp) {
                emit WindowSkipped(endTs, strikeE8s[i], "");
                continue;
            }
            if (endTs <= windowSeconds) {
                emit WindowSkipped(endTs, strikeE8s[i], "");
                continue;
            }

            try factory.createWindow(underlying, endTs - windowSeconds, endTs, strikeE8s[i]) returns (
                uint256 windowId
            ) {
                unchecked {
                    ++totalOpened;
                }
                emit WindowOpened(windowId, endTs, strikeE8s[i]);
            } catch (bytes memory reason) {
                emit WindowSkipped(endTs, strikeE8s[i], reason);
            }
        }
    }
}
