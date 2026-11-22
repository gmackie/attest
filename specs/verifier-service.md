# Verifier service: `attest-verifier` (experimental)

`apps/verifier` is a Cloudflare Worker, tracked by ATTE-28, that runs `verifyPresentationForRequest`
from `@attest/verifier` with production ports and signs `attest.verification-result/v1`. It serves
`https://verify.attest.gmac.io` and is a separate Worker from `attest-demo`.

The protocol is described in [`proof-requests.md`](proof-requests.md). This document covers how the
service is deployed and what its results do and do not establish.

The proof backend is POD/GPC. It is a beta upstream implementation and has not been audited, so it is
not production-ready. A result is a signed assertion by this verifier, not a zero-knowledge proof
handed to the PEP.

## Roles and trust boundaries

| Party | Trusts | Pins |
| --- | --- | --- |
| Gatekeeper (the PEP) | This verifier, for the named requirement only | `issuer`, the result public keys and `{requirement id, digest}` |
| Verifier | Gatekeeper tenants, for request authenticity only | Each tenant's request public keys (`TRUSTED_PEPS`) |
| Verifier | IdPs, for subject authentication at enrollment | `IDENTITY_PROVIDERS` (issuer, JWKS URI, audience) |
| Verifier | Credential issuers, through the catalog's per-issuer policy | Issuer EdDSA keys in the requirement definition |
| Verifier | Sepolia, through two independent RPC providers that must agree | RPC URLs and the finality policy |

The verifier never resolves keys from URLs inside a request or presentation. PEP keys are configuration.
Gatekeeper publishes them at `GET <gatekeeper>/api/attest/tenants/<tenant>/jwks`, and an operator copies
them into `TRUSTED_PEPS`. The verifier does not fetch them.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /v1/presentations` | Body `{request: <proof-request JWS>, presentation: <attest.presentation/v1>}`. Returns `200 {result: <JWS>, expiresAt}`. |
| `POST /v1/enrollments` | Holder enrollment, described below. Returns `201` when a key is newly bound, or `200` when it was already bound to the same subject. |
| `GET /v1/requirements/<id>` | The canonical requirement definition, its digest, the per-issuer policy summary and the `synthetic` flag. |
| `GET /.well-known/jwks.json` | Every configured result public key (ES256, `kid`), so verifiers can rotate keys. |
| `GET /health` | Revision, `verifierId`, requirement digests, result key IDs, pinned PEP and IdP issuers, and chain head freshness (block number, age and finality). It returns 503 when the chain is stale or the configuration is invalid. It exposes no secrets or RPC URLs. |

Errors return `{code}` with a stable code. Most come from `VerifierError`:

| HTTP status | Codes |
| --- | --- |
| 400 | Request, requirement, presentation, issuer, holder and proof failures, for example `invalid_signature`, `request_issuer_key_unavailable`, `request_audience_mismatch`, `requirement_mismatch`, `credential_subject_mismatch`, `unauthorized_credential_issuer`, `holder_not_bound`, `proof_invalid` and `credential_not_active` |
| 401 | Enrollment token failures, such as `unauthenticated`, `untrusted_token_issuer`, `invalid_token_signature`, `token_audience_mismatch` and `token_expired` |
| 403 | `enrollment_subject_mismatch` |
| 409 | `request_replayed` and `holder_already_enrolled` |
| 503 | `status_unavailable` (no settled status, for example a credential not yet anchored at the settled block), `chain_unavailable` (RPC disagreement, stale head, wrong chain or reorg), `verifier_misconfigured`, `idp_keys_unavailable` and storage unavailability |

## Ports

| Port | Implementation |
| --- | --- |
| `resolveRequestKey` | `TRUSTED_PEPS` (`[{issuer, keys: [{kid, publicKey}]}]`). The service refuses any key that carries private members such as `d`. |
| `requirement` | The static catalog in `apps/verifier/src/catalog.ts`. The request pins `requirementDigest(definition)`. |
| `authorizedIssuer` | The policy for each catalog issuer, described below. |
| `holderBound` | The `EnrollmentStore` Durable Object (SQLite-backed), with one instance per holder key. |
| `status` | The policy for each catalog issuer. It uses `ChainStatusReader` for chain issuers and has an ATTE-21 seam for credential-level registries. |
| `consumeRequest` | The `ReplayStore` Durable Object (SQLite-backed). There is one instance per `(PEP issuer, request id)`, and the check-and-set is atomic. An alarm purges the record at `expiresAt + 2 min`. |
| `resultKey` | The active key in the `RESULT_SIGNING_KEYS` secret. |
| `verifierId` | `VERIFIER_ID`, which is `https://verify.attest.gmac.io`. |
| Limits | `maxStatusAgeMs = 60 s` and `resultTtlMs = 5 min`. Results are therefore capped at the status lease, which is at most 60 s after observation. |

