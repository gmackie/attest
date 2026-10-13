// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Experimental SEP0LIA-ONLY assets. No mainnet minting, financial rights, or legal trust score.
/// @dev Conversion proofs are verified OFF CHAIN by a configured authorizer. A signed
///      EIP-712 authorization is NOT equivalent to on-chain ZK verification.
contract AttestToken {
    string public constant name = "Attest (testnet)";
    string public constant symbol = "ATTEST";
    uint8 public constant decimals = 18;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CONVERSION_TYPEHASH = keccak256("Conversion(bytes32 policyId,bytes32 nullifier,bytes32 proofCommitment,bytes32 provenanceCommitment,address recipient,uint256 amount,uint64 expiresAt,uint64 palette)");
    bytes32 private constant NAME_HASH = keccak256("Attest Conversion");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private constant BPS = 10_000;

    struct Conversion {
        bytes32 policyId;
        bytes32 nullifier;
        bytes32 proofCommitment;
        bytes32 provenanceCommitment;
        address recipient;
        uint256 amount;
        uint64 expiresAt;
        uint64 palette; // Four big-endian uint16 proportions, summing to 10,000.
    }
    struct Policy {
        uint256 cap;
        uint256 minted;
        bool enabled;
    }

    address public immutable administrator;
    address public authorizer;
    uint256 public immutable maxSupply;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256[4]) private mixtures;
    mapping(bytes32 => bool) public spentNullifiers;
    mapping(bytes32 => Policy) public policies;

    error Unauthorized();
    error InvalidInput();
    error SepoliaOnly();
    error NotEnoughBalance();
    error InsufficientAllowance();
    error AlreadySpent();
    error InvalidSignature();
    error PolicyDisabled();
    error SupplyCapExceeded();
    error AuthorizationExpired();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizerChanged(address indexed previousAuthorizer, address indexed nextAuthorizer);
    event PolicyConfigured(bytes32 indexed policyId, uint256 cap, bool enabled);
    event ConversionMinted(
        bytes32 indexed policyId, bytes32 indexed nullifier, address indexed recipient,
        uint256 amount, bytes32 proofCommitment, bytes32 provenanceCommitment, uint64 palette
    );

    constructor(address authorizer_, uint256 maxSupply_) {
        if (block.chainid != 11155111) revert SepoliaOnly();
        if (authorizer_ == address(0) || maxSupply_ == 0) revert InvalidInput();
        administrator = msg.sender;
        authorizer = authorizer_;
        maxSupply = maxSupply_;
    }

    modifier onlyAdministrator() {
        if (msg.sender != administrator) revert Unauthorized();
        _;
    }

    function setAuthorizer(address next) external onlyAdministrator {
        if (next == address(0)) revert InvalidInput();
        emit AuthorizerChanged(authorizer, next);
        authorizer = next;
    }

    function configurePolicy(bytes32 policyId, uint256 cap, bool enabled) external onlyAdministrator {
        if (policyId == bytes32(0) || cap == 0 || cap > maxSupply || cap < policies[policyId].minted) revert InvalidInput();
        Policy storage p = policies[policyId];
        p.cap = cap;
        p.enabled = enabled;
        emit PolicyConfigured(policyId, cap, enabled);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
    }

    function authorizationDigest(Conversion calldata c) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            CONVERSION_TYPEHASH, c.policyId, c.nullifier, c.proofCommitment,
            c.provenanceCommitment, c.recipient, c.amount, c.expiresAt, c.palette
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Open relayer entry point. Only the configured proof-verifier's signed
    ///         authorization can mint. The signature commits to every public output.
    function mintWithAuthorization(Conversion calldata c, bytes calldata signature) external {
        if (c.policyId == bytes32(0) || c.nullifier == bytes32(0) ||
            c.proofCommitment == bytes32(0) || c.provenanceCommitment == bytes32(0) ||
            c.recipient == address(0) || c.amount == 0) revert InvalidInput();
        if (spentNullifiers[c.nullifier]) revert AlreadySpent();
        if (c.expiresAt <= block.timestamp || c.expiresAt > block.timestamp + 1 days) revert AuthorizationExpired();
        Policy storage p = policies[c.policyId];
        if (!p.enabled) revert PolicyDisabled();
        if (c.amount > maxSupply - totalSupply || c.amount > p.cap - p.minted) revert SupplyCapExceeded();
        uint256[4] memory parts = _parts(c.palette);
        address recovered = _recover(authorizationDigest(c), signature);
        if (recovered != authorizer) revert InvalidSignature();

        spentNullifiers[c.nullifier] = true;
        p.minted += c.amount;
        totalSupply += c.amount;
        balanceOf[c.recipient] += c.amount;
        uint256 assigned;
        for (uint256 i; i < 3; ++i) {
            uint256 share = (c.amount * parts[i]) / BPS;
            mixtures[c.recipient][i] += share;
            assigned += share;
        }
        mixtures[c.recipient][3] += c.amount - assigned;
        emit Transfer(address(0), c.recipient, c.amount);
        emit ConversionMinted(c.policyId, c.nullifier, c.recipient, c.amount, c.proofCommitment, c.provenanceCommitment, c.palette);
    }

    function _parts(uint64 palette) internal pure returns (uint256[4] memory parts) {
        parts[0] = uint16(palette >> 48);
        parts[1] = uint16(palette >> 32);
        parts[2] = uint16(palette >> 16);
        parts[3] = uint16(palette);
        if (parts[0] + parts[1] + parts[2] + parts[3] != BPS) revert InvalidInput();
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) == 0 || uint256(s) > SECP256K1_HALF_ORDER) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
            emit Approval(from, msg.sender, allowed - value);
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Conserves both token balances and four-channel provenance through
    ///         proportionate moves. Residual wei are allocated to channels with capacity.
    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0) || to == address(0)) revert InvalidInput();
        uint256 oldBalance = balanceOf[from];
        if (oldBalance < value) revert NotEnoughBalance();
        if (value != 0 && from != to) {
            uint256[4] memory moved;
            uint256 assigned;
            for (uint256 i; i < 4; ++i) {
                moved[i] = (mixtures[from][i] * value) / oldBalance;
                assigned += moved[i];
            }
            uint256 dust = value - assigned; // At most three smallest units.
            for (uint256 i; i < 4 && dust != 0; ++i) {
                uint256 available = mixtures[from][i] - moved[i];
                uint256 extra = available < dust ? available : dust;
                moved[i] += extra;
                dust -= extra;
            }
            assert(dust == 0);
            for (uint256 i; i < 4; ++i) {
                mixtures[from][i] -= moved[i];
                mixtures[to][i] += moved[i];
            }
            balanceOf[from] = oldBalance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function compositionOf(address wallet) external view returns (uint256[4] memory) {
        return mixtures[wallet];
    }
}

