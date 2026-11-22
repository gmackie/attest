# Issuer revocation roots (experimental, testnet)

`RevocationRoots` (ATTE-24) lets each issuer publish, per epoch, a commitment to its complete list of revoked
credentials. A verifier checks that a presented credential is not on the list without any per-credential lookup
that tells the chain RPC, the issuer or the list host which credential is in use. It generalizes the epoch-and-root
model of `PrivateClaimRoots` (one replaceable "active" root per issuer) into an append-only sequence of revocation
epochs per issuer list. It addresses AT-04 in [the economy security review](economy-security-review.md) for
off-chain verifiers; see "AT-04" below for what stays open.

## Identifiers

- **Issuer list id:** `revocationListId(issuer) = SHA-256("attest.revocation-list/v1\n" || issuer)`.
- **Revocation id:** `deriveRevocationId({list, contentId, salt?}) = SHA-256("attest.revocation-id/v1\n" || list
  || "\n" || contentId || "\n" || salt)`. `contentId` is the POD content id already revealed in a presentation.
  - Unsalted (the default the verifier port uses): anyone who already knows the content id can compute the id and
    test it against the public list. That is the holder, the issuer and every verifier the credential was presented
    to. Nobody else can invert a list entry to a content id.
  - Salted: the issuer generates a random salt at issuance and signs it into the credential. List downloaders who
    know the content id but not the salt cannot test it. Each verifier obtains the salt from that issuer-signed
    field and can test it from then on. The current presentation format does not reveal such a field; a deployment
    supplies it through the port's `issuerSignedSalt` hook.

**Requirement: the verifier derives the revocation id itself, from verified fields only.** Those are the authorized
issuer, the content id the verified proof is bound to and, for salted lists, a salt taken from an issuer-signed
field of that credential. A holder-asserted salt or revocation id must never be used: a revoked holder would simply
supply a fresh salt or a random id that is not on the list, and its non-membership proof would be valid. The library
enforces this shape: `revocationStatus` takes the verified credential (`contentId`, optional `issuerSignedSalt`) and
derives the id; it has no revocation-id input. `revocationStatusPort` only receives what `@attest/verifier` has
already verified (issuer, schema, content id), and its `issuerSignedSalt` hook receives only those fields. A holder
proof is always checked against the derived id. If a salted list's salt is unavailable, the port fails closed
(`revocation_salt_unavailable`) instead of falling back to an unsalted id. A list must not mix salted and unsalted ids.

## What is on-chain

For each issuer list and epoch: `root` (RFC 6962 SHA-256 Merkle root over the strictly ascending revocation ids),
`size` (number of ids) and `publishedAt` (block time). No revocation id, content id, subject, holder or reason is
stored or emitted. The full list is published off-chain by the issuer (any host or mirror; its integrity comes from
the on-chain root, not the host).

## What the contract enforces

- Only the list's current `publisher` can publish. The administrator registers and rotates publishers.
  Administration is handed over in two steps (propose, accept); a proposal of zero or the current administrator is
  refused, and the administrator can cancel a pending proposal (`AdministratorProposalCancelled`), as in
  `WorkspaceRegistryV2`. Setting the publisher to zero stops new epochs, so verifiers
  fail closed once the last epoch exceeds their maximum age.
- Epochs are strictly sequential (`epoch == latestEpoch + 1`) and never rewritten; a zero root is refused.
- `latest(list)` returns the epoch number and its contents in one call, so they are read at the same block.
- The contract does **not** check that the committed tree is sorted, complete, or a superset of the previous
  epoch. It fixes what the publisher committed to.

## Verification

The verifier reads `latest(list)` through `ChainStatusReader` (`packages/chain-evm/src/status.ts`): at a finalized
or N-confirmation block, identical on at least two independent RPCs, with the block hash re-checked after the read.
Then, against that epoch's `root` and `size` (always from chain, never from the presented material):

1. **Freshness.** The epoch must be younger than the verifier's `maxEpochAgeMs`, measured from `publishedAt` to the
   observation time; otherwise `revocation_root_stale`. Issuers therefore republish at least once per period, even
   an unchanged list. The returned `validUntil` (the status lease) is `publishedAt + maxEpochAgeMs`, capped by the
   credential's validity, so the verifier's result never outlives the root's freshness.
2. **Non-revocation**, by one of:
   - **Full list.** The verifier (or a cache it trusts) downloads the epoch's list. It must be strictly ascending,
     of exactly `size` entries and reproduce `root`; otherwise `revocation_list_mismatch`. Membership is then a
     local binary search: `revoked` or `active`.
   - **Holder non-membership proof.** The holder, who downloads the whole list itself, sends the two adjacent
     leaves around where its id would sit, each with an RFC 9162 inclusion path (one neighbour at either end, none
     for an empty list). The proof names its epoch and must be for exactly the latest epoch
     (`revocation_epoch_mismatch`); it must verify (`revocation_proof_invalid`). A revoked id has no valid proof.
     This relies on the issuer having committed to a sorted list; only the full-list path checks that.