The clock is read once for each verification. The chain reader uses the same instant, so status evidence
can never be later than the verifier's own `now`.

### Issuer policy (`authority` per catalog issuer)

Each accepted issuer has an explicit policy. The policy is the verifier's own operational decision. It is
**not** part of the requirement digest, but the accepted issuer keys are.

- **`authority: "chain"`, `status: "anchor"`.** The verifier reads the issuer's `WorkspaceRegistry` grant,
  `issuers(account, scope)`, and the credential anchor at one settled Sepolia block, through
  `ChainStatusReader` (ATTE-18).
  - Two RPC providers must agree on the chain ID, the block hash and every value read. The block hash is
    re-checked after the read, and stale heads are refused.
  - The grant must be enabled for `scope = commitValue(schema)`, with
    `signingKeyHash = commitValue(issuer EdDSA key)`.
  - Status comes from `workspaceAnchorStatus`, which returns active, revoked, expired, a withdrawn grant or a
    rotated key. The anchor ID follows profile `attest.verifier-anchor/v1`:
    `commitValue({profile, schema, contentId})`, with commitment `commitValue(contentId)`. The POD content ID
    is the only credential identifier the verifier sees.
  - Results carry `source: "chain"` evidence with the chain ID, block number and block hash.
- **`authority: "pinned"`, `status: "issuer-level"`.**
  - Authority is a pinned `@attest/authority` graph, evaluated at verification time. For example, the
    contractor-insurance pack's `grant:carrier` grant covers `insurance.*` on `attest:insurance:cgl:v1` until
    2030.
  - There is **no credential-level revocation**. Status is issuer-level only, and the result evidence says
    so with `source: "registry"`.
  - `CredentialStatusRegistry` in `src/chain.ts` is the seam for ATTE-21 (StatusRegistry) and ATTE-24
    (status lists). It returns `null` today. When it returns a status, that status takes precedence.

**Finality.** `CHAIN_FINALITY` is `confirmations:3` by default, following ATTE-27, which uses a maximum block
age of 5 minutes. It can also be `finalized`, with a maximum block age of 30 minutes; pilots should use
`finalized`.

### Current coverage

| Requirement | Accepted issuer | Authority | Status |
| --- | --- | --- | --- |
| `insurance.cgl.min-2m` (CGL aggregate ≥ $2,000,000 and per occurrence ≥ $1,000,000; schema `attest:insurance:cgl:v1`) | `issuer:carrier` (demo carrier from `@attest/domains`) | pinned | issuer-level |

No shared `WorkspaceRegistry` with a CGL issuer grant is deployed on Sepolia yet; the connected workspace
ships a deployment tool, not a shared registry. The chain path is implemented and tested against an
in-memory two-RPC chain. To use it, add a deployed registry address, issuer account and grant to the catalog
entry as `authority: "chain"`, and anchor credentials under the profile above.

The demo carrier's signing key is published in the repository, so anyone can mint a credential it
accepts. The catalog marks this requirement `synthetic: true`, and `/v1/requirements` and `/health`
expose that flag. Treat results as protocol demonstrations until a real issuer key replaces it. Replacing
the key changes the digest that Gatekeeper pins.

The domain pack is an example profile. It does not speak for ACORD, insurers or regulators.

## Holder enrollment

`POST /v1/enrollments` takes `Authorization: Bearer <IdP access token>` and this body:

```json
{
  "statement": {
    "schema": "attest.holder-enrollment/v1",
    "verifier": "https://verify.attest.gmac.io",
    "subject": {"issuer": "<IdP iss>", "subject": "<sub>"},
    "holderPublicKey": "<EdDSA POD public key>",
    "issuedAt": 1795300000000
  },
  "signature": "<JSON POD signed by the holder key; its only entry is enrollment = canonical(statement)>"
}
```

**Token checks.**
- The token must be ES256 or RS256, with RSA keys of at least 2048 bits.
- Its `iss` must exactly equal a configured IdP.
- The signing key comes only from that IdP's configured JWKS URI. It is fetched over HTTPS, redirects are
  refused, and keys are cached for 5 minutes.
- `aud` must include the configured audience.
- `exp` is required, and `nbf` and `iat` are checked with 30 seconds of skew.

**Statement and binding checks.**
- The authenticated subject is the token's `{iss, sub}`. The statement must name the same subject;
  otherwise the request fails with `enrollment_subject_mismatch`. The subject is never taken from the body.
- The statement must name this verifier, be at most 5 minutes old and be no more than 30 seconds in the
  future.
