// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Per-issuer revocation status lists, published as epoch roots. Generalizes PrivateClaimRoots'
///         issuer/epoch/root model: instead of one replaceable "active" root, each issuer list keeps an
///         append-only sequence of epochs, each committing to the complete set of revoked identifiers.
/// @dev Each epoch stores an RFC 6962 (SHA-256) Merkle root over the strictly ascending 32-byte revocation
///      identifiers, the number of identifiers and the publication time. No identifier, credential content,
///      subject or holder data is stored or emitted: only the root and the list size. The contract does not
///      check that the tree is sorted or complete; it fixes what the publisher committed to so verifiers can
///      check a downloaded list or a non-membership proof against it. Verifiers enforce a maximum epoch age,
///      so an issuer must keep publishing (even an unchanged list) for its credentials to stay checkable.
contract RevocationRoots {
    struct Epoch {
        bytes32 root;
        uint64 size;
        uint64 publishedAt;
    }

    address public administrator;
    address public pendingAdministrator;
    mapping(bytes32 => address) public publisher;
    mapping(bytes32 => uint64) public latestEpoch;
    mapping(bytes32 => mapping(uint64 => Epoch)) private epochs;

    event AdministratorProposed(address indexed current, address indexed proposed);
    event AdministratorChanged(address indexed previous, address indexed current);
    event PublisherSet(bytes32 indexed list, address indexed publisher);
    event EpochPublished(bytes32 indexed list, uint64 indexed epoch, bytes32 root, uint64 size);

    constructor(address administrator_) {
        require(administrator_ != address(0), "administrator");
        administrator = administrator_;
        emit AdministratorChanged(address(0), administrator_);
    }

    modifier onlyAdministrator() {
        require(msg.sender == administrator, "not administrator");
        _;
    }

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

    /// @notice Register or rotate an issuer list's publisher key. Setting address(0) stops new epochs, so
    ///         verifiers fail closed once the last epoch exceeds their maximum age. Published epochs are unaffected.
    function setPublisher(bytes32 list, address publisher_) external onlyAdministrator {
        require(list != bytes32(0), "list");
        publisher[list] = publisher_;
        emit PublisherSet(list, publisher_);
    }

    /// @notice Publish the next epoch. Epochs are strictly sequential and never rewritten.
    function publishEpoch(bytes32 list, uint64 epoch, bytes32 root, uint64 size) external {
        require(msg.sender == publisher[list] && msg.sender != address(0), "not publisher");
        require(epoch == latestEpoch[list] + 1, "epoch out of order");
        require(root != bytes32(0), "empty commitment");
        epochs[list][epoch] = Epoch(root, size, uint64(block.timestamp));
        latestEpoch[list] = epoch;
        emit EpochPublished(list, epoch, root, size);
    }

    /// @notice Returns a zeroed struct for an epoch that has not been published.
    function getEpoch(bytes32 list, uint64 epoch) external view returns (Epoch memory) {
        return epochs[list][epoch];
    }

    /// @notice The latest epoch in one call, so a verifier reads number and contents at the same block.
    function latest(bytes32 list) external view returns (uint64 epoch, bytes32 root, uint64 size, uint64 publishedAt) {
        epoch = latestEpoch[list];
        Epoch storage e = epochs[list][epoch];
        return (epoch, e.root, e.size, e.publishedAt);
    }
}
