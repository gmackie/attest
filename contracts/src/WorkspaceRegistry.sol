// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Testnet registry of scoped issuer commitments and verifier attestations.
/// @dev Does not verify ZK proofs or establish real-world institutional authority.
contract WorkspaceRegistry {
    address public immutable administrator;
    struct Grant { bool enabled; bytes32 signingKeyHash; }
    struct Anchor { address issuer; bytes32 scope; bytes32 commitment; uint64 validUntil; bool revoked; }
    mapping(address => mapping(bytes32 => Grant)) public issuers;
    mapping(address => bool) public verifiers;
    mapping(bytes32 => Anchor) public anchors;
    mapping(address => mapping(bytes32 => bool)) public usedRequests;
    event IssuerConfigured(address indexed issuer, bytes32 indexed scope, bytes32 signingKeyHash, bool enabled);
    event VerifierConfigured(address indexed verifier, bool enabled);
    event CredentialAnchored(bytes32 indexed id, address indexed issuer, bytes32 scope, bytes32 commitment, uint64 validUntil);
    event CredentialRevoked(bytes32 indexed id);
    event DecisionRecorded(address indexed verifier, bytes32 indexed requestCommitment, bytes32 proofCommitment, bool satisfied);
    error Unauthorized(); error InvalidInput(); error AlreadyUsed();
    constructor() { administrator = msg.sender; }
    modifier onlyAdmin() { if (msg.sender != administrator) revert Unauthorized(); _; }
    function configureIssuer(address issuer, bytes32 scope, bytes32 signingKeyHash, bool enabled) external onlyAdmin {
        if (issuer == address(0) || scope == bytes32(0) || signingKeyHash == bytes32(0)) revert InvalidInput();
        issuers[issuer][scope] = Grant(enabled, signingKeyHash);
        emit IssuerConfigured(issuer, scope, signingKeyHash, enabled);
    }
    function configureVerifier(address verifier, bool enabled) external onlyAdmin {
        if (verifier == address(0)) revert InvalidInput();
        verifiers[verifier] = enabled; emit VerifierConfigured(verifier, enabled);
    }
    function anchor(bytes32 id, bytes32 scope, bytes32 commitment, uint64 validUntil) external {
        if (!issuers[msg.sender][scope].enabled) revert Unauthorized();
        if (id == bytes32(0) || commitment == bytes32(0) || validUntil <= block.timestamp) revert InvalidInput();
        if (anchors[id].issuer != address(0)) revert AlreadyUsed();
        anchors[id] = Anchor(msg.sender, scope, commitment, validUntil, false);
        emit CredentialAnchored(id, msg.sender, scope, commitment, validUntil);
    }
    function revoke(bytes32 id) external {
        if (anchors[id].issuer != msg.sender) revert Unauthorized();
        if (anchors[id].revoked) revert AlreadyUsed();
        anchors[id].revoked = true; emit CredentialRevoked(id);
    }
    function recordDecision(bytes32 requestCommitment, bytes32 proofCommitment, bool satisfied) external {
        if (!verifiers[msg.sender]) revert Unauthorized();
        if (requestCommitment == bytes32(0) || proofCommitment == bytes32(0)) revert InvalidInput();
        if (usedRequests[msg.sender][requestCommitment]) revert AlreadyUsed();
        usedRequests[msg.sender][requestCommitment] = true;
        emit DecisionRecorded(msg.sender, requestCommitment, proofCommitment, satisfied);
    }
}