/// @notice Opt-in PUBLIC claim NFTs only: opaque commitments, no evidence text.
/// @dev Real private credentials can exist without a public NFT. The NFT is not
///      proof that a subject passed an assessment: independent issuer trust is needed.
contract AttestClaims {
    string public constant name = "Attest Public Claims (testnet)";
    string public constant symbol = "ATTEST-CLAIM";
    address public immutable administrator;
    uint256 public nextId = 1;
    struct Claim { address issuer; bytes32 commitment; bytes32 scope; uint64 expiresAt; bool revoked; }
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public issuers;
    mapping(bytes32 => bool) public usedCommitments;
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Locked(uint256 indexed id);
    event ClaimIssued(uint256 indexed id, address indexed issuer, bytes32 commitment, bytes32 scope);
    event ClaimRevoked(uint256 indexed id);
    error Unauthorized(); error InvalidInput(); error NonTransferable(); error NotFound();
    constructor() {
        if (block.chainid != 11155111) revert InvalidInput();
        administrator = msg.sender;
    }
    function configureIssuer(address issuer, bool allowed) external {
        if (msg.sender != administrator) revert Unauthorized();
        if (issuer == address(0)) revert InvalidInput();
        issuers[issuer] = allowed;
    }
    function issue(address subject, bytes32 commitment, bytes32 scope, uint64 expiresAt) external returns (uint256 id) {
        if (!issuers[msg.sender]) revert Unauthorized();
        if (subject == address(0) || commitment == bytes32(0) || scope == bytes32(0) ||
            expiresAt <= block.timestamp || usedCommitments[commitment]) revert InvalidInput();
        usedCommitments[commitment] = true;
        id = nextId++;
        claims[id] = Claim(msg.sender, commitment, scope, expiresAt, false);
        owners[id] = subject;
        balanceOf[subject]++;
        emit Transfer(address(0), subject, id);
        emit Locked(id);
        emit ClaimIssued(id, msg.sender, commitment, scope);
    }
    function revoke(uint256 id) external {
        if (owners[id] == address(0)) revert NotFound();
        Claim storage c = claims[id];
        if (c.issuer != msg.sender) revert Unauthorized();
        if (c.revoked) revert InvalidInput();
        c.revoked = true;
        emit ClaimRevoked(id);
    }
    function isActive(uint256 id) external view returns (bool) {
        return owners[id] != address(0) && !claims[id].revoked && claims[id].expiresAt > block.timestamp;
    }
    function ownerOf(uint256 id) public view returns (address) {
        address owner = owners[id];
        if (owner == address(0)) revert NotFound();
        return owner;
    }
    function locked(uint256 id) external view returns (bool) { ownerOf(id); return true; }
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0xb45a3c0e;
    }
    function approve(address, uint256) external pure { revert NonTransferable(); }
    function setApprovalForAll(address, bool) external pure { revert NonTransferable(); }
    function getApproved(uint256 id) external view returns (address) { ownerOf(id); return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure { revert NonTransferable(); }
    function safeTransferFrom(address, address, uint256) external pure { revert NonTransferable(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert NonTransferable(); }
}

library AttestText {
    function decimal(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 n = value;
        uint256 digits;
        while (n != 0) { ++digits; n /= 10; }
        bytes memory result = new bytes(digits);
        while (value != 0) {
            result[--digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(result);
    }
    function base64(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        bytes memory out = new bytes(4 * ((data.length + 2) / 3));
        uint256 j;
        for (uint256 i; i < data.length; i += 3) {
            uint256 chunk = uint256(uint8(data[i])) << 16;
            if (i + 1 < data.length) chunk |= uint256(uint8(data[i + 1])) << 8;
            if (i + 2 < data.length) chunk |= uint256(uint8(data[i + 2]));
            out[j++] = alphabet[(chunk >> 18) & 63];
            out[j++] = alphabet[(chunk >> 12) & 63];
            out[j++] = i + 1 < data.length ? alphabet[(chunk >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < data.length ? alphabet[chunk & 63] : bytes1("=");
        }
        return string(out);
    }
}

/// @notice One opt-in soulbound artwork per wallet. Metadata is rendered from
///         its LIVE ERC-20 balance and four-channel provenance composition.
/// @dev This artwork is about holdings, not proof of professional qualification.
contract AttestPassport {
    using AttestText for uint256;
    string public constant name = "Attest Living Economic Passport (testnet)";
    string public constant symbol = "ATTEST-PASS";
    AttestToken public immutable token;
    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 indexed tokenId);
    event MetadataUpdate(uint256 indexed tokenId);
    error NonTransferable(); error InvalidInput(); error NotFound();
    constructor(address token_) {
        if (block.chainid != 11155111 || token_ == address(0)) revert InvalidInput();
        token = AttestToken(token_);
    }
    function passportId(address holder) public pure returns (uint256) { return uint256(uint160(holder)); }
    function claim() external returns (uint256 id) {
        id = passportId(msg.sender);
        if (owners[id] != address(0)) revert InvalidInput();
        owners[id] = msg.sender;
        balanceOf[msg.sender] = 1;
        emit Transfer(address(0), msg.sender, id);
        emit Locked(id);
    }
    function refresh(address holder) external {
        uint256 id = passportId(holder);
        if (owners[id] == address(0)) revert NotFound();
        emit MetadataUpdate(id);
    }
    function ownerOf(uint256 id) public view returns (address) {
        address owner = owners[id];
        if (owner == address(0)) revert NotFound();
        return owner;
    }
    function locked(uint256 id) external view returns (bool) { ownerOf(id); return true; }
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd ||
            id == 0x5b5e139f || id == 0xb45a3c0e || id == 0x49064906;
    }
    function approve(address, uint256) external pure { revert NonTransferable(); }
    function setApprovalForAll(address, bool) external pure { revert NonTransferable(); }
    function getApproved(uint256 id) external view returns (address) { ownerOf(id); return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure { revert NonTransferable(); }
    function safeTransferFrom(address, address, uint256) external pure { revert NonTransferable(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert NonTransferable(); }

    function tokenURI(uint256 id) external view returns (string memory) {
        address holder = ownerOf(id);
        uint256 balance = token.balanceOf(holder);
        uint256[4] memory channels = token.compositionOf(holder);
        string[4] memory colors = ["#40a9db", "#936fd6", "#efbd59", "#4ac1a7"];
        bytes memory stripes;
        uint256 x = 20;
        for (uint256 i; i < 4; ++i) {
            uint256 width = balance == 0 ? 0 : i == 3 ? 360 - (x - 20) : channels[i] * 360 / balance;
            stripes = abi.encodePacked(stripes, "<rect x='", x.decimal(), "' y='20' width='", width.decimal(),
                "' height='300' fill='", colors[i], "'/>");
            x += width;
        }
        bytes memory svg = abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>",
            "<rect width='400' height='400' fill='#101c30'/>", stripes,
            "<rect x='20' y='20' width='360' height='300' fill='none' stroke='#fff' stroke-opacity='.4'/>",
            "<rect x='0' y='320' width='400' height='80' fill='#101c30'/>",
            "<text x='20' y='351' font-family='monospace' font-size='18' fill='white'>ATTEST / ECONOMIC</text>",
            "<text x='20' y='378' font-family='monospace' font-size='15' fill='#b8d0e1'>",
            (balance / 1e18).decimal(), " ATTEST</text></svg>"
        );
        string memory image = string.concat("data:image/svg+xml;base64,", AttestText.base64(svg));
        bytes memory metadata = abi.encodePacked(
            '{"name":"Attest Economic Passport #', id.decimal(),
            '","description":"Experimental, public portrayal of ATTEST holdings. Not a qualification, identity verification, or financial guarantee.",',
            '"image":"', image, '"}'
        );
        return string.concat("data:application/json;base64,", AttestText.base64(metadata));
    }
}
