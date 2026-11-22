# Mandate status registry (experimental, testnet)

`StatusRegistry` (ATTE-21) is the on-chain counterpart of `@attest/mandates`' in-memory `LocalStatusRegistry`. It
holds digest-bound status for [agent mandates and transaction approvals](agent-mandates.md), so verifiers can check
revocation without trusting the issuer's own status server.

## What is on-chain

Records are keyed by issuer account and status reference: `records[issuer][ref]`. Each record holds:

- `digest`: the document's payload commitment (lowercase SHA-256 of its canonical JSON, as `documentDigest`)
- `status`: `None`, `Active`, `Revoked` or `Superseded`
- `validUntil`: the document's own validity end, in Unix seconds
- `registeredAt` and `changedAt`
- `successor`: the replacing reference, set only when the record is superseded

`ref` is `statusRefId(statusRef)`, defined as `SHA-256("attest.mandate-status/v1\n" || statusRef)`. The readable
reference never reaches the chain, and nor do any mandate fields (subject, tenant, delegate, actions, terms or
money). Public metadata can still be correlated: the issuer's address, the timing of registrations and transitions,
the validity ends and the successor links.

Every transition emits an event: `StatusRegistered(issuer, ref, digest, validUntil)`, `StatusRevoked(issuer, ref)`
and `StatusSuperseded(issuer, ref, successor)`.

## What the contract enforces

- **Issuer-only writes.** An issuer can only write its own namespace (`msg.sender`). A write from any other
  account addresses that account's empty namespace and reverts (`unknown ref`). The same design means nobody can
  front-run an issuer's registration to squat its reference.
- **Registration happens once.** `register(ref, digest, validUntil)` requires a non-zero ref and digest and a
  future `validUntil`. Registering an existing ref reverts (`already registered`), whatever the digest and the
  record's current state, so a revoked record can never be reactivated.
- **Transitions are one-way and terminal.** The only transitions are `Active -> Revoked` (`revoke`) and
  `Active -> Superseded` (`supersede`). Any transition from a non-active record reverts (`not active`).
- **A supersede names its successor.** The successor must be non-zero, differ from the ref, and already be an
  `Active` record of the same issuer (`successor`, `successor not active`). The replacement is registered first.
- **There is no administrator.** An admin able to revoke or reactivate records would be a second authority over
  every issuer's documents. Issuer key loss is bounded instead by the document's own expiry. Issuer key
  compromise is the issuer-key registry's concern: a verifier that stops trusting an issuer account stops reading
  its namespace.
- **Expiry is recorded, not enforced.** Readers compare `validUntil` with the settled block's timestamp.

## TypeScript (`@attest/chain-evm`, `mandate-status.ts`)

### `mandateStatusRegistry`

`mandateStatusRegistry({registry, issuer, reader, writer?, leaseMs?, cacheActive?})` is an Effect 4 service that
mirrors `LocalStatusRegistry`:

- **`register(document)`** returns the digest.
  - It is idempotent for the same digest, including after a revocation, which stays revoked.
  - A ref bound to another digest fails with `status_ref_already_bound`.
- **`revoke(statusRef)`** leaves a record that is not active unchanged. An unknown ref fails with
  `status_ref_unknown`.
- **`supersede(statusRef, successorRef)`** requires a registered, active successor; otherwise it fails with
  `invalid_status_transition`.
- **`read(statusRef, digest, leaseMs?)`** returns a `LiveStatus` or `null`. Chain failures fail with their
  `ChainStatusError` code.
- **`status`** is a `VerificationPorts["status"]` function. Every chain failure rejects with
  `MandateError("status_unavailable")`.

The writer comes from `viemStatusClients`, and its rules are:

- It refuses chain ID 1 (`production_writes_disabled`), as `decisionLogAnchorAdapter` does.
- Before every write, both `viemStatusClients` and the service ask the write RPC for its chain ID
  (`getChainId`). The write is refused if the RPC reports chain 1 (`production_writes_disabled`) or a chain
  other than the declared one (`chain_mismatch`), so a mislabelled client cannot reach mainnet.
- It must match the reader's chain and the configured issuer (`writer_not_issuer`).
- Pre-checks read the latest block. Verifiers never use that path.

### Reads

Reads go through `ChainStatusReader`:

- the snapshot is taken at a settled block: finalized, or N confirmations
- every endpoint must report the same chain ID, block hash and result
- the block hash is checked again after the read, so a reorg in between is detected
- a head older than `maxBlockAgeMs` is refused

`read` returns `null`, never active, in these cases:

- the reference is unknown
- it is bound to another digest
- it is in another issuer's namespace
- its `validUntil` is at or before the settled block's timestamp (`LiveStatus` has no `expired`)

The following fail closed, and the mandate verifier reports them as `status_unavailable`:

- RPC disagreement
- a chain mismatch
- a reorg
- a stale head
- an unavailable endpoint

### `mandateCredentialStatus`

`mandateCredentialStatus(reader, {registry, issuer, ref, digest}, {leaseMs})` returns `@attest/verifier`'s
`CredentialStatus` shape: `active`, `revoked`, `superseded` (with `successor`) or `expired`, with chain evidence.
Its `validUntil` is `min(document validity end, observedAt + lease)`.

- An unknown ref returns `null`.
- A digest mismatch fails with `status_digest_mismatch`.

The verifier Worker (ATTE-28) maps its query (`credentialIssuer`, `schema`, `contentId`) to an issuer account, ref
and digest from its own trusted configuration, never from the presentation.

## Lease and revocation semantics

Leases follow `LocalStatusRegistry.read` exactly:

- A `LiveStatus` has `observedAt` = the snapshot time (the reader's `now()`) and
  `validUntil = min(observedAt + leaseMs, document validUntil)`.
- `leaseMs` defaults to 5000. A value of 0 or below, or above 60 000, fails with `invalid_status_lease`.
- `verifyMandateChain` / `verifyTransactionApproval` additionally require `now < validUntil` and
  `now - observedAt < maxStatusAgeMs` (≤ 60 s). A verified chain expires at
  `min(validUntil, observedAt + maxStatusAgeMs)`.

Once a revocation is **settled** at the reader's finality height, it is seen by:

- **Uncached readers (the default):** the next status read, and so the next mandate operation that re-verifies.
  They refuse it immediately.
- **`cacheActive: true`:** a previously observed *active* `LiveStatus` keeps its original `observedAt`. It is
  served only while `now < observedAt + leaseMs`, using the `leaseMs` of the current call, with `validUntil`
  capped to that bound. Otherwise the chain is read again. Expired entries are pruned whenever a new one is
  cached. A cached active
  can therefore authorise operations for at most `leaseMs` (≤ 60 s) after its observation. That is the same bound
  as a verifier holding the first read's result. Non-active results and failures are never cached.
- **A chain the verifier already verified:** usable until its `expiresAt`, which is at most `leaseMs` after the
  status observation.

Worst-case revocation latency is therefore the settlement delay plus the lease (≤ 60 s). The settlement delay is
the time for the revoke transaction to reach finality, or N confirmations. On Ethereum-style finality the delay
dominates. Choose `confirmations` finality where faster revocation matters, and accept the reorg risk that
`ChainStatusReader` then detects but cannot prevent.

## Status

The contract is not audited, and it is not deployed anywhere public. Mainnet writes stay gated by
[`production-readiness.md`](production-readiness.md). Two pieces are separate work:

- Issuer service wiring: the authenticated status-writer and the issuer-account registry.
- The verifier Worker adapter (ATTE-28).
