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

/// @notice Chain ids this experimental code may be deployed on: anvil/hardhat, Sepolia, Base Sepolia.
library TestnetOnly {
    function check() internal view {
        uint256 id = block.chainid;
        require(id == 31337 || id == 1337 || id == 11155111 || id == 84532, "testnet only");
    }
}

/// @notice Experimental, testnet-only ERC-4337 smart account that lets an agent session key spend an ERC-20
///         stablecoin strictly inside an owner-registered Attest mandate chain, and only with a matching
///         Gatekeeper decision co-signature (2-of-2). Not audited. Security review required before any value
///         beyond testnet.
/// @dev Policy lives on-chain as commitments and limits only: the mandate digest (SHA-256 of the canonical
///      Attest mandate JSON), its parent digest, token, per-action cap, aggregate cap, per-op gas-cost cap,
///      validity window and payee allowlist. No mandate contents or evidence are stored.
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
        "GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint256 totalGasLimit,uint256 maxFeePerGas,uint48 validUntil)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice What Gatekeeper co-signs. Every field is derived by the account from the op itself.
    struct GatekeeperDecision {
        address entryPoint;
        bytes32 userOpHash;
        uint256 nonce;
        bytes32 mandateDigest;
        address token;
        address payee;
        uint256 amount;
        /// verificationGasLimit + callGasLimit + preVerificationGas (no paymaster is accepted).
        uint256 totalGasLimit;
        uint256 maxFeePerGas;
        uint48 validUntil;
    }

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
        /// Upper bound on totalGasLimit * maxFeePerGas (the EntryPoint prefund) for one op, in wei.
        uint256 maxGasCost;
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
    address public pendingOwner;
    address public gatekeeper;
    address public guardian;
    bool public paused;

    mapping(bytes32 => Mandate) private mandates;
    mapping(bytes32 => mapping(address => bool)) public payeeAllowed;
    mapping(address => SessionKey) private sessionKeys;
    /// userOpHash => executed. Defence in depth on top of the EntryPoint nonce.
    mapping(bytes32 => bool) public consumed;

    event MandateRegistered(bytes32 indexed mandate, bytes32 indexed parent, address token, uint256 maxPerAction, uint256 maxTotal, uint256 maxGasCost, uint48 validAfter, uint48 validUntil);
    event MandateRevoked(bytes32 indexed mandate);
    event SessionKeyRegistered(address indexed key, bytes32 indexed mandate, uint48 validAfter, uint48 validUntil);
    event SessionKeyRevoked(address indexed key);
    event GatekeeperChanged(address indexed gatekeeper);
    event GuardianChanged(address indexed guardian);
    event OwnerProposed(address indexed current, address indexed proposed);
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
        TestnetOnly.check();
        require(entryPoint_ != address(0) && owner_ != address(0) && gatekeeper_ != address(0), "zero address");
        require(owner_ != gatekeeper_ && guardian_ != gatekeeper_, "role overlap");
        entryPoint = entryPoint_;
        owner = owner_;
        gatekeeper = gatekeeper_;
        guardian = guardian_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner operations (direct calls)

    /// @notice Two-step ownership transfer: the proposed owner must accept.
    function proposeOwner(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnerProposed(owner, next);
    }

    function acceptOwner() external {
        address next = pendingOwner;
        require(msg.sender == next && next != address(0), "not pending owner");
        require(!sessionKeys[next].exists && next != gatekeeper && next != guardian, "role overlap");
        owner = next;
        pendingOwner = address(0);
        emit OwnerChanged(next);
    }

    /// @notice The Gatekeeper key must be independent of every other role, so one key never satisfies 2-of-2.
    function setGatekeeper(address next) external onlyOwner {
        require(next != address(0), "zero address");
        require(!sessionKeys[next].exists && next != guardian && next != owner, "role overlap");
        gatekeeper = next;
        emit GatekeeperChanged(next);
    }

    function setGuardian(address next) external onlyOwner {
        require(next == address(0) || (!sessionKeys[next].exists && next != gatekeeper), "role overlap");
        guardian = next;
        emit GuardianChanged(next);
    }

    /// @notice Register a mandate by digest. A child must narrow its parent: same token, caps (including the gas-cost
    ///         cap) no larger, validity inside the parent's, payees a subset. Its spending counts against every ancestor.
    function registerMandate(
        bytes32 digest,
        bytes32 parent,
        address token,
        uint256 maxPerAction,
        uint256 maxTotal,
        uint256 maxGasCost,
        uint48 validAfter,
        uint48 validUntil,
        address[] calldata payees
    ) external onlyOwner {
        require(digest != bytes32(0) && !mandates[digest].exists, "mandate exists");
        require(token != address(0) && token.code.length > 0, "token");
        require(maxPerAction > 0 && maxPerAction <= maxTotal, "caps");
        require(validAfter < validUntil, "validity");
        Mandate storage m = mandates[digest];
        m.parent = parent;
        m.token = token;
        m.validAfter = validAfter;
        m.validUntil = validUntil;
        m.exists = true;
        m.maxPerAction = maxPerAction;
        m.maxTotal = maxTotal;
        m.maxGasCost = maxGasCost;
        _checkNarrowing(m);
        _setPayees(digest, parent, payees);
        _emitRegistered(digest, m);
    }

    function _emitRegistered(bytes32 digest, Mandate storage m) internal {
        emit MandateRegistered(digest, m.parent, m.token, m.maxPerAction, m.maxTotal, m.maxGasCost, m.validAfter, m.validUntil);
    }

    /// @dev A child must narrow its parent on every limit; sets the child's depth.
    function _checkNarrowing(Mandate storage m) internal {
        if (m.parent == bytes32(0)) return;
        Mandate storage p = mandates[m.parent];
        require(p.exists && !p.revoked, "parent");
        require(p.depth + 1 < MAX_DEPTH, "depth");
        require(
            m.token == p.token && m.maxPerAction <= p.maxPerAction && m.maxTotal <= p.maxTotal && m.maxGasCost <= p.maxGasCost
                && m.validAfter >= p.validAfter && m.validUntil <= p.validUntil,
            "not narrowed"
        );
        m.depth = p.depth + 1;
    }

    function _setPayees(bytes32 digest, bytes32 parent, address[] calldata payees) internal {
        require(payees.length > 0 && payees.length <= 64, "payees");
        for (uint256 i; i < payees.length; ++i) {
            require(payees[i] != address(0), "payees");
            require(parent == bytes32(0) || payeeAllowed[parent][payees[i]], "not narrowed");
            payeeAllowed[digest][payees[i]] = true;
        }
    }

    /// @notice Revoke a mandate. Every descendant is unusable too, because spends walk the whole chain.
    function revokeMandate(bytes32 digest) external onlyOwner {
        require(mandates[digest].exists, "unknown mandate");
        mandates[digest].revoked = true;
        emit MandateRevoked(digest);
    }

    function registerSessionKey(address key, bytes32 mandate, uint48 validAfter, uint48 validUntil) external onlyOwner {
        require(key != address(0) && !sessionKeys[key].exists, "session key");
        require(key != owner && key != pendingOwner && key != gatekeeper && key != guardian, "session key");
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
    function gatekeeperDigest(GatekeeperDecision memory d) public view returns (bytes32) {
        // All members are static, so abi.encode(typehash, d) equals the EIP-712 encodeData of the struct.
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(GATEKEEPER_DECISION_TYPEHASH, d))));
    }

    // ---------------------------------------------------------------- ERC-4337

    /// @dev Follows the ERC-4337 validation rules as far as practical: only this account's own storage is read or
    ///      written, no TIMESTAMP/NUMBER opcodes (time limits are returned as validAfter/validUntil), the only
    ///      external call is the prefund to the EntryPoint, and every signature problem (including malformed
    ///      encodings) returns SIG_VALIDATION_FAILED instead of reverting. The policy walk and gas-cost check run
    ///      whether or not the signatures are valid, so validation gas does not depend on signature validity.
    ///      Malformed operations and policy violations revert with a reason.
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
    ///         time, remaining budgets, replay) and both signatures, so it is safe even if called without a
    ///         successful validation; then debits every ancestor and performs the single token transfer.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external override onlyEntryPoint {
        require(!consumed[userOpHash], "replayed");
        consumed[userOpHash] = true;
        require(!paused, "paused");
        (GatekeeperDecision memory d, bool wellFormed, bytes calldata sessionSig, bytes calldata gatekeeperSig) =
            _decision(userOp, userOpHash);
        require(wellFormed, "signature");
        require(block.timestamp <= d.validUntil, "decision expired");
        address cosigner = _recover(gatekeeperDigest(d), gatekeeperSig);
        require(cosigner != address(0) && cosigner == gatekeeper, "gatekeeper");
        address key = _recover(_ethSigned(userOpHash), sessionSig);
        SessionKey storage s = sessionKeys[key];
        require(key != address(0) && s.exists && !s.revoked && s.mandate == d.mandateDigest, "session key");
        require(block.timestamp >= s.validAfter && block.timestamp <= s.validUntil, "session key expired");
        (uint48 validAfter, uint48 validUntil,) = _checkChain(d.mandateDigest, d.token, d.payee, d.amount);
        require(block.timestamp >= validAfter && block.timestamp <= validUntil, "mandate expired");
        bytes32 cursor = d.mandateDigest;
        while (cursor != bytes32(0)) {
            Mandate storage m = mandates[cursor];
            m.spent += d.amount;
            cursor = m.parent;
        }
        emit MandateSpend(d.mandateDigest, userOpHash, d.payee, d.token, d.amount);
        (bool ok, bytes memory ret) = d.token.call(abi.encodeCall(IERC20Transfer.transfer, (d.payee, d.amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    // ---------------------------------------------------------------- internals

    function _validate(PackedUserOperation calldata userOp, bytes32 userOpHash) internal view returns (uint256) {
        require(userOp.sender == address(this), "sender");
        require(userOp.initCode.length == 0, "initCode");
        require(userOp.paymasterAndData.length == 0, "paymaster");
        require(!consumed[userOpHash], "replayed");
        require(!paused, "paused");
        (GatekeeperDecision memory d, bool wellFormed, bytes calldata sessionSig, bytes calldata gatekeeperSig) =
            _decision(userOp, userOpHash);

        // Policy and gas cost first, independent of the signatures.
        (uint48 validAfter, uint48 validUntil, uint256 maxGasCost) = _checkChain(d.mandateDigest, d.token, d.payee, d.amount);
        require(d.maxFeePerGas == 0 || d.totalGasLimit <= maxGasCost / d.maxFeePerGas, "gas cost cap");

        address key = _recover(_ethSigned(userOpHash), sessionSig);
        address cosigner = _recover(gatekeeperDigest(d), gatekeeperSig);
        SessionKey storage s = sessionKeys[key];
        bool failed = !wellFormed || key == address(0) || !s.exists || s.revoked || s.mandate != d.mandateDigest
            || cosigner == address(0) || cosigner != gatekeeper;
        if (failed) return SIG_VALIDATION_FAILED;

        if (s.validAfter > validAfter) validAfter = s.validAfter;
        if (s.validUntil < validUntil) validUntil = s.validUntil;
        if (d.validUntil < validUntil) validUntil = d.validUntil;
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    /// @dev Builds the GatekeeperDecision entirely from the op (callData, gas fields, nonce, signature's expiry).
    function _decision(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        returns (GatekeeperDecision memory d, bool wellFormed, bytes calldata sessionSig, bytes calldata gatekeeperSig)
    {
        d.entryPoint = entryPoint;
        d.userOpHash = userOpHash;
        d.nonce = userOp.nonce;
        (d.mandateDigest, d.token, d.payee, d.amount) = _decodeCall(userOp.callData);
        (d.totalGasLimit, d.maxFeePerGas) = _gas(userOp);
        (wellFormed, d.validUntil, sessionSig, gatekeeperSig) = _decodeSignature(userOp.signature);
    }

    /// @dev v0.7 prefund = (verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas with no paymaster.
    function _gas(PackedUserOperation calldata userOp) internal pure returns (uint256 totalGasLimit, uint256 maxFeePerGas) {
        uint256 limits = uint256(userOp.accountGasLimits);
        require(userOp.preVerificationGas <= type(uint128).max, "gas");
        totalGasLimit = (limits >> 128) + uint128(limits) + userOp.preVerificationGas;
        maxFeePerGas = uint128(uint256(userOp.gasFees));
    }

    /// @dev Walks leaf to root. Every ancestor must be live and allow the token, payee, per-action amount and
    ///      remaining aggregate budget, so siblings share and cannot reset a parent's ceiling.
    function _checkChain(bytes32 mandate, address token, address payee, uint256 amount)
        internal
        view
        returns (uint48 validAfter, uint48 validUntil, uint256 maxGasCost)
    {
        require(amount > 0, "amount");
        validUntil = type(uint48).max;
        maxGasCost = type(uint256).max;
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
            if (m.maxGasCost < maxGasCost) maxGasCost = m.maxGasCost;
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

    /// @dev Bounds-checked manual decode of abi.encode(uint48, bytes, bytes). Never reverts; ok=false on any
    ///      malformed encoding (short data, out-of-range offsets or lengths, dirty uint48, zero expiry).
    function _decodeSignature(bytes calldata sig)
        internal
        pure
        returns (bool ok, uint48 validUntil, bytes calldata sessionSig, bytes calldata gatekeeperSig)
    {
        sessionSig = sig[0:0];
        gatekeeperSig = sig[0:0];
        if (sig.length < 96) return (false, 0, sessionSig, gatekeeperSig);
        uint256 word = uint256(bytes32(sig[0:32]));
        if (word == 0 || word > type(uint48).max) return (false, 0, sessionSig, gatekeeperSig);
        bool okA;
        bool okB;
        (okA, sessionSig) = _slice(sig, uint256(bytes32(sig[32:64])));
        (okB, gatekeeperSig) = _slice(sig, uint256(bytes32(sig[64:96])));
        return (okA && okB, uint48(word), sessionSig, gatekeeperSig);
    }

    function _slice(bytes calldata data, uint256 offset) internal pure returns (bool, bytes calldata out) {
        out = data[0:0];
        if (offset < 96 || offset > data.length || data.length - offset < 32) return (false, out);
        uint256 len = uint256(bytes32(data[offset:offset + 32]));
        if (len > data.length - offset - 32) return (false, out);
        return (true, data[offset + 32:offset + 32 + len]);
    }

    function _ethSigned(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// @dev Minimal ECDSA: 65-byte r||s||v, v in {27,28}, low-s only. Returns address(0) on any failure.
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
