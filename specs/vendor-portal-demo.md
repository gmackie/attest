# Vendor portal demo: prove to access (experimental)

The journey at `attest.gmac.io/#/testnet/vendor-portal` (ATTE-20) shows the whole assurance loop end to end. A
vendor user asks to approve a payout. The policy enforcement point (PEP) challenges for proof of insurance. The
user proves it privately in the browser, is allowed, and then checks a receipt for that decision.

- **Action and resource:** `vendor.payout.approve` on `supplier:acme`.
- **Requirement:** `demo.insurance.cgl.min-2m`, digest `2251414534a86a6cbe9b53d6a030b6fbe4437f8d1e7341ec0bc91246846b3d20`
  (CGL aggregate ≥ $2,000,000 and per occurrence ≥ $1,000,000; see [`verifier-service.md`](verifier-service.md)).

Production Gatekeeper's attest support (GATE-10/11) is not deployed yet. The PEP is therefore a **demo PEP** in
the `attest-demo` Worker (`apps/issuer/src/demo-pep`), and it is labelled as a stand-in everywhere it appears.
It follows Gatekeeper's documented flow and shapes (`docs/attest-pep.md` in Gatekeeper), so the journey can move
to real Gatekeeper by changing a base URL.

## Flow

```
 Browser (holder)              Demo PEP (attest.gmac.io/api/demo-pep)         Verifier (verify.attest.gmac.io)
 ───────────────               ─────────────────────────────────────         ────────────────────────────────
 1 POST /identity/token ─────▶ mint at+jwt (ES256, demo subject)
   ◀──────── access token (aud: PEP, verifier)
 2 POST /authorize {action, resourceId} ─▶ no fact on file → challenge
   ◀── {outcome: challenge, attest.requests[0]: signed attest.proof-request/v1}
   check request sig (PEP JWKS), subject, entity, verifier
   GET /v1/requirements/demo.insurance.cgl.min-2m ─────────────────────────▶ definition
   check digest == request.requirement.digest
 3 POST /v1/enrollments (Bearer token, holder-key POD signature) ───────────▶ IdP check via /identity/jwks
   mint demo CGL credential, GPC proof (watermark = request digest)
   POST /v1/presentations {request, presentation} ──────────────────────────▶ 8 checks, consume request
   ◀────────────────────────────────────────── signed attest.verification-result/v1 (aud: PEP)
 4 POST /authorize {…, attest: {requestId, result}} ─▶ verifyVerificationResult (pinned verifier keys,
                                                      requirement digest, expected bindings), consume once
   ◀── {outcome: allow, evidence}                     append decision to the hash-chained ledger
 5 GET /decisions/<id>/receipt ─▶ seal epoch (RFC 6962 root), build inclusion proof
   ◀── {receipt: decision + salt, leaf, prev, epoch root, path}
   verify commitment + inclusion in the browser;
   if a DecisionLogAnchor is in the network manifest, read the epoch at a settled Sepolia block and compare
```

Every decision the PEP takes (challenge, allow and deny) is logged, not only allows.

## Demo PEP endpoints (`/api/demo-pep`)

| Method and path | Purpose |
| --- | --- |
| `GET /` | Discovery: issuer, JWKS URIs, pinned verifier, policy, ledger log id and the stand-in notice. |
| `GET /jwks` | Proof-request public keys (ES256). An operator copies them into the verifier's `TRUSTED_PEPS`. |
| `POST /identity/token` | Demo identity: a 15-minute RFC 9068 `at+jwt` access token for a fresh `demo-…` subject, audiences the PEP and the verifier. |
| `GET /identity/jwks` | Demo identity public keys. The verifier lists this issuer in `IDENTITY_PROVIDERS`. |
| `POST /authorize` | `{action, resourceId, attest?}` with `Authorization: Bearer`. Same shape as Gatekeeper's `POST /api/authorize`: `challenge` with `attest.requests[]`, then `allow` on the retry. Refused results are `400 {code: "InvalidAttestResult", message: <stable code>}`. |
| `GET /decisions/<id>/receipt` | The caller's own decision receipt; other callers get 404. Seals pending leaves first. |
| `GET /epochs/<n>` | A sealed epoch: root, span, boundary hashes. |

**Result checks.** `POST /authorize` checks each result in this order, as Gatekeeper does:
- The request must exist and belong to the caller's principal. Otherwise `unknown_request`, so other callers
  learn nothing about it.
- The verifier must be the one the request was addressed to, still pinned for the same digest. Otherwise
  `untrusted_verifier`.
- The request must not be consumed (`request_consumed`) and must be unexpired (expired requests are purged and
  read as `unknown_request`).
- `verifyVerificationResult` checks the signature with a pinned key (`invalid_signature`,
  `verifier_key_unavailable`), the audience, the expiry (`result_expired`) and every expected binding: request
  digest, subject, entity, requirement and decision (`result_binding_mismatch`).
