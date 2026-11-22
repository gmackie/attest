# Presentation receipts verified on-chain (experimental, testnet)

`PresentationReceipts` (ATTE-25) records a receipt for an `attest.proof-request/v1` digest only after the contract
itself verifies a Groth16 proof against an issuer's live `PrivateClaimRoots` root. It resolves review item AT-08
(`specs/economy-security-review.md`) for this one statement shape. The circuit, verifier, contract and ceremony
tooling are **not audited**. The only keys that exist are synthetic test keys, so nothing here is production ZK.

Sources:
- `zk/circuits/presentation-receipt-v1.circom` (depth-8 Poseidon tree, 7,758 constraints with circom2 0.2.23)
- `contracts/src/PresentationReceipts.sol`
- `packages/chain-evm/src/receipts.ts`
- tests: `packages/chain-evm/test/presentation-receipts.test.ts`

## The statement

Public inputs, in order:

| # | Signal | Meaning |
| --- | --- | --- |
| 0 | `issuer` | Issuer address. Its live root is read from `PrivateClaimRoots`. |
| 1 | `root` | Must equal `activeRoot(issuer)` at the receipt block, with `issuers(issuer) == true`. |
| 2, 3 | `requestDigestHi`, `requestDigestLo` | The 256-bit request digest split into two 128-bit limbs. The split is injective and both limbs are below the BN254 field, so no reduction collisions occur. |
| 4 | `receiptContract` | Must equal the receiving contract's address. |
| 5 | `chainId` | Must equal `block.chainid`. |
| 6 | `attribute` | `sha256("attest.receipt-attribute/v1\n" + name) >> 8`, for example `cgl.each-occurrence-usd`. |
| 7 | `threshold` | Public minimum, 64 bits. |
| 8 | `validThrough` | The leaf's `validUntil` is at least this; the contract requires `validThrough >= block.timestamp`. |
| 9 | `subjectBinding` | `Poseidon(subjectId, subjectSalt, hi, lo)`, where `subjectId = sha256("attest.receipt-subject/v1\n" + credentialSubject) >> 8`. |
| 10 | `nullifier` | `Poseidon(claimSecret, hi, lo, 81601)`. |

The holder privately knows a leaf
`Poseidon(claimSecret, holderSecret, subjectId, attribute, value, validUntil, issuer)` and its path in the issuer's
tree. The circuit proves:
- the leaf is in `root`;
- `value >= threshold`, after both are range-checked to 64 bits so field wraparound cannot satisfy the comparison;
- `validUntil >= validThrough`;
- the subject binding and nullifier are derived from the same leaf secrets and request limbs.

All other values stay private: the value, the secrets, the subject and the path.

## What the contract enforces

`submitReceipt(a, b, c, signals)` checks the following, in order:
1. Field and range bounds.
2. Contract address and chain ID.
3. Claim freshness.
4. That the issuer is authorized and the root is its live root.
5. That the request digest has no receipt yet, and the nullifier is unused.
6. The Groth16 proof.

Only then does it store `{issuer, blockNumber, validThrough, root, nullifier, attribute, threshold, subjectBinding}`
under the digest and emit `ReceiptRecorded`. The contract allows one receipt per request. A second claim, even a
valid one, cannot add another receipt to the same request. The same claim can answer a different request, and gets
an unlinkable nullifier there. The constructor refuses chain ID 1.

The tests cover these cases:
- a valid receipt is accepted;
- a stale (replaced) root fails;
- the issuer is revoked;
- either digest limb is altered;
- threshold, attribute or binding are tampered with;
- an honest proof is bound to another contract or chain;
- a replayed proof;
- a second claim for the same request.

These witnesses cannot be proved at all:
- a value below the threshold;
- the wrong attribute;
- another subject;
- an expired claim.

## What a receipt does not prove

- **The digest's preimage.** The circuit does not open sha256. It cannot show that the request digest asked for
  this attribute, threshold, issuer or subject. A consumer must compare the stored receipt with its own pending
  request using `receiptSatisfies`, which checks the accepted issuers, attribute, minimum, subject binding and
  validity. The holder discloses `subjectSalt` to the consumer off-chain.
- **Real-world truth.** A receipt proves membership in a root that an approved issuer published. Issuers can
  publish bad roots, and the `PrivateClaimRoots` administrator chooses the issuers.
- **Freshness beyond the receipt block.** The root was live at `blockNumber`. Later revocation does not erase the
  receipt. Consumers should require a recent block and a settled one: read it through `ChainStatusReader`, at a
  finalized or N-confirmation block with two agreeing RPCs.
- **Holder possession.** Knowing the leaf secrets is enough to prove. Nothing binds the proof to a holder key, so
  a shared or stolen witness can be used.
- **Request uniqueness across contracts.** Each `PresentationReceipts` deployment has its own uniqueness map.
  The proof is bound to one contract, so a proof cannot be replayed into another deployment. A holder who holds
  valid claims can still prove separately for another deployment.
- **Griefing.** A holder can record a receipt for a digest at a lower threshold than the request wanted, and that
  consumes the digest. The consumer's comparison catches the mismatch, and the PEP should issue a new request.

Public metadata includes:
- the issuer;
- the root;
- the attribute;
- the threshold;
- the timing;
- the digest limbs;
- the salted subject binding;
- the submitting address.

That metadata correlates activity. The salt prevents anyone without it from testing guessed subjects against the
binding.

## Relationship to other Attest records

- **`attest.verification-result/v1`** (`specs/proof-requests.md`) is a verifier's signed assertion, made over a
  GPC proof that it checked off-chain. A receipt replaces that trust in the verifier with on-chain Groth16
  verification, for this statement only. The two can coexist: a PEP may accept either one, under explicitly
  different trust policies. A receipt carries no verifier signature.
- **`AssuranceAnchor.recordVerification`** still records the caller's decision without verifying anything (AT-08).
  It remains for profiles that have no circuit.
- **`DecisionLogAnchor`** (`specs/decision-log-anchoring.md`) anchors Gatekeeper's decision log. A Gatekeeper
  decision that relied on a receipt can cite the receipt in its decision record, for example as
  `chainId:contract:requestDigest`. The log then commits to the evidence, and the receipt contract is where that
  evidence is checked. Neither contract reads the other.

## Trusted setup

Groth16 needs a circuit-specific phase 2. The tooling for a multi-party phase 2 is in `zk/ceremony/`
(`README.md` there has the runbook). No real ceremony has happened. The fixture keys come from
`zk/scripts/build-test-fixture.mjs --synthetic-test-only`, and production paths refuse them. A deployment must
pin the verifier bytecode and the verification-key hash to a finalised `CEREMONY` transcript, and it needs the
external audit listed in `specs/production-readiness.md`.
