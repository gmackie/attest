// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Permissionless FICTIONAL institution playground, Sepolia only.
/// @dev Holders register self-service demo claims. No real issuer authority or on-chain ZK verification.
contract DemoJourneyRegistry {
    struct Record { bytes32 content; bytes32 holderKey; uint64 validUntil; bool revoked; }
    mapping(address => mapping(bytes32 => mapping(uint8 => Record))) public records;
    mapping(address => mapping(bytes32 => bool)) public receipts;
    event DemoCredential(address indexed holder, bytes32 indexed journey, uint8 institution, bytes32 content, bytes32 holderKey, uint64 validUntil);
    event DemoRevoked(address indexed holder, bytes32 indexed journey, uint8 institution);
    event DemoReceipt(address indexed holder, bytes32 indexed request, bytes32 proofCommitment);
    error InvalidInput(); error AlreadyUsed(); error SepoliaOnly();
    constructor() { if (block.chainid != 11155111) revert SepoliaOnly(); }
    function profile() external pure returns (string memory) { return "attest.fictional.contractor.v1"; }
    function grant(bytes32 journey, uint8 institution, bytes32 content, bytes32 holderKey, uint64 validUntil) external {
        if (journey == bytes32(0) || institution > 2 || content == bytes32(0) || holderKey == bytes32(0) || validUntil <= block.timestamp || validUntil > block.timestamp + 366 days) revert InvalidInput();
        if (records[msg.sender][journey][institution].content != bytes32(0)) revert AlreadyUsed();
        records[msg.sender][journey][institution] = Record(content, holderKey, validUntil, false);
        emit DemoCredential(msg.sender, journey, institution, content, holderKey, validUntil);
    }
    function revoke(bytes32 journey, uint8 institution) external {
        Record storage r = records[msg.sender][journey][institution];
        if (r.content == bytes32(0) || r.revoked) revert InvalidInput();
        r.revoked = true;
        emit DemoRevoked(msg.sender, journey, institution);
    }
    /// @notice A holder-recorded demonstration receipt, NOT a verifier approval.
    function recordReceipt(bytes32 request, bytes32 proofCommitment) external {
        if (request == bytes32(0) || proofCommitment == bytes32(0)) revert InvalidInput();
        if (receipts[msg.sender][request]) revert AlreadyUsed();
        receipts[msg.sender][request] = true;
        emit DemoReceipt(msg.sender, request, proofCommitment);
    }
}
