// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Digest-bound status for signed documents such as agent mandates and transaction approvals.
///         An issuer registers a status reference bound to the SHA-256 digest of one document; only that
///         issuer can move it, and only forward: Active -> Revoked or Active -> Superseded(successor).
///         No document content is stored or emitted: only a hashed reference, the digest and an expiry.
/// @dev Records are namespaced by issuer address (`records[issuer][ref]`), so nobody can front-run an
///      issuer's registration to squat its reference, and "only the issuer can transition" holds by
///      construction: a write from another account addresses that account's own, empty namespace.
///      There is deliberately no administrator. An administrator who could revoke or reactivate records
///      would be a second authority over every issuer's documents; issuer key loss is bounded instead by
///      the document's own expiry and by verifiers refusing unknown or expired records.
contract StatusRegistry {
    enum Status {
        None,
        Active,
        Revoked,
        Superseded
    }

    struct Record {
        bytes32 digest;
        Status status;
        /// Unix seconds; the document's own validity end (informational upper bound for verifiers).
        uint64 validUntil;
        uint64 registeredAt;
        uint64 changedAt;
        /// Set only when superseded: the successor reference in the same issuer namespace.
        bytes32 successor;
    }

    mapping(address => mapping(bytes32 => Record)) private records;

    event StatusRegistered(address indexed issuer, bytes32 indexed ref, bytes32 digest, uint64 validUntil);
    event StatusRevoked(address indexed issuer, bytes32 indexed ref);
    event StatusSuperseded(address indexed issuer, bytes32 indexed ref, bytes32 indexed successor);

    /// @notice Bind `ref` to `digest` as Active. A reference can be registered once; it never reactivates.
    function register(bytes32 ref, bytes32 digest, uint64 validUntil) external {
        require(ref != bytes32(0), "ref");
        require(digest != bytes32(0), "digest");
        require(validUntil > block.timestamp, "expired");
        Record storage record = records[msg.sender][ref];
        require(record.status == Status.None, "already registered");
        records[msg.sender][ref] = Record(
            digest, Status.Active, validUntil, uint64(block.timestamp), uint64(block.timestamp), bytes32(0)
        );
        emit StatusRegistered(msg.sender, ref, digest, validUntil);
    }

    /// @notice Active -> Revoked. Terminal.
    function revoke(bytes32 ref) external {
        Record storage record = _active(ref);
        record.status = Status.Revoked;
        record.changedAt = uint64(block.timestamp);
        emit StatusRevoked(msg.sender, ref);
    }

    /// @notice Active -> Superseded. Terminal. The successor must be another Active reference of the same issuer,
    ///         so register the replacement document first.
    function supersede(bytes32 ref, bytes32 successor) external {
        require(successor != bytes32(0) && successor != ref, "successor");
        require(records[msg.sender][successor].status == Status.Active, "successor not active");
        Record storage record = _active(ref);
        record.status = Status.Superseded;
        record.successor = successor;
        record.changedAt = uint64(block.timestamp);
        emit StatusSuperseded(msg.sender, ref, successor);
    }

    /// @notice Returns a zeroed record (status None) for an unknown reference.
    function getStatus(address issuer, bytes32 ref) external view returns (Record memory) {
        return records[issuer][ref];
    }

    function _active(bytes32 ref) private view returns (Record storage record) {
        record = records[msg.sender][ref];
        require(record.status != Status.None, "unknown ref");
        require(record.status == Status.Active, "not active");
    }
}
