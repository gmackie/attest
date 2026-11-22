pragma circom 2.1.6;

// Experimental presentation receipt (ATTE-25). NOT AUDITED. Extends the
// private-conversion-v1 pattern: the holder proves that an issuer-committed
// claim leaf belongs to the issuer's live PrivateClaimRoots root and that the
// leaf's hidden value meets a PUBLIC threshold, bound to one
// attest.proof-request/v1 digest, one receipt contract and one chain.
//
// What it does NOT prove: that the issuer's data is true, that the request
// digest commits to this attribute/threshold/subject (sha256 preimages are
// not opened in-circuit; the consumer compares them off-chain), or anything
// about the holder's identity beyond knowledge of the leaf secrets.
// Dependencies: circomlib 2.0.5 (poseidon, comparators, bitify).

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

template PresentationReceiptV1(depth) {
    // Eleven public inputs, in the exact order of the main component.
    signal input issuer;           // issuer address (160 bits)
    signal input root;             // issuer's live Poseidon root
    signal input requestDigestHi;  // sha256(request payload) bits 255..128
    signal input requestDigestLo;  // sha256(request payload) bits 127..0
    signal input receiptContract;  // PresentationReceipts address (160 bits)
    signal input chainId;          // EVM chain ID (64 bits)
    signal input attribute;        // field-reduced attribute identifier
    signal input threshold;        // public minimum (64 bits)
    signal input validThrough;     // claim must be valid at least until here
    signal input subjectBinding;   // Poseidon(subjectId, subjectSalt, hi, lo)
    signal input nullifier;        // Poseidon(claimSecret, hi, lo, 81601)

    // Private witness.
    signal input claimSecret;      // issuer-assigned, high entropy
    signal input holderSecret;     // committed by the issuer for this holder
    signal input subjectId;        // field-reduced credential subject
    signal input subjectSalt;      // holder-chosen, shared with the consumer
    signal input value;            // hidden value, e.g. coverage amount
    signal input validUntil;       // claim validity committed in the leaf
    signal input siblings[depth];
    signal input directions[depth];

    // Bound every numeric public input and the hidden value so that the
    // comparators cannot be satisfied through field wraparound. The 128-bit
    // limbs make the digest split injective; the address bounds pin the
    // contract/issuer domains (and keep these public inputs constrained).
    component hiBits = Num2Bits(128);
    hiBits.in <== requestDigestHi;
    component loBits = Num2Bits(128);
    loBits.in <== requestDigestLo;
    component issuerBits = Num2Bits(160);
    issuerBits.in <== issuer;
    component contractBits = Num2Bits(160);
    contractBits.in <== receiptContract;
    component chainBits = Num2Bits(64);
    chainBits.in <== chainId;
    component thresholdBits = Num2Bits(64);
    thresholdBits.in <== threshold;
    component valueBits = Num2Bits(64);
    valueBits.in <== value;
    component throughBits = Num2Bits(64);
    throughBits.in <== validThrough;
    component untilBits = Num2Bits(64);
    untilBits.in <== validUntil;

    // value >= threshold, validUntil >= validThrough.
    component meets = GreaterEqThan(64);
    meets.in[0] <== value;
    meets.in[1] <== threshold;
    meets.out === 1;
    component fresh = GreaterEqThan(64);
    fresh.in[0] <== validUntil;
    fresh.in[1] <== validThrough;
    fresh.out === 1;

    component claimZero = IsZero();
    claimZero.in <== claimSecret;
    claimZero.out === 0;
    component holderZero = IsZero();
    holderZero.in <== holderSecret;
    holderZero.out === 0;

    // Issuer-committed leaf. The attribute and subject are inside the leaf,
    // so a value issued for another attribute or subject cannot satisfy this
    // statement.
    component leaf = Poseidon(7);
    leaf.inputs[0] <== claimSecret;
    leaf.inputs[1] <== holderSecret;
    leaf.inputs[2] <== subjectId;
    leaf.inputs[3] <== attribute;
    leaf.inputs[4] <== value;
    leaf.inputs[5] <== validUntil;
    leaf.inputs[6] <== issuer;

    signal levels[depth + 1];
    levels[0] <== leaf.out;
    component hashers[depth];
    for (var i = 0; i < depth; i++) {
        directions[i] * (directions[i] - 1) === 0;
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== levels[i] + directions[i] * (siblings[i] - levels[i]);
        hashers[i].inputs[1] <== siblings[i] + directions[i] * (levels[i] - siblings[i]);
        levels[i + 1] <== hashers[i].out;
    }
    root === levels[depth];

    // Request-scoped subject binding. Without the salt, anyone could test
    // guessed subjects against the public digest limbs.
    component binding = Poseidon(4);
    binding.inputs[0] <== subjectId;
    binding.inputs[1] <== subjectSalt;
    binding.inputs[2] <== requestDigestHi;
    binding.inputs[3] <== requestDigestLo;
    subjectBinding === binding.out;

    // Per-(claim, request) nullifier: unlinkable across requests, stable for
    // one request. The contract additionally allows one receipt per request.
    component serial = Poseidon(4);
    serial.inputs[0] <== claimSecret;
    serial.inputs[1] <== requestDigestHi;
    serial.inputs[2] <== requestDigestLo;
    serial.inputs[3] <== 81601;
    nullifier === serial.out;
}

component main { public [
    issuer, root, requestDigestHi, requestDigestLo, receiptContract, chainId,
    attribute, threshold, validThrough, subjectBinding, nullifier
] } = PresentationReceiptV1(8);