- The POD must verify under the enrolled key.
- A holder key is bound to at most one subject. A second subject is refused with `holder_already_enrolled`,
  so one key-holder cannot lend presentations to several accounts.
- Re-enrolling a key to the same subject is idempotent.

Wallets can use `signEnrollment` from `apps/verifier/src/enrollment.ts`. Un-enrollment and key-loss
recovery are not implemented.

## Proof verification in a Worker

The service bundles the same shims as `attest-demo`:
- `snarkjs` is aliased to `apps/issuer/src/groth16-worker.ts`, a BN254 Groth16 verifier built on noble.
- `fastfile` is aliased to `apps/issuer/src/verification-keys.ts`, which holds the pinned verification keys
  from `@pcd/proto-pod-gpc-artifacts` 0.13.0.

GPC verification therefore fetches nothing, and no proving code ships in the Worker.

The bundled Worker was run in local workerd (Miniflare) with a real GPC presentation. It completed the
whole flow in about 150 ms of wall time: enrollment, then a signed result, then `409` on replay. The demo
carrier's private key is not in the bundle.

## Configuration and secrets

| Name | Kind | Value |
| --- | --- | --- |
| `VERIFIER_ID` | var | `https://verify.attest.gmac.io` |
| `TRUSTED_PEPS` | var (JSON) | `[{"issuer": "<Gatekeeper tenant issuer>", "keys": [{"kid", "publicKey": <P-256 public JWK>}]}]` |
| `IDENTITY_PROVIDERS` | var (JSON) | `[{"issuer", "jwksUri", "audience"}]` |
| `SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL_SECONDARY` | vars | Two independent providers. The same host twice is refused. |
| `CHAIN_FINALITY` | var | `confirmations:3` (default) or `finalized` |
| `RESULT_SIGNING_KEYS` | **secret** | `{"active": kid, "keys": [{"kid", "privateKey": <P-256 private JWK>}]}` |

Durable Object bindings `REPLAY` (`ReplayStore`) and `ENROLLMENTS` (`EnrollmentStore`) are created by
migration `verifier-v1` (`new_sqlite_classes`).

To generate a result key, run:

```sh
node apps/verifier/scripts/new-result-key.mjs [kid] [--merge current-secret.json] \
  | pnpm exec wrangler secret put RESULT_SIGNING_KEYS -c apps/verifier/wrangler.jsonc
```

The script prints the secret JSON to stdout and the public JWK to stderr. It never writes a file.

### Rotation

**Result keys.**
1. Generate a new key with `--merge`, which adds it to the existing set and makes it active. Both keys are
   then published in `/.well-known/jwks.json`.
2. Add the new public key to Gatekeeper's pinned keys.
3. After the old key's last result has expired (at most 5 minutes), remove the old key from the secret, then
   from Gatekeeper.

**PEP keys.** Add the tenant's new `kid` to `TRUSTED_PEPS` before Gatekeeper starts signing with it.
Remove the old `kid` after that key's last request has expired (at most 10 minutes).

## Gatekeeper `ATTEST_CONFIG.verifiers[]` entry

```json
{
  "issuer": "https://verify.attest.gmac.io",
  "endpoint": "https://verify.attest.gmac.io/v1/presentations",
  "keys": [{"kid": "<kid>", "publicKey": {"kty": "EC", "crv": "P-256", "x": "…", "y": "…"}}],
  "requirements": [{"id": "insurance.cgl.min-2m", "digest": "22d9e704a055b73a23cf9464f9f3692f790526dbd49190e1c04442706f73df84"}]
}
```

- **`issuer`** is `VERIFIER_ID`. It is also the `audience` Gatekeeper puts in each proof request.
- **`keys`** come from the stderr of `new-result-key.mjs`. Cross-check them against
  `GET /.well-known/jwks.json` after deploying.
- **`requirements[].digest`** comes from `GET /v1/requirements/insurance.cgl.min-2m`, or from `/health`.
  Verify it independently by recomputing `requirementDigest` on the returned definition.

## What a result does and does not establish

**It establishes** that this verifier checked all of the following at `issuedAt`:
- a request signed by a pinned PEP key and addressed to this verifier;
- a requirement exactly matching the pinned digest;
- a credential about exactly `credentialSubject`, from an accepted and currently authorized issuer;
- a holder key enrolled to `subject`, with proof of possession over the whole presentation;
- a GPC proof (beta, unaudited) that the hidden values satisfy the criteria, watermarked by the request
  digest;
- the status described by the evidence `source`;
- single use of the request.

**It does not establish:**
- credential-level revocation for `pinned` issuers;
- that the issuer is a real insurer (the current issuer is synthetic);
- anything after `expiresAt`;
- anything the PEP can check without trusting this verifier's key, because a result is not a
  zero-knowledge proof given to the PEP.
