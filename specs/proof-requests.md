# Proof requests, presentations and verification results (experimental)

Experimental Attest reference profiles, tracked by ATTE-16 and ATTE-17 under the trust-stack roadmap ATTE-15.
They are not OpenID4VP, W3C VC or AuthZEN conformance claims. They borrow OpenID4VP's request/response shape
where it fits. The proof backend is POD/GPC, which is beta and has not been audited.

They replace the unsigned request exchange listed in `specs/production-readiness.md`. The PEP, which can be a
Gatekeeper tenant, signs each request. The verifier rebuilds every criterion from its own pinned definition.

## Flow

1. **The PEP challenges.** A PEP that needs assurance about an authenticated principal (an IdP `iss` and `sub`,
   such as a Nathan user) signs an `attest.proof-request/v1` request and returns it in its challenge.
2. **The holder's wallet presents.** The wallet:
   - verifies the request signature;
   - shows the requirement and gets consent;
   - generates a GPC proof whose watermark is the request digest;
   - signs the whole `attest.presentation/v1` with the holder key, as proof of possession.
3. **The verifier checks and signs.** The verifier is named in the request `audience`. It runs the checks in the
   order below, then signs an `attest.verification-result/v1` addressed back to the PEP.
4. **The PEP consumes the result.** It verifies the result with `verifyVerificationResult`, passing its own
   pending request's bindings. It then treats the result as a fact bounded by `expiresAt`.

## `attest.proof-request/v1`

The request is an ES256 compact JWS. Both its header and payload are canonical JSON, and
`typ = attest.proof-request/v1`.

| Field | Binding |
| --- | --- |
| `id` | Request identifier. The verifier consumes it once. |
| `issuer` | HTTPS identifier of the requesting PEP. Its keys come from the verifier's trusted registry, never from a URL in the request. |
| `audience` | HTTPS identifier of the one verifier that may evaluate the request. |
| `subject` | `{issuer, subject}` of the authenticated principal. |
| `credentialSubject` | The entity the requirement must hold for, for example `supplier:acme`. The PEP must already have authorized `subject` to act for it. The verifier requires the presented credential to be about exactly this entity, so a user cannot satisfy a requirement for one entity with another entity's credential. |
| `requirement` | `{id, digest}`: the SHA-256 of the canonical requirement definition the PEP expects. |
| `decisionId` | Optional. The PEP decision this request answers. |
| `nonce` | At least 128 bits of base64url. |
| `issuedAt`, `expiresAt` | Unix milliseconds. Expiry is exclusive. The lifetime is at most 10 minutes. |

The **request digest** is the SHA-256 of the canonical payload. It is the GPC watermark, so a proof cannot be
replayed against another request, subject, audience or nonce.

## Requirement definitions

The verifier owns the requirement definition, which has these fields:
- `id`
- the credential `schema`
- GPC `criteria`
- `acceptedIssuers`: each an issuer ID with its EdDSA key

A request pins the definition by digest. A weaker or relabelled definition therefore fails with
`requirement_mismatch`. Changing the accepted issuers also changes the digest.

## `attest.presentation/v1`

The presentation contains:
- `requestDigest`
- `credential`: `{issuer, subject, contentId}`
- `holderPublicKey`
- `proof`, a GPC envelope
- `holderSignature`, a POD signed by the holder key over the canonical presentation without the signature

`holderPublicKey` must be canonical (`encodePublicKey(decodePublicKey(k))`, unpadded base64); other spellings
of the same key fail with `noncanonical_holder_key`, so a key has one identity for enrollment.

The verifier sees the credential subject and content ID. The content ID is needed for the status lookup until
the status lists in ATTE-24 replace per-credential lookups. Hidden values stay hidden.

## Verifier checks (in order)

1. The request signature is from a trusted PEP key, `audience` is this verifier, and the request is unexpired.
2. The requirement is in the verifier's catalog, and its digest matches the request.
3. The presentation's `requestDigest` equals the verified request digest, and its credential subject equals the request's `credentialSubject`.
4. The credential issuer is accepted by the definition *and* currently authorized for the requirement (the authority port).
5. The holder signature covers the entire presentation. This is checked first, so enrollment cannot be probed with arbitrary public keys. The holder key must also be enrolled to the request subject (the `holderBound` port).
6. The GPC proof verifies against criteria rebuilt from the definition, with the request digest as watermark.
7. Status is `active`, observed at most `maxStatusAgeMs` (≤ 60 s) ago, and still within its validity. `createChainStatusReader` and `workspaceAnchorStatus` in `@attest/chain-evm` (ATTE-18) supply this. They read at a finalized (or N-confirmation) block, and by default require two independent RPC endpoints that agree on the chain ID, the block hash and every read value. They re-check the block hash after reading (reorg detection) and refuse stale heads. The status they return also covers the issuer's on-chain grant and signing-key commitment.
8. The request ID is consumed atomically. This step runs last, so a failed attempt never burns a legitimate request.

Error codes are stable strings, for example `holder_not_bound`, `status_stale` and `request_replayed`.

## `attest.verification-result/v1`

An ES256 JWS from the verifier, addressed to the requesting PEP. It carries:
- the request ID and digest
- `decisionId`
- `subject`
- `credentialSubject`
- `requirement`
- the credential issuer ID
- status evidence (`source`; plus `chainId`, `blockNumber` and `blockHash` for chain sources). The source is
  `chain` (credential status on-chain), `registry` (an off-chain credential-level status registry) or
  `issuer-authority` (only issuer authority was checked; no credential-level revocation was consulted).
  `verifyVerificationResult` accepts an optional `acceptedStatusSources` to refuse weaker sources
- `issuedAt` and `expiresAt`

`expiresAt` is the earliest of: the configured TTL (≤ 5 minutes), the request's own expiry, the end of the
status lease, and the credential's status validity.

The result contains **no hidden values, holder key or content ID**. It is a signed assertion by the verifier, not
a zero-knowledge proof given to the PEP. The PEP trusts the verifier for the named requirement, and should
re-request after expiry instead of caching beyond it.

`verifyVerificationResult` requires the PEP's `expected` bindings: request digest, subject, credential subject,
requirement ID and digest, and decision ID. It rejects any mismatch with `result_binding_mismatch`. A result
relayed by another user, about another entity, or for another decision is therefore refused by the library
itself, not left to each caller.

## Interop vector

`packages/verifier/fixtures/verifier-v1.json` holds a synthetic signed request and result with public keys only.
Gatekeeper vendors it in the same way as `packages/mandates/fixtures/mandate-v1.json`. Regenerate it with
`pnpm --filter @attest/verifier fixture`.

## Not covered yet

- Holder enrollment UX: linking a holder key to an IdP subject.
- Multi-credential presentations.
- Revocation status lists (ATTE-24).
- On-chain verification of receipts (ATTE-25).
