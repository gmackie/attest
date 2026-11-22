// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice ERC-4337 v0.7 packed user operation (EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @notice ERC-4337 account interface (self-contained; no vendored EntryPoint sources).
interface IAccount {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

/// @notice v0.7 execution hook: when callData starts with this selector the EntryPoint calls it with the full op.
interface IAccountExecute {
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external;
}

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Experimental, testnet-only ERC-4337 smart account that lets an agent session key spend an ERC-20
///         stablecoin strictly inside an owner-registered Attest mandate chain, and only with a matching
///         Gatekeeper decision co-signature (2-of-2). Not audited. Security review required before any value
///         beyond testnet.
/// @dev Policy lives on-chain as commitments and limits only: the mandate digest (SHA-256 of the canonical
///      Attest mandate JSON), its parent digest, token, per-action cap, aggregate cap, validity window and payee
///      allowlist. No mandate contents or evidence are stored.
///
///      Session-key operations: callData MUST be `executeUserOp.selector ++ abi.encode(mandate, token, payee,
///      amount)`; the only effect is `token.transfer(payee, amount)`. userOp.signature is
///      `abi.encode(uint48 decisionValidUntil, bytes sessionSignature, bytes gatekeeperSignature)`.
///      Owner operations are direct calls from the owner EOA and never go through the EntryPoint.
contract MandateAccount is IAccount, IAccountExecute {
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint256 internal constant MAX_DEPTH = 8;
    /// secp256k1n / 2: signatures with a larger s are malleable and rejected.
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant GATEKEEPER_DECISION_TYPEHASH = keccak256(
        "GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint48 validUntil)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct Mandate {
        bytes32 parent;
        address token;
        uint48 validAfter;
        uint48 validUntil;
        uint8 depth;
        bool exists;
        bool revoked;
        uint256 maxPerAction;
        uint256 maxTotal;
        uint256 spent;
    }

    struct SessionKey {
        bytes32 mandate;
        uint48 validAfter;
        uint48 validUntil;
        bool exists;
        bool revoked;
    }

    address public immutable entryPoint;
    address public owner;
    address public gatekeeper;
    address public guardian;
    bool public paused;

    mapping(bytes32 => Mandate) private mandates;
    mapping(bytes32 => mapping(address => bool)) public payeeAllowed;
    mapping(address => SessionKey) private sessionKeys;
    /// userOpHash => executed. Defence in depth on top of the EntryPoint nonce.
    mapping(bytes32 => bool) public consumed;

    event MandateRegistered(bytes32 indexed mandate, bytes32 indexed parent, address token, uint256 maxPerAction, uint256 maxTotal, uint48 validAfter, uint48 validUntil);
    event MandateRevoked(bytes32 indexed mandate);
    event SessionKeyRegistered(address indexed key, bytes32 indexed mandate, uint48 validAfter, uint48 validUntil);
    event SessionKeyRevoked(address indexed key);
    event GatekeeperChanged(address indexed gatekeeper);
    event GuardianChanged(address indexed guardian);
    event OwnerChanged(address indexed owner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event MandateSpend(bytes32 indexed mandate, bytes32 indexed userOpHash, address indexed payee, address token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyEntryPoint() {
        require(msg.sender == entryPoint, "not entry point");
        _;
    }

    constructor(address entryPoint_, address owner_, address gatekeeper_, address guardian_) {
        require(block.chainid != 1, "testnet only");
        require(entryPoint_ != address(0) && owner_ != address(0) && gatekeeper_ != address(0), "zero address");
        entryPoint = entryPoint_;
        owner = owner_;
        gatekeeper = gatekeeper_;
        guardian = guardian_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner operations (direct calls)

    function setOwner(address next) external onlyOwner {
        require(next != address(0), "zero address");
        owner = next;
        emit OwnerChanged(next);
    }

    function setGatekeeper(address next) external onlyOwner {
        require(next != address(0), "zero address");
        gatekeeper = next;
        emit GatekeeperChanged(next);
    }

    function setGuardian(address next) external onlyOwner {
        guardian = next;
        emit GuardianChanged(next);
    }

    /// @notice Register a mandate by digest. A child must narrow its parent: same token, caps no larger,
    ///         validity inside the parent's, payees a subset. Its spending also counts against every ancestor.
    function registerMandate(
        bytes32 digest,
        bytes32 parent,
        address token,
        uint256 maxPerAction,
        uint256 maxTotal,
        uint48 validAfter,
        uint48 validUntil,
        address[] calldata payees
    ) external onlyOwner {
        require(digest != bytes32(0) && !mandates[digest].exists, "mandate exists");
        require(token != address(0) && token.code.length > 0, "token");
        require(maxPerAction > 0 && maxPerAction <= maxTotal, "caps");
        require(validAfter < validUntil, "validity");
        require(payees.length > 0 && payees.length <= 64, "payees");
        uint8 depth;
        if (parent != bytes32(0)) {
            Mandate storage p = mandates[parent];
            require(p.exists && !p.revoked, "parent");
            require(p.depth + 1 < MAX_DEPTH, "depth");
            require(
                token == p.token && maxPerAction <= p.maxPerAction && maxTotal <= p.maxTotal
                    && validAfter >= p.validAfter && validUntil <= p.validUntil,
                "not narrowed"
            );
            depth = p.depth + 1;
        }
        for (uint256 i; i < payees.length; ++i) {
            require(payees[i] != address(0), "payees");
            require(parent == bytes32(0) || payeeAllowed[parent][payees[i]], "not narrowed");
            payeeAllowed[digest][payees[i]] = true;
        }
        mandates[digest] = Mandate({
            parent: parent,
            token: token,
            validAfter: validAfter,
            validUntil: validUntil,
            depth: depth,
            exists: true,
            revoked: false,
            maxPerAction: maxPerAction,
            maxTotal: maxTotal,
            spent: 0
        });
        emit MandateRegistered(digest, parent, token, maxPerAction, maxTotal, validAfter, validUntil);
    }

    /// @notice Revoke a mandate. Every descendant is unusable too, because spends walk the whole chain.
    function revokeMandate(bytes32 digest) external onlyOwner {
        require(mandates[digest].exists, "unknown mandate");
        mandates[digest].revoked = true;
        emit MandateRevoked(digest);
    }

    function registerSessionKey(address key, bytes32 mandate, uint48 validAfter, uint48 validUntil) external onlyOwner {
        require(key != address(0) && !sessionKeys[key].exists, "session key");
        require(key != owner && key != gatekeeper && key != guardian, "session key");
        require(mandates[mandate].exists && !mandates[mandate].revoked, "unknown mandate");
        require(validAfter < validUntil, "validity");
        sessionKeys[key] = SessionKey({mandate: mandate, validAfter: validAfter, validUntil: validUntil, exists: true, revoked: false});
        emit SessionKeyRegistered(key, mandate, validAfter, validUntil);
    }

    /// @notice Revoked keys stay revoked; register a fresh key instead of reusing one.
    function revokeSessionKey(address key) external onlyOwner {
        require(sessionKeys[key].exists, "unknown session key");
        sessionKeys[key].revoked = true;
        emit SessionKeyRevoked(key);
    }

    /// @notice Owner-only arbitrary call (e.g. withdraw funds, top up the EntryPoint deposit).
    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    // ---------------------------------------------------------------- pause guardian

    /// @notice Guardian or owner can pause. Pausing only blocks session-key spends; it cannot move funds.
    function pause() external {
        require(msg.sender == guardian || msg.sender == owner, "not guardian");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ---------------------------------------------------------------- views

    function getMandate(bytes32 digest) external view returns (Mandate memory) {
        return mandates[digest];
    }

    function getSessionKey(address key) external view returns (SessionKey memory) {
        return sessionKeys[key];
    }

    /// @notice Smallest remaining aggregate budget along the chain (what a single op could still spend).
    function remaining(bytes32 digest) external view returns (uint256 left) {
        left = type(uint256).max;
        bytes32 cursor = digest;
        for (uint256 i; i < MAX_DEPTH && cursor != bytes32(0); ++i) {
            Mandate storage m = mandates[cursor];
            if (!m.exists) return 0;
            uint256 r = m.maxTotal - m.spent;
            if (r < left) left = r;
            cursor = m.parent;
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AttestMandateAccount"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice EIP-712 digest the Gatekeeper signs. The domain binds chainId and this account.
    function gatekeeperDigest(
        bytes32 userOpHash,
        uint256 nonce,
        bytes32 mandateDigest,
        address token,
        address payee,
        uint256 amount,
        uint48 validUntil
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                GATEKEEPER_DECISION_TYPEHASH, entryPoint, userOpHash, nonce, mandateDigest, token, payee, amount, validUntil
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------- ERC-4337

    /// @dev Follows the ERC-4337 validation rules as far as practical: only this account's own storage is read or
    ///      written, no TIMESTAMP/NUMBER opcodes (time limits are returned as validAfter/validUntil), the only
    ///      external call is the prefund to the EntryPoint, and signature mismatches return SIG_VALIDATION_FAILED
    ///      instead of reverting. Malformed operations and policy violations revert with a reason.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        override
        onlyEntryPoint
        returns (uint256 validationData)
    {
        validationData = _validate(userOp, userOpHash);
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok); // The EntryPoint verifies the deposit; a failed prefund fails there.
        }
    }

    /// @notice Execution phase: re-checks everything that may have changed since validation (pause, revocation,
    ///         time, remaining budgets, replay), debits every ancestor, then performs the single token transfer.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external override onlyEntryPoint {
        require(!consumed[userOpHash], "replayed");
        consumed[userOpHash] = true;
        require(!paused, "paused");
        (bytes32 mandate, address token, address payee, uint256 amount) = _decodeCall(userOp.callData);
        (uint48 decisionValidUntil, bytes memory sessionSig,) = abi.decode(userOp.signature, (uint48, bytes, bytes));
        require(block.timestamp <= decisionValidUntil, "decision expired");
        address key = _recover(_ethSigned(userOpHash), sessionSig);
        SessionKey storage s = sessionKeys[key];
        require(key != address(0) && s.exists && !s.revoked && s.mandate == mandate, "session key");
        require(block.timestamp >= s.validAfter && block.timestamp <= s.validUntil, "session key expired");
        (uint48 validAfter, uint48 validUntil) = _checkChain(mandate, token, payee, amount);
        require(block.timestamp >= validAfter && block.timestamp <= validUntil, "mandate expired");
        bytes32 cursor = mandate;
        while (cursor != bytes32(0)) {
            Mandate storage m = mandates[cursor];
            m.spent += amount;
            cursor = m.parent;
        }
        emit MandateSpend(mandate, userOpHash, payee, token, amount);
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Transfer.transfer, (payee, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    // ---------------------------------------------------------------- internals

    function _validate(PackedUserOperation calldata userOp, bytes32 userOpHash) internal view returns (uint256) {
        require(userOp.sender == address(this), "sender");
        require(userOp.initCode.length == 0, "initCode");
        require(!consumed[userOpHash], "replayed");
        require(!paused, "paused");
        (bytes32 mandate, address token, address payee, uint256 amount) = _decodeCall(userOp.callData);
        (uint48 decisionValidUntil, bytes memory sessionSig, bytes memory gatekeeperSig) =
            abi.decode(userOp.signature, (uint48, bytes, bytes));
        require(decisionValidUntil != 0, "decision expiry");

        address key = _recover(_ethSigned(userOpHash), sessionSig);
        SessionKey storage s = sessionKeys[key];
        if (key == address(0) || !s.exists || s.revoked || s.mandate != mandate) return SIG_VALIDATION_FAILED;
        address cosigner =
            _recover(gatekeeperDigest(userOpHash, userOp.nonce, mandate, token, payee, amount, decisionValidUntil), gatekeeperSig);
        if (cosigner == address(0) || cosigner != gatekeeper) return SIG_VALIDATION_FAILED;

        (uint48 validAfter, uint48 validUntil) = _checkChain(mandate, token, payee, amount);
        if (s.validAfter > validAfter) validAfter = s.validAfter;
        if (s.validUntil < validUntil) validUntil = s.validUntil;
        if (decisionValidUntil < validUntil) validUntil = decisionValidUntil;
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    /// @dev Walks leaf to root. Every ancestor must be live and allow the token, payee, per-action amount and
    ///      remaining aggregate budget, so siblings share and cannot reset a parent's ceiling.
    function _checkChain(bytes32 mandate, address token, address payee, uint256 amount)
        internal
        view
        returns (uint48 validAfter, uint48 validUntil)
    {
        require(amount > 0, "amount");
        validUntil = type(uint48).max;
        bytes32 cursor = mandate;
        uint256 i;
        while (cursor != bytes32(0)) {
            require(i++ < MAX_DEPTH, "depth");
            Mandate storage m = mandates[cursor];
            require(m.exists, "unknown mandate");
            require(!m.revoked, "mandate revoked");
            require(m.token == token, "wrong token");
            require(payeeAllowed[cursor][payee], "payee not allowed");
            require(amount <= m.maxPerAction, "per-action cap");
            require(amount <= m.maxTotal - m.spent, "aggregate cap");
            if (m.validAfter > validAfter) validAfter = m.validAfter;
            if (m.validUntil < validUntil) validUntil = m.validUntil;
            cursor = m.parent;
        }
    }

    function _decodeCall(bytes calldata data)
        internal
        pure
        returns (bytes32 mandate, address token, address payee, uint256 amount)
    {
        require(data.length == 4 + 128 && bytes4(data[:4]) == IAccountExecute.executeUserOp.selector, "callData");
        (mandate, token, payee, amount) = abi.decode(data[4:], (bytes32, address, address, uint256));
    }

    function _ethSigned(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// @dev Minimal ECDSA: 65-byte r||s||v, v in {27,28}, low-s only. Returns address(0) on any failure.
    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
