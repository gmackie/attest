# WorkspaceRegistryV2 governance (experimental)

Status: experimental, testnet only. Not audited. Mainnet writes stay closed
(`specs/production-readiness.md`); the V2 writers refuse chain ID 1.

`contracts/src/WorkspaceRegistryV2.sol` addresses the governance and revocation
rows of the production-readiness table: V1's administrator is immutable, it has
no administrator emergency revocation, and it has no issuer key lifecycle. V2
keeps the V1 function signatures and adds those controls; anchor ids are
namespaced per issuer, and V1 readers must not be used against it (see below). It still anchors only commitments,
key-hash commitments and reason codes; it does not verify proofs or establish
real-world authority.

Client: `packages/chain-evm/src/registry-v2.ts`. Deployment pinning:
`packages/chain-evm/src/manifest.ts` and `contracts/deployments/`.
Tests: `packages/chain-evm/test/registry-v2.test.ts` (anvil).

## Administrator lifecycle

- The constructor takes the administrator explicitly. Deploy with a Safe (or
  other multisig) as administrator; the deployer EOA never becomes the root by
  accident.
- All authorization is `msg.sender` equality. No `tx.origin`, no EOA/code-size
  checks and no signature recovery, so a contract administrator such as a Safe
  works unchanged. EIP-1271 is not needed: the Safe calls the registry directly.
- Two-step rotation: `proposeAdministrator(next)` (admin; replaces any earlier
  proposal), `acceptAdministrator()` (the proposed account), and
  `cancelAdministratorProposal()` (admin). Proposing zero or the current admin
  is refused. After acceptance the old administrator has no authority.
- Proposals lapse: `proposeAdministrator` sets `pendingAdministratorDeadline =
  now + PROPOSAL_TTL` (7 days). Acceptance after the deadline reverts
  `ProposalExpired`, so a forgotten proposal to a since-compromised or
  decommissioned account cannot be accepted months later. The administrator
  re-proposes to start a new window. `pendingAdministrator` keeps showing the
  lapsed address until replaced or cancelled; check the deadline.
- Lost-key drill: acceptance needs nothing from the current administrator, so a
  rotation proposed before the key was lost still completes, provided it is
  accepted within the 7-day window. Recovery from a
  lost administrator key with no pending proposal is not possible by design (no
  backdoor); that is why the administrator should be a Safe, whose own owner
  set can be rotated when one owner key is lost.

## Issuer signing keys

Keys are per issuer account: `issuerKeys(issuer, keyHash)` =
`(validFrom, validUntil, compromisedAt, compromiseReason)`, times in block
seconds. A key is usable at `t` when `validFrom <= t < validUntil` and, if
`compromisedAt != 0`, `t < compromisedAt`.

- `registerIssuerKey(issuer, keyHash, validFrom, validUntil)` (admin): explicit
  window, never retroactive (`validFrom >= now`). Re-registering is refused.
- `configureIssuer` (V1 signature) registers an unknown key open-ended from the
  current block (`OPEN_ENDED = 2^64-1`), as V1 effectively did. Enabling a grant
  with an unusable key (not yet valid, expired or compromised) reverts
  `KeyUnusable`.
- `rotateIssuerKey(issuer, scope, keyHash)` (admin): moves an enabled grant to a
  usable new key. Earlier anchors keep the key they were written with.
- `retireIssuerKey(issuer, keyHash, validUntil)` (admin): planned shortening of
  the window, never retroactive.
- `markIssuerKeyCompromised(issuer, keyHash, T, reason)` (admin or the issuer
  account): compromise cutoff. `T <= now`. The cutoff may later be moved earlier,
  never later.
- `anchor` records `anchorBindings(key) = (grant key, block time)` and reverts
  `KeyUnusable` if the grant's key is not usable now.

**Compromise semantics.** Anything anchored with the key at or after `T` is
invalid. Anchors written before `T` stay valid unless separately revoked. If the
verifier knows the credential's own signing time (`signedAt` in the query), the
client also rejects credentials claiming a signing time at or after `T`. A
claimed signing time is issuer-asserted, so it can only narrow acceptance, never
widen it: the on-chain anchoring time is always checked. An attacker who controls the key before `T` is detected can still
produce valid anchors until `T`; choose `T` as the earliest suspected compromise.