3. `revocationStatusPort` adapts this to `@attest/verifier`'s `status` port. Any failure (RPC disagreement, reorg,
   stale root, bad list or proof, unknown issuer, no epoch yet) returns `null`, which the verifier reports as
   `status_unavailable`. A failure is never reported as `active`.

## AT-04: the revocation-versus-use race

AT-04 is that a credential can be revoked after a verifier checked it but before the result is used. **If the issuer
includes the revocation in its next epoch**, the longest a revoked credential can still verify as active is bounded
by:

- the issuer's time from revocation decision to publishing that epoch, at most `maxEpochAgeMs` after the previous
  one, since verifier freshness makes a withheld epoch's predecessor stale;
- the finality or confirmation delay of the `ChainStatusReader`;
- the verifier's status age (≤ 60 s) and result lifetime (≤ 5 min), both already capped by `@attest/verifier`.

Freshness only forces the issuer to publish *some* epoch. It does not force that epoch to contain the revocation:
an issuer that omits it, or later drops it, keeps the credential active. Only the issuer decides what is revoked,
and such omissions are detectable but not prevented; see the residual risks under "Correlation analysis".

Tests (`packages/chain-evm/test/revocation.test.ts`) cover: active at epoch N; still epoch N while epoch N+1 is not
settled (the bounded window); revoked once N+1 settles; the holder's epoch-N proof refused against N+1; no proof
exists for a revoked id; a holder-chosen id or salt cannot dodge a revocation; forged proofs fail; a withheld epoch becomes stale after `maxEpochAgeMs`; disagreeing RPCs
and a reorg give unavailable; out-of-order and non-publisher writes revert.

AT-04 for the on-chain mint path remains open: `ZkAttestMinterV1` does not read `RevocationRoots`, and a native
on-chain non-membership check inside the proof is future work.

## Correlation analysis

| Party | Learns | Does not learn |
| --- | --- | --- |
| Issuer | The ids it revoked (it decides them); download traffic for its list, if it hosts it (time, IP, frequency). | Which credential a holder presents or a verifier checks: lists are fetched whole, proofs are built locally. |
| List host or mirror | That someone fetched the whole list at a time, from an address. | Which entry was of interest. |
| RPC providers | That some party read an issuer list's `latest` at a block, with network metadata. | Which credential: the call carries only the list id. |
| Chain observers | Per issuer: epoch count, list size and publication times, hence revocation volume and cadence. | Any revocation id, content id, subject or reason. |
| Verifier | The presented credential's revocation id and its status; afterwards it can watch future epochs for that id. | Other entries' meaning, unless it learned their content ids (and salts) elsewhere. |

**Linkability across verifiers.** Two verifiers that receive the same credential see the same content id, and so the
same unsalted revocation id. Revocation roots add no linkage beyond the content id the presentation already
reveals; they do not remove it either. Unlinkable non-revocation needs the check inside the zero-knowledge proof,
which this design does not provide.

**Residual risks.**
- Timing: a verifier fetching the list or reading the root right after a presentation, or a holder fetching the list
  just before one, correlates with use. Fetch on a schedule and cache, independent of presentations.
- List size: small lists, or a size that grows by one right after an event, can reveal that a particular
  credential was revoked. Issuers may pad with random decoy ids (indistinguishable from real ids) and publish on a
  fixed cadence.
- Issuer honesty: an issuer can delay or omit a revocation from its next epoch, un-revoke by dropping an id from a
  later epoch, or publish an unsorted tree that admits a false non-membership proof. Dropped ids and unsorted trees
  are visible to anyone who keeps consecutive public lists; the contract
  does not prevent them. The issuer is already trusted for its own credentials' status.
- Administrator: can rotate an issuer's publisher, and a new publisher can publish a different list. Published
  epochs cannot be rewritten.
- Availability: if the issuer stops publishing, every one of its credentials becomes unavailable after
  `maxEpochAgeMs`. That is deliberate (fail closed) and must be weighed against the race window when choosing it.

## TypeScript (`@attest/chain-evm`)

- Issuer: `revocationListId`, `deriveRevocationId`, `buildRevocationList`, `revocationRootsPublisher` (idempotent;
  `epoch_conflict`, `epoch_out_of_order`), `publishEpochArgs`, `viemRevocationClients`. Before every write both the
  publisher and the viem adapter ask the RPC for its chain ID: mainnet (declared or reported) is refused while
  production writes are gated, and a reported chain that differs from the declared one fails with `chain_mismatch`.
- Holder: `nonMembershipProof`.
- Verifier: `readRevocationEpoch`, `verifyRevocationList`, `verifyNonMembership`, `revocationStatus`,
  `revocationStatusPort`.

## Status

Experimental. The contract is not audited, and it is not deployed or wired into the hosted verifier yet. Mainnet
stays gated by [production readiness](production-readiness.md).
