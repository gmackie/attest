// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Sepolia-only, issuer-operated live Merkle roots for qualifying
/// commitments. Only the configured issuer can publish/replace their active
/// root. A Merkle root is NOT independent proof of the issuer's real-world
/// competence or event truthfulness.
contract PrivateClaimRoots {
    uint256 public constant FR = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    address public immutable administrator;
    mapping(address => bool) public issuers;
    mapping(address => uint256) public activeRoot;
    mapping(address => uint64) public epoch;
    event IssuerConfigured(address indexed issuer, bool accepted);
    event RootChanged(address indexed issuer, uint256 indexed root, uint64 epoch);
    error SepoliaOnly();
    error Unauthorized();
    error InvalidInput();
    constructor() {
        if (block.chainid != 11155111) revert SepoliaOnly();
        administrator = msg.sender;
    }
    function configureIssuer(address issuer, bool accepted) external {
        if (msg.sender != administrator) revert Unauthorized();
        if (issuer == address(0)) revert InvalidInput();
        issuers[issuer] = accepted;
        if (!accepted) {
            activeRoot[issuer] = 0; // revoke all paths issued by that authority.
            epoch[issuer]++;
            emit RootChanged(issuer, 0, epoch[issuer]);
        }
        emit IssuerConfigured(issuer, accepted);
    }
    /// @notice A replacement root instantly invalidates old proofs. Issuer
    /// must rebuild it with revoked leaves excluded. Root==0 freezes issuance.
    function replaceRoot(uint256 root) external {
        if (!issuers[msg.sender]) revert Unauthorized();
        if (root >= FR) revert InvalidInput();
        activeRoot[msg.sender] = root;
        epoch[msg.sender]++;
        emit RootChanged(msg.sender, root, epoch[msg.sender]);
    }
}

/// @notice Groth16 verifier ABI exported by snarkjs from pinned circuit.
/// A non-zero verifier address is NOT a security check; its actual bytecode and
/// verifying key must be independently verified against the circuit hash.
interface IAttestConversionVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata signals
    ) external view returns (bool);
}

interface IZkMintableAttest {
    function mintFromZk(
        bytes32 policyId, bytes32 nullifier, bytes32 proofCommitment,
        bytes32 provenanceCommitment, address recipient, uint256 amount, uint64 palette
    ) external;
}

/// @notice Testnet-only private conversion with *direct* proof verification.
/// No authorized off-chain EIP-712 signature is needed on this mint path.
/// Gatekeeper: a proof of membership in an issuer's current live root says
/// nothing beyond what that issuer legitimately attests to.
contract ZkAttestMinterV1 {
    uint256 public constant POLICY = 1;
    uint256 public constant AMOUNT = 200 ether;
    uint64 public constant PALETTE = 1125912791875585000;
    uint256 public constant MAX_AUTHORIZATION_WINDOW = 3600;
    IZkMintableAttest public immutable token;
    PrivateClaimRoots public immutable roots;
    IAttestConversionVerifier public immutable verifier;
    error SepoliaOnly();
    error InvalidInput();
    error UntrustedRoot();
    error InvalidProof();

    constructor(address token_, address roots_, address verifier_) {
        if (block.chainid != 11155111) revert SepoliaOnly();
        if (token_ == address(0) || roots_ == address(0) || verifier_ == address(0)) revert InvalidInput();
        token = IZkMintableAttest(token_);
        roots = PrivateClaimRoots(roots_);
        verifier = IAttestConversionVerifier(verifier_);
    }

    /// @param signals [issuer,root,nullifier,recipient,token,chain,expiry,amount,palette,policy,provenance].
    /// Checks critical public inputs independently from the Groth16 proof,
    /// including the root selected by the AUTHENTICATED on-chain issuer.
    function mintWithProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata signals
    ) external {
        if (signals[2] == 0 || signals[3] == 0 || signals[3] > type(uint160).max ||
            signals[4] != uint256(uint160(address(token))) ||
            signals[5] != block.chainid || signals[7] != AMOUNT ||
            signals[8] != PALETTE || signals[9] != POLICY ||
            signals[6] <= block.timestamp ||
            signals[6] > block.timestamp + MAX_AUTHORIZATION_WINDOW ||
            signals[0] == 0 || signals[0] > type(uint160).max) revert InvalidInput();

        address issuer = address(uint160(signals[0]));
        if (!roots.issuers(issuer) || roots.activeRoot(issuer) == 0 ||
            roots.activeRoot(issuer) != signals[1]) revert UntrustedRoot();

        if (!verifier.verifyProof(a,b,c,signals)) revert InvalidProof();

        // Token spends the SAME permanent nullifier across both authorized
        // legacy EIP-712 and direct-ZK mint paths; it imposes policy caps.
        token.mintFromZk(
            bytes32(POLICY), bytes32(signals[2]),
            keccak256(abi.encode(a,b,c,signals)),
            bytes32(signals[10]),
            address(uint160(signals[3])), AMOUNT, PALETTE
        );
    }
}