**Window semantics.** The key window bounds when a key may sign and anchor, not
how long its credentials live; credential lifetime is the anchor's `validUntil`.
An anchor written inside the window stays valid after the key expires or is
retired.

## Anchor namespacing

V1 keys anchors by the issuer-chosen id in one global map, so any enabled
issuer can front-run another issuer's id and make its anchor revert
`AlreadyUsed` (id squatting). V2 stores every anchor under
`key = anchorKey(issuer, id) = keccak256(abi.encode(issuer, id))`:

- `anchor(id, ...)` and `revoke(id)` keep their V1 signatures; `id` is in the
  caller's namespace. Two issuers can use the same id independently, and
  neither can revoke or shadow the other's anchor.
- The V1-shaped getter `anchors(bytes32)`, plus `anchorBindings` and
  `anchorRevocations`, take the derived key. `anchorKey(issuer, id)` is
  exposed on-chain and as `registryV2AnchorKey` in the client.
- Events carry the derived key in their `id`/`key` position
  (`CredentialAnchored`, `CredentialRevoked`); `CredentialKeyBound` and
  `AnchorEmergencyRevoked` also carry the issuer and the issuer-chosen id.
- `registryV2AnchorStatus` takes the issuer-chosen id and derives the key.

## Emergency revocation

Both functions are administrator-only, take a non-zero `bytes32` reason code,
emit an event, and are **irreversible**:

- `emergencyRevokeAnchor(issuer, id, reason)`: records
  `anchorRevocations(anchorKey(issuer, id))` and also sets the `revoked` flag
  in `anchors(key)`. Emits
  `AnchorEmergencyRevoked(key, issuer, reason, id, revokedAt)`.
- `emergencyRevokeGrant(issuer, scope, reason)`: records
  `grantRevocations(issuer, scope)`, disables the grant, and invalidates every
  anchor under it regardless of time. The grant can never be configured again
  (`GrantRevoked`); re-admission needs a new issuer account or scope. Emits
  `GrantEmergencyRevoked(issuer, scope, reason, revokedAt)`.

Why irreversible: a revocation that can be undone gives verifiers nothing they
can cache or act on, and makes a compromised administrator able to silently
reinstate credentials. Mistaken revocations are corrected by re-issuing under a
new anchor ID (and, for grants, a new scope or account), which leaves a visible
trail. A reversible suspension already exists: `configureIssuer(..., false)`.

Reason codes are short ASCII labels right-padded into `bytes32`
(`reasonCode("issued_in_error")`, decoded by `reasonLabel`), readable on any
explorer. Suggested labels: `key_compromise`, `issuer_account_lost`,
`issued_in_error`, `issuer_misconduct`, `authority_withdrawn`, `legal_order`,
`superseded`. They are conventions, not an on-chain enum.

## Client status (`registryV2AnchorStatus`)

V2 equivalent of `workspaceAnchorStatus`, usable as `@attest/verifier`'s status
port. In one `ChainStatusReader.read` (every endpoint, one settled block,
re-checked block hash) it reads the registry's runtime code hash, the anchor, its
bound key, that key's lifecycle, both emergency revocation records and the grant.
It refuses (throws) when the registry is not pinned in the manifest or its code
hash differs, and fails closed with `anchor_mismatch` when issuer, scope,
commitment or the bound key differ from the query.

Precedence of results (first match wins):

| Reason | Status | Condition |
| --- | --- | --- |
| `emergency_revoked` | revoked | anchor or grant emergency revoked; `revocation` carries target, reason code, label, time |
| `anchor_revoked` | revoked | issuer revoked its own anchor (V1) |
| `key_compromised` | revoked | anchoring time or `signedAt` >= compromise cutoff; `compromise` carries details |
| `key_not_yet_valid` / `key_expired` | revoked | `signedAt` outside the key window (anchoring time is enforced on-chain) |
| `anchor_expired` | expired | anchor `validUntil` <= block time |
| `issuer_grant_inactive` | revoked | grant disabled (reversible suspension, V1 semantics) |

