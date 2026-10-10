// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
/// @notice Sepolia-only, immutable-authority registry for one fictional industry.
/// @dev Authenticates institutions; private proof verification remains off-chain.
contract IndustryRegistry {
    struct Record { bytes32 content; bytes32 holderKey; uint64 validUntil; bool revoked; }
    bytes32 public profile;
    address[6] public institutions;
    bytes32[5] public credentialKeys;
    mapping(address => mapping(bytes32 => mapping(uint8 => Record))) public records;
    mapping(address => mapping(bytes32 => bool)) public receipts;
    event CredentialGranted(address indexed holder, bytes32 indexed journey, uint8 institution, bytes32 content, bytes32 holderKey, uint64 validUntil);
    event CredentialRevoked(address indexed holder, bytes32 indexed journey, uint8 institution);
    event DecisionRecorded(address indexed holder, bytes32 indexed request, bytes32 proofCommitment, address verifier);
    error InvalidInput(); error Unauthorized(); error AlreadyUsed(); error SepoliaOnly();
    constructor(bytes32 profile_, address[6] memory wallets, bytes32[5] memory keys) payable {
        if(block.chainid!=11155111)revert SepoliaOnly();
        if(profile_==bytes32(0))revert InvalidInput(); profile=profile_;
        for(uint8 i=0;i<6;i++){if(wallets[i]==address(0))revert InvalidInput();for(uint8 j=0;j<i;j++)if(wallets[i]==wallets[j])revert InvalidInput();institutions[i]=wallets[i];}
        for(uint8 i=0;i<5;i++){if(keys[i]==bytes32(0))revert InvalidInput();credentialKeys[i]=keys[i];}
        if(msg.value>0)_fund();
    }
    function fundInstitutions() external payable {if(msg.value==0)revert InvalidInput();_fund();}
    function _fund() private {uint256 share=msg.value/6;for(uint8 i=0;i<6;i++){(bool ok,)=payable(institutions[i]).call{value:i==5?msg.value-share*5:share}("");if(!ok)revert InvalidInput();}}
    function grant(address holder,bytes32 journey,uint8 institution,bytes32 content,bytes32 holderKey,uint64 validUntil) external {
        if(institution>4||msg.sender!=institutions[institution])revert Unauthorized();
        if(holder==address(0)||journey==bytes32(0)||content==bytes32(0)||holderKey==bytes32(0)||validUntil<=block.timestamp||validUntil>block.timestamp+366 days)revert InvalidInput();
        if(records[holder][journey][institution].content!=bytes32(0))revert AlreadyUsed();
        records[holder][journey][institution]=Record(content,holderKey,validUntil,false);
        emit CredentialGranted(holder,journey,institution,content,holderKey,validUntil);
    }
    function revoke(address holder,bytes32 journey,uint8 institution) external {
        if(institution>4||msg.sender!=institutions[institution])revert Unauthorized();
        Record storage r=records[holder][journey][institution];if(r.content==bytes32(0)||r.revoked)revert InvalidInput();r.revoked=true;emit CredentialRevoked(holder,journey,institution);
    }
    function recordDecision(address holder,bytes32 request,bytes32 proofCommitment) external {
        if(msg.sender!=institutions[5])revert Unauthorized();
        if(holder==address(0)||request==bytes32(0)||proofCommitment==bytes32(0))revert InvalidInput();
        if(receipts[holder][request])revert AlreadyUsed();receipts[holder][request]=true;emit DecisionRecorded(holder,request,proofCommitment,msg.sender);
    }
}
