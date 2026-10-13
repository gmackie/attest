# Private claim conversion and testnet $ATTEST — experimental slice

**Status: unreviewed Sepolia-only research, synthetic claims, NOT public issuance.**
The ERC-20 has no redemption rights, dollar backing, yield, insurance coverage or
objective representation of a person's trustworthiness. Its name and token
economics are placeholders. There is no mainnet deployment.

## Design

The protocol distinguishes three objects:

1. An issuer-signed **private claim** (POD) and an optional public,
   non-transferable `AttestClaims` ERC-721 containing an opaque commitment.
   The public NFT is voluntary: it does not make private credential data public
   or supersede the issuer's actual signed credential.
2. **ATTEST** — a Sepolia-only ERC-20 minted in fixed, policy-defined quantities
   after successful verification. It represents a historical conversion
   entitlement; it is *not* proof the current token holder earned the claim.
3. A non-transferable **economic passport** ERC-721, minted voluntarily once
   per wallet. `tokenURI` renders a live SVG based on the wallet's ERC-20
   balance and four transferable provenance channels. It is explicitly NOT
   a professional qualification or global reputation score.

## Actual prototype trust boundary

```text
holder's private POD
  -> browser GPC proof of signed schema, exact claim ID / opaque event,
     sufficient hidden score and unexpired date
  -> private verifier bridge checks the proof, fresh anchored status,
     recognized issuer authority and holder-signed exact mint intent
  -> bridge signs policy-fixed EIP-712 authorization
  -> Sepolia AttestToken checks bridge signature, domain, expiry,
     policy cap and permanent entitlement nullifier
  -> mints ERC-20 + provenance mixture; wallet may claim portrait ERC-721
```

**The Solidity minter does not verify GPC/Groth16.** It trusts its configured
off-chain proof-verifier's EIP-712 signature. This is a deliberately explicit
bridge. The `AssuranceAnchor` and `WorkspaceRegistry` reference contracts
also do not independently verify a ZK proof. Swapping them for a signed receipt
without this trust statement would be misleading.

`packages/demo/src/conversion.ts` implements genuine proof preparation,
independent verification, holder consent, domain bindings and a verifier-port
interface. It does **not** host a secure signer or a production status service.
Test fixtures supply a synthetic credential snapshot and trust root. A real
deployment would need an authenticated, independent, finality-aware registry
reader, a protected signing key, rate limits, review of jurisdiction/scope,
auditable receipts and fraud dispute operations.

## Exactly what is private?

Hidden from the *public mint transaction*: the raw signed POD, score,
underlying evidence, full issuer credentials and proof witness.

Visible on-chain: EVM sender, recipient, policy ID, mint amount, provenance
commitment, palette, proof commitment, unique redemption nullifier, timestamps
and ordinary transfers. This is **not** an anonymous token: address analysis,
amount/rarity inference and issuer correlation remain possible.

The trusted verifier sees claim ID, POD content ID, issuer signing key, subject
binding, holder key, high-entropy event commitment, proof transcript and
redemption destination. It verifies hidden score through GPC. Consequently
this stage provides **private inputs from public observers**, NOT anonymity
against the verification bridge or its issuer/status infrastructure.

A voluntary public Claim NFT makes holder/issuer/commitment/time associations
visible. Never automatically mint it for every private credential. Public
claim NFTs must not encode raw medical, insurance, educational, or identity data.

## Conversion rules

- The accepted conversion policy (`id`, `scope`, minimum score, raw mint
  amount and four-channel palette) is provisioned by the verifier, never
  accepted from the holder as a free-form mint quote.
- The circuit proves a **hidden score >= the fixed minimum**, signed issuer
  schema/context, claim ID, event commitment and valid-through date; the
  bridge maps this Boolean eligibility to a fixed amount. This first slice
  is **one qualifying claim per authorization**, *not* an arbitrary private
  weighted sum across many claims.
- A holder signs the exact intent and proof commitment using its POD signing
  key. Intent includes chain ID 11155111, ERC-20 address, recipient, claim
  identity, entitlement event, policy and one-hour maximum expiry.
- The verifier checks a trusted, fresh credential/status snapshot and
  independent issuer recognition. No caller-supplied self-certified status
  is accepted as authority.
- The EIP-712 voucher binds policy ID, nullifier, proof commitment, provenance
  commitment, recipient, amount, expiry and packed palette to the ERC-20
  contract and chain. The contract rejects high-s/invalid ECDSA signatures.