`registryV2KeyValidity` answers "was this key usable at time T" with the same
reasons plus `key_unknown`.

## Differences from V1

| V1 | V2 |
| --- | --- |
| `constructor()`; admin = deployer, immutable | `constructor(address administrator_)`; two-step rotation with cancel |
| No emergency revocation | Irreversible anchor and grant emergency revocation with reason codes |
| Grant key change makes all earlier anchors `issuer_key_changed` | Anchors bind the key at write time; rotation does not invalidate them. Use compromise cutoff or revocation to invalidate |
| No key lifecycle | Validity windows, retirement, compromise cutoff; `anchor` and `configureIssuer` revert `KeyUnusable` |
| `configureIssuer` always succeeds for the admin | Reverts `GrantRevoked` after emergency grant revocation, `KeyUnusable` for an unusable key |
| Anchors in one global map keyed by id; ids can be squatted | Anchors keyed by `anchorKey(issuer, id)`; `anchors(bytes32)` and event ids take/carry the derived key |
| No version marker | `registryVersion()` returns 2 |

Unchanged: function signatures of `administrator`, `issuers`, `verifiers`,
`anchors`, `usedRequests`, `configureIssuer`, `configureVerifier`, `anchor`,
`revoke`, `recordDecision`, and the V1 event and error signatures. Writers built
on V1's `registryAbi` therefore work against V2 unchanged.

**V1 readers must not read V2.** V1 status semantics ignore key windows,
compromise cutoffs and per-issuer namespacing, so they could report a
compromised credential as active. `workspaceAnchorStatus` (V1) reads
`registryVersion()` in the same agreeing-RPC read as the anchor and grant: a
contract revert or empty return means V1; a result of 2 or more is refused with
`registry_requires_v2_reader`. Transport errors are never read as V1, and
endpoints that disagree on the version fail closed (`rpc_disagreement`).

`administrator` is now a storage variable, so the runtime code has no
immutables and its hash is fixed by the compiler output alone.

## Pinned deployment manifest

`contracts/deployments/<chainId>.json`, schema
`contracts/deployments/manifest.schema.json` (`attest.deployment-manifest/v1`):
`chainId` and `deployments[]` of `{contract, address, deployTx, blockNumber,
runtimeCodeHash, sourceDigest, compiler: {solc, evmVersion, optimizer},
administrator?}`. `runtimeCodeHash` is keccak256 of the deployed runtime code;
`sourceDigest` is sha256 of the compiled source file.

`verifyPinnedDeployment` (and every V2 status read) refuses:
`manifest_missing` (no manifest, or no record for the address),
`manifest_chain_mismatch`, `manifest_contract_mismatch`, `chain_mismatch` (an
endpoint serves another chain), `no_code`, and `codehash_mismatch`. Code is read
on every reader endpoint (use `codeReadingEndpoint`; plain
`publicClientEndpoint` readers are refused with `code_read_unsupported`), so
endpoints must agree on it. `deployRegistryV2` returns the on-chain fields for a
record. The parser ignores unknown fields; the JSON Schema is strict for
authoring.

No manifest is committed yet: there is no reviewed V2 deployment. The module is
self-contained so network configuration (ATTE-26) can load manifests per network.

## Gaps

- Not audited; no independent review of the governance model.
- No timelock on administrator actions or rotation; a Safe's threshold is the
  only brake (proposals do lapse after 7 days, which is not a delay). A timelock (or Safe guard/delay module) is recommended before any
  pilot.
- No on-chain migration from V1: V1 anchors are not imported. Older V1 readers
  deployed before this change do not check `registryVersion()`; pin readers to
  the manifest's contract name as well. Clients choose V1
  or V2 per pinned deployment.
- Compiler version is not pinned in `compile.mjs` (it uses the installed `solc`
  ^0.8.30); a release manifest must record the exact version used.
- Issuer self-reported compromise trusts the issuer account; if that account is
  stolen the attacker can invalidate its own past anchors (it could already
  revoke them), but cannot validate anything.
