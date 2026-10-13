# Security review — $ATTEST testnet economy prototype

**Scope:** PR #4 at 2026-10-13, contracts/AttestEconomy.sol, private
GPC bridge, EIP-712 client, fake local web demo and Anvil integration tests.
**Reviewer:** automated code review; **NOT** a third-party audit or assertion
of cryptographic production security. This review's conclusion is limited to
an experimental Sepolia-only research implementation.

## Findings and disposition

| ID | Risk | Disposition |
| --- | --- | --- |
| AT-01 | **High:** a verifier service which accepted a caller-supplied `ConversionPolicy` could issue arbitrary allowed token quantities/palettes under the same on-chain policy ID, even without a compromised signing key. | **Fixed in PR #4:** a required trusted `resolvePolicy` port must match the supplied policy exactly before proof verification and voucher signing. Added rejection tests for unenrolled and mismatched payout policies. The caller must still implement independent trustworthy policy storage; in-memory demo fixtures are not a real authority. |
| AT-02 | **High:** a leaked EIP-712 authorizer key can spend every configured mint cap. Existing rotation requires administrator intervention and until then all prior signed vouchers remain valid under the key. | **Partially mitigated:** administrator-only `setMintingPaused` stops any mint and preserves unused nullifiers. An admin can rotate the signer or disable policies. **Residual:** centralized signer/admin and unaudited key storage make economic issuance unsafe. |
| AT-03 | **High:** issuer/credential identity and event uniqueness are not established cryptographically by any open, autonomous authority registry. Fake engagements and reissuance with a new event ID can inflate tokens. | **Open:** only synthetic issuers, cap-limited mock economy. Requires authoritative issuer enrollment, an event-ID governance policy, anti-collusion and dispute processes. This is not fixable by a ZK proof alone. |
| AT-04 | **Medium:** issuing/revoking credentials races with off-chain proofs and a one-hour voucher; a credential could be revoked after verification but before mint. | **Open:** off-chain bridge checks fresh reads, but the mint contract cannot independently enforce that the issuer/status state stayed valid. Native on-chain proof with current-root check is required. |
| AT-05 | **Medium:** event commitment, public POD IDs/commitments, visible recipient, palette and mint amount may permit user/persona correlation. | **Open by design in POC:** public Claim NFTs are strictly opt-in. Neither a signature nor a hash of low-entropy inputs guarantees anonymity. Never disclose raw protected fields on-chain. |
| AT-06 | **Medium:** provenance color blending may be mistaken for current holder's competence, qualification, or capital backing. | **Documented:** transferable tokens track aggregate historical economic colors, not subject identity, ongoing validity, or legal/commercial guarantees. Passport describes only holdings. |
| AT-07 | **Medium:** Solidity ERC-20/721 implementations are bespoke, lack extensive fuzzing, pause governance, production ownership recovery and independent audit. | **Open:** contract/unit/Anvil tests establish POC behaviors only. EVM deployed code and toolchain must be audited and pinned. |
| AT-08 | **Medium:** GPC proof is checked **off-chain**; EIP-712 signs the authorization. The EVM cannot distinguish a valid proof from a forged authorization signed by the bridge key. | **Explicit boundary:** native in-circuit verification tracked by issue #5. Do not market the PR as trustless ZK minting. |

## Invariants to retain

- `sum(compositionOf(wallet)) == balanceOf(wallet)` across mint, transfer,
  transferFrom and zero balances. Token supply and per-policy caps never exceed
  their configured limits. Nullifiers are spent in the same transaction as the
  mint, and never recycled on policy upgrades.
- Mint vouchers bind chain ID, verifying token, fixed enrolled policy,
  recipient, amount, expiry, provenance and proof commitment. The verifier
  must independently authenticate every credential, issuer scope, fresh
  status and holder consent, and compare **all** request-controlled inputs.
- A private credential and signed issuer assertion retain their own validity;
  a public Claim ERC-721 is an opt-in display token; the economic ERC-20 does
  not confer qualifications to an acquirer.
- No production or real-money issuance. No mainnet writes. No signing keys in
  browser, public repositories or static web assets.

## Required before any real deployment

1. Complete issue #5: circuit proof over canonical issuer-issued event,
   score, range, holder, currency/subject semantics; a constrained mint amount
   and proof-derived nullifier; on-chain Groth16 verification; live authorized
   issuer/status roots and finality.
2. Separate production signing/status service and governor key lifecycles,
   custody, incident response, emergency pause and monitoring. Multi-party
   key custody and issuer root-change governance.
3. Independent security and cryptographic audit; artifact provenance,
   compiler pinning, static/fuzz tests, formal invariants and third-party
   verification of actual testnet deployment addresses.
4. Privacy/correlation threat tests (including public status NFTs, rare
   credential value distributions and timing analysis), abuse/throttling,
   economic rights, consumer disclosures and relevant legal review.

The PR can be merged as test-only reference code once CI passes. It must not
be used as a signal that issuance is economically backed, objectively measures
trust, is regulatory compliant, or is secure for production.
