pragma circom 2.1.6;

// Experimental single-claim private conversion proof. Only the approved issuer
// may publish the Merkle root. This circuit does not establish real-world truth.
// All non-public values remain private except the defined derived outputs.
// Dependencies: circomlib 2.0.5 (poseidon, comparators, bitify).

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

template PrivateConversionV1() {
    // Eleven public inputs, in the exact order specified in the main call.
    signal input issuer;
    signal input root;
    signal input nullifier;
    signal input recipient;
    signal input token;
    signal input chainId;
    signal input expiresAt;
    signal input amount;
    signal input palette;
    signal input policyId;
    signal input provenance;

    // Private witness belonging to an issuer-published active-claims root.
    signal input eventSecret;
    signal input holderSecret;
    signal input score;
    signal input validUntil;
    signal input siblings[4];
    signal input directions[4];

    // Proof binds the exact policy and token economics. The Solidity verifier
    // additionally pins the expected token, recipient, chain and active root.
    policyId === 1;
    chainId === 11155111;
    amount === 200000000000000000000;
    palette === 1125912791875585000;

    // Bound numeric domains to avoid field-arithmetic wraparound. No credit
    // comes from negative/overflowing scores or timestamps.
    component scoreBits = Num2Bits(14);
    scoreBits.in <== score;
    component threshold = LessThan(14);
    threshold.in[0] <== score;
    threshold.in[1] <== 700;
    threshold.out === 0;
    component scoreMax = LessThan(14);
    scoreMax.in[0] <== score;
    scoreMax.in[1] <== 10001;
    scoreMax.out === 1;

    component dateBits = Num2Bits(64);
    dateBits.in <== validUntil;
    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiresAt;
    component validAtClaim = LessThan(64);
    validAtClaim.in[0] <== validUntil;
    validAtClaim.in[1] <== expiresAt;
    validAtClaim.out === 0;

    component issuerBits = Num2Bits(160);
    issuerBits.in <== issuer;
    component recipientBits = Num2Bits(160);
    recipientBits.in <== recipient;
    component tokenBits = Num2Bits(160);
    tokenBits.in <== token;

    component isEventZero = IsZero();
    isEventZero.in <== eventSecret;
    isEventZero.out === 0;
    component isHolderZero = IsZero();
    isHolderZero.in <== holderSecret;
    isHolderZero.out === 0;

    // Leaf binds event, original holder, minimum eligibility evidence,
    // validity and issuer. Authenticity comes from the issuer's current root.
    component leaf = Poseidon(5);
    leaf.inputs[0] <== eventSecret;
    leaf.inputs[1] <== holderSecret;
    leaf.inputs[2] <== score;
    leaf.inputs[3] <== validUntil;
    leaf.inputs[4] <== issuer;

    // A simple 16-leaf (depth 4) Poseidon Merkle path. Untrusted witnesses
    // cannot select arbitrarily non-Boolean left/right directions.
    signal levels[5];
    levels[0] <== leaf.out;
    component hashers[4];
    for (var i = 0; i < 4; i++) {
        directions[i] * (directions[i] - 1) === 0;
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== levels[i] + directions[i] * (siblings[i] - levels[i]);
        hashers[i].inputs[1] <== siblings[i] + directions[i] * (levels[i] - siblings[i]);
        levels[i + 1] <== hashers[i].out;
    }
    root === levels[4];

    // IMPORTANT: redemption nullifier does NOT include a receiver, policy,
    // challenge, proof, issuer or wallet address. Changing those cannot
    // reactivate a previously spent, canonical issuer-controlled event.
    component serial = Poseidon(2);
    serial.inputs[0] <== eventSecret;
    serial.inputs[1] <== 81501;
    nullifier === serial.out;

    component origin = Poseidon(2);
    origin.inputs[0] <== eventSecret;
    origin.inputs[1] <== 81502;
    provenance === origin.out;
}

component main { public [
    issuer, root, nullifier, recipient, token, chainId, expiresAt,
    amount, palette, policyId, provenance
] } = PrivateConversionV1();