- The permanently spent nullifier is derived from a **canonical, high-entropy,
  issuer-controlled event commitment**, independent of recipient, contract,
  policy version and presentation challenge. The minter consumes it atomically.
  Issuers must ensure canonical event IDs across reissuance; otherwise two
  distinct signed event identifiers can double-count the same real activity.
- Supply is capped globally and per authorized policy. Revoked/expired
  attestations fail new conversion, but already circulating ERC-20 tokens are
  not silently burned. A claim can remain available as a historical record.
- A trusted verifier can sign bad authorizations if compromised or dishonest,
  subject to remaining on-chain caps. The ERC-20 does *not* attest to the truth
  of the issuer's assertion.

## Four-channel transfer conservation

Every mint includes exactly four integer proportions summing to 10,000 basis
points. `balanceOf(wallet) == sum(compositionOf(wallet))` holds after mint,
transfer and `transferFrom`. A transfer redistributes the sender's mixture
proportionately, allocating residual single-wei rounding to channels with
remaining capacity. Provenance survives transfers as aggregate mixtures,
not as original per-claim identifiers.

An exchange/custodial hot wallet mixes many depositors' provenance. The visual
colors are therefore an *economic lineage illustration*, **not** a guarantee
that the recipient personally performed a qualifying activity.

## Project layout

- `contracts/src/AttestEconomy.sol`: `AttestToken`, `AttestClaims`,
  `AttestPassport`, deliberately self-contained contracts.
- `packages/chain-evm/src/economy.ts`: EIP-712 payload, packing and nullifiers.
- `packages/demo/src/conversion.ts`: private proof preparation, verification
  ports, consent and server-only authorizer adapter.
- `packages/chain-evm/test/economy.test.ts`: Anvil integration tests.
- `packages/demo/test/conversion.test.ts`: real GPC proof and negative tests.
- `apps/web/src/EconomyLab.tsx`: *local, fictional* demonstration, no real mint.

Run `pnpm check`. The contract build emits Sepolia-ready artifacts under
`contracts/artifacts/` and web reference artifacts under
`apps/web/public/contracts/`. The existing mainnet adapter gate is unchanged.
Never deploy test issuer keys, front-end signing keys or synthetic authority
fixtures as real production verifiers.

## Threats and unresolved production work

- **Issuer farming/collusion:** a signed claim establishes signer control, not
  truth of underlying experience. Independent authority enrollment,
  event uniqueness, claims disputes and sanctions are essential.
- **Subject binding and identity recovery:** nontransferable NFTs don't prevent
  sale of the signing key or wallet. A claimed wallet is not a verified human.
- **Privacy leaks:** linkable content IDs, predictable events, stable nullifiers,
  addresses, display attributes and status queries can correlate personas.
  Issuer event commitments require high entropy. Consider encrypted or
  blinded status reads and scoped release policies.
- **Signature service:** bridge key compromise can consume a policy's remaining
  supply. Use governance-separated quotas, HSM/MPC, rotation, live monitoring
  and an emergency stop before real deployment.
- **Revocation races/reorgs:** a fresh off-chain status check may become stale
  before the voucher executes. Limit voucher lifetime further, pin finalized
  blocks, and consider an on-chain status constraint.
- **Proof backend:** POD/GPC, trusted proving artifacts and the custom verifier
  need independent cryptographic review. This demo uses real GPC checks, not a
  custom Groth16 circuit proving an arbitrary amount. On-chain verification
  would require a reviewed verifier and public inputs with binding to policy
  and spend-once nullifiers.
- **Quantity:** future multi-claim conversions require distinctness,
  deduplicated event IDs and overflow-safe verified arithmetic *inside a
  compatible circuit*. Adding amounts in TypeScript after a generic proof
  would not suffice.
- **Tokens and law:** issuance based on achievements or backing risks may
  carry securities, payments, consumer protection, insurance, employment,
  privacy or discrimination obligations. Never market as a factual global
  'trust price' or deploy real-money mechanisms without appropriate review.
- **Admin/key lifetime:** prototype authorizer/policy administrator is a
  single address. Needs multisig, key rotation, pause controls, independent
  audit and credible governance before any public launch.

The next security milestone should be a native, publicly verifiable conversion
circuit with immutable policy circuit IDs, issuer/status roots, entitlement
nullifiers computed *inside* the proof and amount constrained inside the proof.
That would eliminate the trusted verifier as a minting authority while preserving
private evidence. Until then, describe the current system as a **proof-verified
authorization bridge**, not trustless ZK issuance.
