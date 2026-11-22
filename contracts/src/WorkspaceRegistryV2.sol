// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Testnet registry of scoped issuer commitments and verifier attestations, with governance:
///         rotatable (Safe-compatible) administrator, emergency revocation with reason codes, and
///         issuer signing-key lifecycle (validity windows and compromise cutoff).
/// @dev Does not verify ZK proofs or establish real-world institutional authority. Only commitments,
///      key-hash commitments and reason codes are stored; never raw evidence.
///
///      Safe compatibility: every authorization check is `msg.sender` equality. There is no tx.origin,
///      no extcodesize / EOA check and no signature recovery, so the administrator may be an EOA, a Safe
///      or any other contract account that can make calls.
///
///      V1 compatibility: the V1 ABI (administrator, issuers, verifiers, anchors, usedRequests,
///      configureIssuer, configureVerifier, anchor, revoke, recordDecision and their events/errors) is
///      preserved with the same signatures. Anchors are namespaced per issuer: storage, getters and events
///      use key = anchorKey(issuer, id), so one issuer cannot claim (squat) another issuer's id. V1 readers
///      must not be used against V2 (they ignore key lifecycle); registryVersion() lets them detect V2.
///      Differences are listed in specs/registry-v2-governance.md.
contract WorkspaceRegistryV2 {
    struct Grant { bool enabled; bytes32 signingKeyHash; }
    struct Anchor { address issuer; bytes32 scope; bytes32 commitment; uint64 validUntil; bool revoked; }
    /// @dev The issuer signing key in effect when the anchor was written, and the block time it was written.
    struct AnchorBinding { bytes32 signingKeyHash; uint64 anchoredAt; }
    /// @dev Key usable for t in [validFrom, validUntil) and, if compromisedAt != 0, t < compromisedAt.
    ///      validUntil == 0 means the key is not registered.
    struct SigningKey { uint64 validFrom; uint64 validUntil; uint64 compromisedAt; bytes32 compromiseReason; }
    struct EmergencyRevocation { bytes32 reason; uint64 revokedAt; }

    uint64 public constant OPEN_ENDED = type(uint64).max;
    /// @notice An administrator proposal not accepted within this period lapses.
    uint64 public constant PROPOSAL_TTL = 7 days;

    address public administrator;
    address public pendingAdministrator;
    /// @notice Last block time (inclusive) at which pendingAdministrator may accept; 0 when none is pending.
    uint64 public pendingAdministratorDeadline;
    mapping(address => mapping(bytes32 => Grant)) public issuers;
    mapping(address => bool) public verifiers;
    /// @dev Keyed by anchorKey(issuer, id).
    mapping(bytes32 => Anchor) public anchors;
    mapping(address => mapping(bytes32 => bool)) public usedRequests;
    /// @dev Keyed by anchorKey(issuer, id).
    mapping(bytes32 => AnchorBinding) public anchorBindings;
    mapping(address => mapping(bytes32 => SigningKey)) public issuerKeys;
    /// @dev Keyed by anchorKey(issuer, id).
    mapping(bytes32 => EmergencyRevocation) public anchorRevocations;
    mapping(address => mapping(bytes32 => EmergencyRevocation)) public grantRevocations;

    // V1 events.
    event IssuerConfigured(address indexed issuer, bytes32 indexed scope, bytes32 signingKeyHash, bool enabled);
    event VerifierConfigured(address indexed verifier, bool enabled);
    event CredentialAnchored(bytes32 indexed id, address indexed issuer, bytes32 scope, bytes32 commitment, uint64 validUntil);
    event CredentialRevoked(bytes32 indexed id);
    event DecisionRecorded(address indexed verifier, bytes32 indexed requestCommitment, bytes32 proofCommitment, bool satisfied);
    // V2 events.
    event AdministratorProposed(address indexed current, address indexed proposed, uint64 deadline);
    event AdministratorProposalCancelled(address indexed current, address indexed proposed);
    event AdministratorChanged(address indexed previous, address indexed current);
    /// @dev `key` is anchorKey(issuer, id); `id` is the issuer-chosen id.
    event CredentialKeyBound(bytes32 indexed key, address indexed issuer, bytes32 indexed id, bytes32 signingKeyHash, uint64 anchoredAt);
    event IssuerKeyRegistered(address indexed issuer, bytes32 indexed signingKeyHash, uint64 validFrom, uint64 validUntil);
    event IssuerKeyRetired(address indexed issuer, bytes32 indexed signingKeyHash, uint64 validUntil);
    event IssuerKeyCompromised(address indexed issuer, bytes32 indexed signingKeyHash, uint64 compromisedAt, bytes32 reason);
    event IssuerKeyRotated(address indexed issuer, bytes32 indexed scope, bytes32 previousKeyHash, bytes32 signingKeyHash);
    event AnchorEmergencyRevoked(bytes32 indexed key, address indexed issuer, bytes32 indexed reason, bytes32 id, uint64 revokedAt);
    event GrantEmergencyRevoked(address indexed issuer, bytes32 indexed scope, bytes32 indexed reason, uint64 revokedAt);

    error Unauthorized(); error InvalidInput(); error AlreadyUsed();
    error NotPendingAdministrator(); error ProposalExpired(); error GrantRevoked(); error KeyUnusable();

    /// @notice Interface version marker. V1 has no such function, so a revert or empty return means V1.
    function registryVersion() external pure returns (uint256) { return 2; }

    /// @notice Storage key of an issuer's anchor id. Ids are per issuer: the same id under two issuers
    ///         is two independent anchors.
    function anchorKey(address issuer, bytes32 id) public pure returns (bytes32) {
        return keccak256(abi.encode(issuer, id));
    }

    /// @param administrator_ Initial administrator, typically a Safe. Explicit so a factory or deployer
    ///        EOA never becomes the governance root by accident.
    constructor(address administrator_) {
        if (administrator_ == address(0)) revert InvalidInput();
        administrator = administrator_;
        emit AdministratorChanged(address(0), administrator_);
    }

    modifier onlyAdmin() { if (msg.sender != administrator) revert Unauthorized(); _; }

    // ---------------------------------------------------------------- administrator lifecycle

    /// @notice Step one of a handover. Replaces any earlier pending proposal. Lapses after PROPOSAL_TTL.
    function proposeAdministrator(address next) external onlyAdmin {
        if (next == address(0) || next == administrator) revert InvalidInput();
        uint64 deadline = uint64(block.timestamp) + PROPOSAL_TTL;
        pendingAdministrator = next;
        pendingAdministratorDeadline = deadline;
        emit AdministratorProposed(administrator, next, deadline);
    }

    function cancelAdministratorProposal() external onlyAdmin {
        address proposed = pendingAdministrator;
        if (proposed == address(0)) revert InvalidInput();
        pendingAdministrator = address(0);
        pendingAdministratorDeadline = 0;
        emit AdministratorProposalCancelled(administrator, proposed);
    }

    /// @notice Step two, called by the proposed administrator (for example through a Safe transaction).
    ///         Needs nothing from the current administrator, so a pre-arranged handover completes even if
    ///         the current administrator's key has since been lost, as long as it is accepted before the
    ///         deadline. An expired proposal cannot be accepted; the administrator must propose again.
    function acceptAdministrator() external {
        if (msg.sender != pendingAdministrator || msg.sender == address(0)) revert NotPendingAdministrator();
        if (block.timestamp > pendingAdministratorDeadline) revert ProposalExpired();
        emit AdministratorChanged(administrator, msg.sender);
        administrator = msg.sender;
        pendingAdministrator = address(0);
        pendingAdministratorDeadline = 0;
    }

    // ---------------------------------------------------------------- grants and verifiers (V1 ABI)

    /// @notice V1 signature. Enabling a grant requires its key to be usable now; an unregistered key is
    ///         registered open-ended from this block (V1 behaviour). A grant that was emergency revoked
    ///         cannot be configured again.
    function configureIssuer(address issuer, bytes32 scope, bytes32 signingKeyHash, bool enabled) external onlyAdmin {
        if (issuer == address(0) || scope == bytes32(0) || signingKeyHash == bytes32(0)) revert InvalidInput();
        if (grantRevocations[issuer][scope].revokedAt != 0) revert GrantRevoked();
        if (enabled) _ensureUsableKey(issuer, signingKeyHash);
        issuers[issuer][scope] = Grant(enabled, signingKeyHash);
        emit IssuerConfigured(issuer, scope, signingKeyHash, enabled);
    }

    function configureVerifier(address verifier, bool enabled) external onlyAdmin {
        if (verifier == address(0)) revert InvalidInput();
        verifiers[verifier] = enabled; emit VerifierConfigured(verifier, enabled);
    }

    // ---------------------------------------------------------------- issuer signing keys

    /// @notice Register a key with an explicit validity window. No retroactive validity: validFrom >= now.
    function registerIssuerKey(address issuer, bytes32 signingKeyHash, uint64 validFrom, uint64 validUntil) external onlyAdmin {
        if (issuer == address(0) || signingKeyHash == bytes32(0)) revert InvalidInput();
        if (validFrom < block.timestamp || validUntil <= validFrom) revert InvalidInput();
        if (issuerKeys[issuer][signingKeyHash].validUntil != 0) revert AlreadyUsed();
        issuerKeys[issuer][signingKeyHash] = SigningKey(validFrom, validUntil, 0, bytes32(0));
        emit IssuerKeyRegistered(issuer, signingKeyHash, validFrom, validUntil);
    }

    /// @notice Move the grant for (issuer, scope) to a new signing key. Earlier anchors keep the key they
    ///         were written with and stay valid; use markIssuerKeyCompromised to invalidate them.
    function rotateIssuerKey(address issuer, bytes32 scope, bytes32 signingKeyHash) external onlyAdmin {
        Grant storage grant = issuers[issuer][scope];
        if (!grant.enabled || signingKeyHash == bytes32(0) || signingKeyHash == grant.signingKeyHash) revert InvalidInput();
        _ensureUsableKey(issuer, signingKeyHash);
        bytes32 previous = grant.signingKeyHash;
        grant.signingKeyHash = signingKeyHash;
        emit IssuerKeyRotated(issuer, scope, previous, signingKeyHash);
        emit IssuerConfigured(issuer, scope, signingKeyHash, true);
    }

    /// @notice Shorten a key's validity for planned retirement. Never retroactive (validUntil >= now);
    ///         a retroactive cutoff is a compromise and uses markIssuerKeyCompromised.
    function retireIssuerKey(address issuer, bytes32 signingKeyHash, uint64 validUntil) external onlyAdmin {
        SigningKey storage key = issuerKeys[issuer][signingKeyHash];
        if (key.validUntil == 0 || validUntil < block.timestamp || validUntil >= key.validUntil) revert InvalidInput();
        key.validUntil = validUntil;
        emit IssuerKeyRetired(issuer, signingKeyHash, validUntil);
    }

    /// @notice Compromise cutoff: anything anchored with the key at or after `compromisedAt` is invalid;
    ///         earlier anchors stay valid unless revoked separately. The administrator or the issuer itself
    ///         (which can already revoke its own anchors) may report. The cutoff can only move earlier.
    function markIssuerKeyCompromised(address issuer, bytes32 signingKeyHash, uint64 compromisedAt, bytes32 reason) external {
        if (msg.sender != administrator && msg.sender != issuer) revert Unauthorized();
        SigningKey storage key = issuerKeys[issuer][signingKeyHash];
        if (key.validUntil == 0 || compromisedAt == 0 || compromisedAt > block.timestamp || reason == bytes32(0)) revert InvalidInput();
        if (key.compromisedAt != 0 && compromisedAt >= key.compromisedAt) revert AlreadyUsed();
        key.compromisedAt = compromisedAt;
        key.compromiseReason = reason;
        emit IssuerKeyCompromised(issuer, signingKeyHash, compromisedAt, reason);
    }

    function keyUsableAt(address issuer, bytes32 signingKeyHash, uint64 at) public view returns (bool) {
        SigningKey storage key = issuerKeys[issuer][signingKeyHash];
        return key.validUntil != 0 && at >= key.validFrom && at < key.validUntil &&
            (key.compromisedAt == 0 || at < key.compromisedAt);
    }

    function _ensureUsableKey(address issuer, bytes32 signingKeyHash) internal {
        if (issuerKeys[issuer][signingKeyHash].validUntil == 0) {
            issuerKeys[issuer][signingKeyHash] = SigningKey(uint64(block.timestamp), OPEN_ENDED, 0, bytes32(0));
            emit IssuerKeyRegistered(issuer, signingKeyHash, uint64(block.timestamp), OPEN_ENDED);
        } else if (!keyUsableAt(issuer, signingKeyHash, uint64(block.timestamp))) {
            revert KeyUnusable();
        }
    }

    // ---------------------------------------------------------------- anchors (V1 ABI)

    /// @notice V1 signature; `id` is in the caller's namespace. CredentialAnchored carries the storage key
    ///         anchorKey(msg.sender, id); CredentialKeyBound carries both.
    function anchor(bytes32 id, bytes32 scope, bytes32 commitment, uint64 validUntil) external {
        Grant storage grant = issuers[msg.sender][scope];
        if (!grant.enabled) revert Unauthorized();
        if (id == bytes32(0) || commitment == bytes32(0) || validUntil <= block.timestamp) revert InvalidInput();
        bytes32 key = anchorKey(msg.sender, id);
        if (anchors[key].issuer != address(0)) revert AlreadyUsed();
        if (!keyUsableAt(msg.sender, grant.signingKeyHash, uint64(block.timestamp))) revert KeyUnusable();
        anchors[key] = Anchor(msg.sender, scope, commitment, validUntil, false);
        anchorBindings[key] = AnchorBinding(grant.signingKeyHash, uint64(block.timestamp));
        emit CredentialAnchored(key, msg.sender, scope, commitment, validUntil);
        emit CredentialKeyBound(key, msg.sender, id, grant.signingKeyHash, uint64(block.timestamp));
    }

    /// @notice V1: the original issuer may permanently revoke its own anchor (`id` in its namespace).
    function revoke(bytes32 id) external {
        bytes32 key = anchorKey(msg.sender, id);
        if (anchors[key].issuer != msg.sender) revert Unauthorized();
        if (anchors[key].revoked) revert AlreadyUsed();
        anchors[key].revoked = true; emit CredentialRevoked(key);
    }

    // ---------------------------------------------------------------- emergency revocation (irreversible)

    /// @notice Administrator revocation of one anchor, for example when the issuer's account is lost.
    ///         Also sets the V1 `revoked` flag so V1 readers see it. There is no undo.
    function emergencyRevokeAnchor(address issuer, bytes32 id, bytes32 reason) external onlyAdmin {
        bytes32 key = anchorKey(issuer, id);
        if (anchors[key].issuer == address(0) || reason == bytes32(0)) revert InvalidInput();
        if (anchorRevocations[key].revokedAt != 0) revert AlreadyUsed();
        anchorRevocations[key] = EmergencyRevocation(reason, uint64(block.timestamp));
        emit AnchorEmergencyRevoked(key, issuer, reason, id, uint64(block.timestamp));
        if (!anchors[key].revoked) { anchors[key].revoked = true; emit CredentialRevoked(key); }
    }

    /// @notice Administrator revocation of an issuer grant. Invalidates every anchor under (issuer, scope),
    ///         blocks new anchors, and the grant can never be re-enabled; re-admission needs a new issuer
    ///         account or scope. There is no undo.
    function emergencyRevokeGrant(address issuer, bytes32 scope, bytes32 reason) external onlyAdmin {
        if (issuer == address(0) || scope == bytes32(0) || reason == bytes32(0)) revert InvalidInput();
        if (grantRevocations[issuer][scope].revokedAt != 0) revert AlreadyUsed();
        grantRevocations[issuer][scope] = EmergencyRevocation(reason, uint64(block.timestamp));
        Grant storage grant = issuers[issuer][scope];
        grant.enabled = false;
        emit GrantEmergencyRevoked(issuer, scope, reason, uint64(block.timestamp));
        emit IssuerConfigured(issuer, scope, grant.signingKeyHash, false);
    }

    // ---------------------------------------------------------------- decisions (V1 ABI)

    function recordDecision(bytes32 requestCommitment, bytes32 proofCommitment, bool satisfied) external {
        if (!verifiers[msg.sender]) revert Unauthorized();
        if (requestCommitment == bytes32(0) || proofCommitment == bytes32(0)) revert InvalidInput();
        if (usedRequests[msg.sender][requestCommitment]) revert AlreadyUsed();
        usedRequests[msg.sender][requestCommitment] = true;
        emit DecisionRecorded(msg.sender, requestCommitment, proofCommitment, satisfied);
    }
}
