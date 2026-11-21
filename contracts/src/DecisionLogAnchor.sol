// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Public commitments to sealed epochs of hash-chained decision logs (for example Gatekeeper's
///         decision ledger). Each epoch stores an RFC 6962 Merkle root over salted leaf hashes plus the
///         sequence span and boundary leaf hashes. No decision content is stored or emitted.
/// @dev Epochs are strictly sequential per log and must continue the previous epoch's chain: the first leaf's
///      predecessor is the previous epoch's last leaf and sequence numbers are contiguous. A publisher therefore
///      cannot skip, rewrite or fork history after anchoring it. The contract does not verify the Merkle root
///      itself; it fixes it publicly so later inclusion proofs can be checked against it.
contract DecisionLogAnchor {
    struct Epoch {
        bytes32 root;
        uint64 firstSeq;
        uint64 lastSeq;
        bytes32 firstPrevHash;
        bytes32 lastLeafHash;
        uint64 anchoredAt;
    }

    address public administrator;
    address public pendingAdministrator;
    mapping(bytes32 => address) public publisher;
    mapping(bytes32 => uint64) public latestEpoch;
    mapping(bytes32 => mapping(uint64 => Epoch)) private epochs;

    event AdministratorProposed(address indexed current, address indexed proposed);
    event AdministratorChanged(address indexed previous, address indexed current);
    event PublisherSet(bytes32 indexed log, address indexed publisher);
    event EpochAnchored(
        bytes32 indexed log,
        uint64 indexed epoch,
        bytes32 root,
        uint64 firstSeq,
        uint64 lastSeq,
        bytes32 lastLeafHash
    );

    constructor(address administrator_) {
        require(administrator_ != address(0), "administrator");
        administrator = administrator_;
        emit AdministratorChanged(address(0), administrator_);
    }

    modifier onlyAdministrator() {
        require(msg.sender == administrator, "not administrator");
        _;
    }

    /// @notice Two-step handover so a mistyped address cannot strand the log (unlike an immutable admin).
    function proposeAdministrator(address next) external onlyAdministrator {
        pendingAdministrator = next;
        emit AdministratorProposed(administrator, next);
    }

    function acceptAdministrator() external {
        require(msg.sender == pendingAdministrator && msg.sender != address(0), "not proposed");
        emit AdministratorChanged(administrator, msg.sender);
        administrator = msg.sender;
        pendingAdministrator = address(0);
    }

    /// @notice Set or rotate a log's publisher (for example after a key compromise). Anchored epochs are unaffected.
    function setPublisher(bytes32 log, address publisher_) external onlyAdministrator {
        require(log != bytes32(0), "log");
        publisher[log] = publisher_;
        emit PublisherSet(log, publisher_);
    }

    function anchorEpoch(
        bytes32 log,
        uint64 epoch,
        bytes32 root,
        uint64 firstSeq,
        uint64 lastSeq,
        bytes32 firstPrevHash,
        bytes32 lastLeafHash
    ) external {
        require(msg.sender == publisher[log] && msg.sender != address(0), "not publisher");
        require(epoch == latestEpoch[log] + 1, "epoch out of order");
        require(root != bytes32(0) && lastLeafHash != bytes32(0), "empty commitment");
        require(firstSeq >= 1 && lastSeq >= firstSeq, "span");
        if (epoch == 1) {
            require(firstSeq == 1 && firstPrevHash == bytes32(0), "genesis");
        } else {
            Epoch storage previous = epochs[log][epoch - 1];
            require(firstSeq == previous.lastSeq + 1, "sequence gap");
            require(firstPrevHash == previous.lastLeafHash, "chain fork");
        }
        epochs[log][epoch] = Epoch(root, firstSeq, lastSeq, firstPrevHash, lastLeafHash, uint64(block.timestamp));
        latestEpoch[log] = epoch;
        emit EpochAnchored(log, epoch, root, firstSeq, lastSeq, lastLeafHash);
    }

    /// @notice Returns a zeroed struct for an epoch that has not been anchored.
    function getEpoch(bytes32 log, uint64 epoch) external view returns (Epoch memory) {
        return epochs[log][epoch];
    }
}
