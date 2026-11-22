// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Read-only view of PrivateClaimRoots (contracts/src/AttestZkMinter.sol).
interface IPrivateClaimRootsReader {
    function issuers(address issuer) external view returns (bool);
    function activeRoot(address issuer) external view returns (uint256);
}

/// @notice Groth16 verifier ABI exported by snarkjs for
/// zk/circuits/presentation-receipt-v1.circom. A deployed verifier must be
/// checked against the ceremony transcript's verifier hash; a non-zero
/// address is not a security check.
interface IPresentationReceiptVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata signals
    ) external view returns (bool);
}

/// @title PresentationReceipts (experimental, unaudited, testnet only)
/// @notice Records a receipt for an attest.proof-request/v1 digest ONLY when a
/// Groth16 proof verifies on-chain against the issuer's live PrivateClaimRoots
/// root. Unlike AssuranceAnchor.recordVerification, the contract does not
/// take the caller's word for the decision (AT-08).
/// @dev A receipt proves: membership of an issuer-committed leaf in that
/// issuer's root at this block, leaf attribute == `attribute`, hidden value >=
/// `threshold`, leaf validity >= `validThrough`, and a salted subject binding,
/// all bound to the request digest, this contract and this chain. It does NOT
/// prove that the digest's preimage requests this attribute/threshold/subject;
/// consumers compare those to their own request. Issuers can publish bad roots.
contract PresentationReceipts {
    uint256 public constant FR =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// signals: [issuer, root, requestDigestHi, requestDigestLo, receiptContract,
    /// chainId, attribute, threshold, validThrough, subjectBinding, nullifier]
    struct Receipt {
        address issuer;
        uint64 blockNumber;
        uint64 validThrough;
        uint256 root;
        uint256 nullifier;
        uint256 attribute;
        uint256 threshold;
        uint256 subjectBinding;
    }

    IPrivateClaimRootsReader public immutable roots;
    IPresentationReceiptVerifier public immutable verifier;
    mapping(bytes32 => Receipt) private receipts;
    mapping(uint256 => bool) public nullifierUsed;

    event ReceiptRecorded(
        bytes32 indexed requestDigest,
        address indexed issuer,
        uint256 indexed nullifier,
        uint256 root,
        uint256 attribute,
        uint256 threshold,
        uint256 subjectBinding,
        uint64 validThrough,
        uint64 blockNumber
    );

    error MainnetGated();
    error InvalidInput();
    error WrongDomain();
    error StaleClaim();
    error UntrustedRoot();
    error RequestAlreadyReceipted();
    error NullifierUsed();
    error InvalidProof();

    constructor(address roots_, address verifier_) {
        // Mainnet stays closed until an external audit and a real ceremony
        // (specs/production-readiness.md).
        if (block.chainid == 1) revert MainnetGated();
        if (roots_ == address(0) || verifier_ == address(0)) revert InvalidInput();
        roots = IPrivateClaimRootsReader(roots_);
        verifier = IPresentationReceiptVerifier(verifier_);
    }

    function submitReceipt(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata signals
    ) external returns (bytes32 requestDigest) {
        for (uint256 i = 0; i < 11; i++) {
            if (signals[i] >= FR) revert InvalidInput();
        }
        if (signals[0] == 0 || signals[0] > type(uint160).max ||
            signals[2] >> 128 != 0 || signals[3] >> 128 != 0 ||
            signals[8] > type(uint64).max ||
            signals[9] == 0 || signals[10] == 0) revert InvalidInput();
        if (signals[4] != uint256(uint160(address(this))) ||
            signals[5] != block.chainid) revert WrongDomain();
        if (signals[8] < block.timestamp) revert StaleClaim();

        address issuer = address(uint160(signals[0]));
        uint256 live = roots.activeRoot(issuer);
        if (!roots.issuers(issuer) || live == 0 || live != signals[1]) revert UntrustedRoot();

        requestDigest = bytes32((signals[2] << 128) | signals[3]);
        if (requestDigest == bytes32(0)) revert InvalidInput();
        if (receipts[requestDigest].blockNumber != 0) revert RequestAlreadyReceipted();
        if (nullifierUsed[signals[10]]) revert NullifierUsed();

        if (!verifier.verifyProof(a, b, c, signals)) revert InvalidProof();

        nullifierUsed[signals[10]] = true;
        receipts[requestDigest] = Receipt({
            issuer: issuer,
            blockNumber: uint64(block.number),
            validThrough: uint64(signals[8]),
            root: signals[1],
            nullifier: signals[10],
            attribute: signals[6],
            threshold: signals[7],
            subjectBinding: signals[9]
        });
        emit ReceiptRecorded(
            requestDigest, issuer, signals[10], signals[1], signals[6], signals[7],
            signals[9], uint64(signals[8]), uint64(block.number)
        );
    }

    function receiptOf(bytes32 requestDigest) external view returns (Receipt memory) {
        return receipts[requestDigest];
    }

    function hasReceipt(bytes32 requestDigest) external view returns (bool) {
        return receipts[requestDigest].blockNumber != 0;
    }
}