- The result's `requestId` must equal the request. Only then is the request consumed.

An accepted result becomes a fact `(principal, requirement, entity)` that holds until its `expiresAt`. After
that, the PEP challenges again.

Gatekeeper's limits apply:
- requests last 5 minutes and are reused while a minute remains;
- a principal may have at most 16 pending requests;
- a retry may carry at most 4 results.

Daily ceilings bound what anonymous visitors can store: 5,000 tokens and 20,000 decisions.

## Decision ledger

The ledger uses Gatekeeper's construction (GATE-12) with the demo PEP's own labels, so a receipt never claims
to be from Gatekeeper.

- **Commitment:** `SHA-256("attest.demo-pep.decision/v1\n" salt "\n" canonical(decision))`
- **Leaf:** `SHA-256("attest.demo-pep.leaf/v1\n" prev "\n" commitment)`

The genesis `prev` is 64 zeros. Each leaf has a random 32-byte salt, so a leaf or root does not confirm a guessed
decision. The decision names its principal only as `SHA-256(canonical({issuer, subject}))`.

**Sealing.** An epoch is sealed on demand, when a receipt is first asked for. Before sealing, the PEP
re-verifies the chain from the last sealed leaf and refuses a damaged span (`chain_broken`).

**Verification.** `verifyDecisionReceipt` (in `@attest/chain-evm`, `decision-receipt.ts`) recomputes the
commitment and leaf from the revealed decision and salt, then checks RFC 6962 inclusion. Given an anchored
epoch, it also compares the root, the span and the size. The browser picks the label profile from labels it
knows, never from the server.

**On-chain anchoring.** If `networkConfigs.sepolia.contracts.DecisionLogAnchor.default` is set, the browser
reads the epoch with `readAnchoredEpoch`, at a settled block through two agreeing RPCs, and verifies against it.
Only the manifest's address is trusted; an address supplied by the PEP is ignored.

**Today no DecisionLogAnchor is deployed in the manifest, and the demo PEP does not publish epochs.** The UI
therefore says "sealed locally — not yet anchored on-chain". A locally sealed receipt shows only internal
consistency: the PEP could still rewrite its own history. Anchoring needs these follow-ups:
- deploy `DecisionLogAnchor` and add it to the manifest;
- set a publisher for log id `decisionLogId("attest.gmac.io/demo-pep/decision-ledger")`;
- run `decisionLogAnchorAdapter` on a schedule.

## Trust boundaries

| Party | Trusts | Pins |
| --- | --- | --- |
| Browser (holder) | The PEP it was pointed at, for the challenge | The PEP's `/jwks` (fetched; the verifier's pin is what protects the presentation) and the verifier base URL it chose |
| Demo PEP | The verifier, for `demo.insurance.cgl.min-2m` only | `DEMO_PEP_VERIFIER`: issuer, result public keys, requirement id and digest |
| Demo PEP | Its demo identity (built in); optional IdPs | `DEMO_PEP_IDENTITY_PROVIDERS` |
| Verifier | The demo PEP, for request authenticity | `TRUSTED_PEPS` entry with the demo PEP's request key |
| Verifier | The demo identity, for enrollment | `IDENTITY_PROVIDERS` entry (issuer, JWKS URI, audience) |
| Verifier | The demo carrier, through the catalog's pinned authority graph | The issuer key in the requirement definition |

Who sees what:
- **The PEP** sees the verifier's signed result: subject, entity, requirement, credential issuer, status source
  and expiry. It never sees the proof, the credential, the holder key or the amounts.
- **The verifier** sees the GPC proof, the credential issuer, the subject and the content ID. It does not see the
  amounts.
- **The chain** would see only epoch roots and boundary hashes.

## What is demo-grade

- **The identity authenticates nobody.** Anyone can mint a token for a new `demo-…` subject.
- **The policy authorizes everyone.** Every demo subject may act for `supplier:acme`; there is no membership
  check.
- **The credential is not a real assurance.** The browser mints it with the contractor-insurance pack's
  **published** demo carrier key. Anyone can mint one, so the requirement id starts with `demo.` and the
  verifier marks it `synthetic`.
- **The status source is `issuer-authority`.** There is no credential-level revocation.
- **POD/GPC is beta and has not been audited.** The verification result is the verifier's signed assertion, not
  a zero-knowledge proof given to the PEP.
- **Decisions are not anchored yet** (see above).
- **The demo does not speak for anyone.** It does not speak for ACORD, insurers, regulators or Gatekeeper.

## Configuration

`attest-demo` (root `wrangler.jsonc`):

