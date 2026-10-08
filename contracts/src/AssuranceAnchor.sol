// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Attest assurance commitment and verification receipt registry
/// @notice Stores no raw evidence, credential values, identities, or policy documents.
contract AssuranceAnchor {
    enum Status { Active, Revoked, Superseded }

    struct Anchor {
        address issuer;
        bytes32 evidenceCommitment;
        bytes32 schemaHash;
        uint64 validUntil;
        Status status;
    }

    mapping(bytes32 attestationId => Anchor anchor) public anchors;

    event AttestationAnchored(
        bytes32 indexed attestationId,
        address indexed issuer,
        bytes32 evidenceCommitment,
        bytes32 schemaHash,
        uint64 validUntil
    );

    event AttestationStatusChanged(
        bytes32 indexed attestationId,
        Status status
    );

    event VerificationRecorded(
        bytes32 indexed receiptId,
        bytes32 indexed policyCommitment,
        bytes32 indexed evidenceRoot,
        bytes32 proofCommitment,
        bytes32 subjectNullifier,
        bool satisfied,
        address verifier
    );

    error AlreadyAnchored(bytes32 attestationId);
    error UnknownAttestation(bytes32 attestationId);
    error NotIssuer(address expected, address actual);

    function anchorAttestation(
        bytes32 attestationId,
        bytes32 evidenceCommitment,
        bytes32 schemaHash,
        uint64 validUntil
    ) external {
        if (anchors[attestationId].issuer != address(0)) revert AlreadyAnchored(attestationId);
        anchors[attestationId] = Anchor({
            issuer: msg.sender,
            evidenceCommitment: evidenceCommitment,
            schemaHash: schemaHash,
            validUntil: validUntil,
            status: Status.Active
        });
        emit AttestationAnchored(attestationId, msg.sender, evidenceCommitment, schemaHash, validUntil);
    }

    function setAttestationStatus(bytes32 attestationId, Status status) external {
        Anchor storage anchor = anchors[attestationId];
        if (anchor.issuer == address(0)) revert UnknownAttestation(attestationId);
        if (anchor.issuer != msg.sender) revert NotIssuer(anchor.issuer, msg.sender);
        anchor.status = status;
        emit AttestationStatusChanged(attestationId, status);
    }

    function recordVerification(
        bytes32 policyCommitment,
        bytes32 evidenceRoot,
        bytes32 proofCommitment,
        bytes32 subjectNullifier,
        bool satisfied
    ) external returns (bytes32 receiptId) {
        receiptId = keccak256(abi.encode(
            block.chainid,
            address(this),
            msg.sender,
            policyCommitment,
            evidenceRoot,
            proofCommitment,
            subjectNullifier,
            satisfied,
            block.number
        ));
        emit VerificationRecorded(
            receiptId,
            policyCommitment,
            evidenceRoot,
            proofCommitment,
            subjectNullifier,
            satisfied,
            msg.sender
        );
    }
}