| Name | Kind | Value |
| --- | --- | --- |
| `DEMO_PEP_ISSUER` | var | `https://attest.gmac.io/api/demo-pep`. The demo identity issuer is `<issuer>/identity`. |
| `DEMO_PEP_VERIFIER` | var (JSON) | Gatekeeper `verifiers[]` shape: `{issuer, endpoint, keys: [{kid, publicKey}], requirements: [{id, digest}]}`. `keys` come from `https://verify.attest.gmac.io/.well-known/jwks.json`. With `keys: []` the PEP challenges with `attest_not_configured`. |
| `DEMO_PEP_IDENTITY_PROVIDERS` | var (JSON) | Default `[]`. Further IdPs in the verifier's `IDENTITY_PROVIDERS` shape. |
| `DEMO_PEP_CORS_ORIGINS` | var (JSON, optional) | Extra browser origins. The portal itself is same-origin. |
| `DEMO_PEP_SIGNING_KEY` | **secret** | `{"active": kid, "keys": [{kid, privateKey}]}`: the proof-request key |
| `DEMO_IDENTITY_SIGNING_KEY` | **secret** | The same shape, a different key: the access-token key |

Durable Object `DEMO_PEP` (`DemoPepService`, migration `demo-pep-v1`) holds the pending requests, the facts
and the ledger. A single serial queue makes consume-once and append/seal atomic.

Generate each key with `apps/issuer/scripts/new-demo-pep-key.mjs`. The script prints the secret to stdout and the
public JWK to stderr, together with the verifier entry to add. It writes nothing to disk.

```sh
node apps/issuer/scripts/new-demo-pep-key.mjs request  | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
node apps/issuer/scripts/new-demo-pep-key.mjs identity | pnpm exec wrangler secret put DEMO_IDENTITY_SIGNING_KEY
```

On `attest-verifier` (`apps/verifier/wrangler.jsonc`):
- `TRUSTED_PEPS` gets `{"issuer": "https://attest.gmac.io/api/demo-pep", "keys": [{"kid", "publicKey"}]}` from
  the request key's stderr.
- `IDENTITY_PROVIDERS` gets `{"issuer": "https://attest.gmac.io/api/demo-pep/identity", "jwksUri":
  "https://attest.gmac.io/api/demo-pep/identity/jwks", "audience": "https://verify.attest.gmac.io"}`.
- `CORS_ORIGINS` is `["https://attest.gmac.io"]`, so the browser can enroll and present. It allows exact origins
  only and never credentials.

The web journey's endpoints default to `https://attest.gmac.io/api/demo-pep` and `https://verify.attest.gmac.io`.
`VITE_DEMO_PEP_URL` and `VITE_VERIFIER_URL` override them at build time. Each viewer can also change them in the
journey's "Service endpoints" panel, which is stored in localStorage.

## Switching to real Gatekeeper and Nathan

1. **Gatekeeper.** Set the PEP endpoint to Gatekeeper's base. The journey calls `<base>/authorize` and expects
   Gatekeeper's challenge shape; it reads the request keys from `<base>/jwks`.
   - Gatekeeper serves `POST /api/tenants/<tenant>/authorize` and `GET /api/attest/tenants/<tenant>/jwks`, so it
     needs either a thin path mapping or a small endpoint table in `packages/demo/src/vendor-portal.ts`.
   - The receipt route is Gatekeeper's decision-proof endpoint.
   - `verifyReceipt` already accepts Gatekeeper's `gatekeeper.decision-proof/v1` profile.
   - Add the Gatekeeper tenant key to `TRUSTED_PEPS`.
   - Declare `attest.req.demo.insurance.cgl.min-2m` in Gatekeeper's PIP, and add an `attest_presentation` rule
     for `supplier:acme`.
2. **Nathan.** When Nathan issues RFC 9068 access tokens (NATH-15):
   - replace `demoSignIn` with Nathan's sign-in (the "Sign in with Nathan" button is the seam);
   - list Nathan in the verifier's `IDENTITY_PROVIDERS`, with the verifier as an audience;
   - list Nathan in `DEMO_PEP_IDENTITY_PROVIDERS` while the demo PEP is still in use.
3. **Retire the demo pieces.** Retire the demo PEP and its `TRUSTED_PEPS` and `IDENTITY_PROVIDERS` entries.
4. **A real assurance.** This needs a real issuer and a new, non-`demo.` requirement.

## Tests

- **`apps/issuer/test/demo-pep.test.ts`**
  - configuration fails closed;
  - token minting;
  - challenge, then allow;
  - negative joins: another request, another subject or entity, a wrong requirement digest or a changed pin, a
    replayed result, expired results and requests, an untrusted verifier key, issuer or audience;
  - the pending cap;
  - the ledger: inclusion proofs across epochs, and a tampered leaf, decision, path, root or size;
  - a refused seal of a tampered span;
  - receipt privacy.
- **`apps/issuer/test/vendor-portal-e2e.test.ts`** runs the journey's client flow against the demo PEP and the
  real verifier handler, in process, with a real GPC proof: challenge, enroll, present, signed result, allow,
  then the receipt verifies. It also checks replays at both services and that another user's holder key is
  refused.
