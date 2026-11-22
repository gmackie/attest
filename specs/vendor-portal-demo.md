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

A retry is all or nothing. Every result, and the caller's decision quota, is checked before any request is
consumed, so a failing second item or an exhausted quota never burns the first. Two items naming the same
request are refused with `duplicate_request`.

Gatekeeper's limits apply:
- requests last 5 minutes and are reused while a minute remains;
- a principal may have at most 16 pending requests;
- a retry may carry at most 4 results.

## Abuse limits and where work happens

The demo PEP has two layers.

- **The front, in the Worker.** It does everything that involves the network or the client:
  - serves discovery and both JWKS from configuration, without touching the Durable Object;
  - applies the per-IP rate limits;
  - verifies the bearer token, including JWKS fetches for any extra IdP;
  - reads the body, which must be at most 64 KiB, declare a `Content-Length` and arrive within 10 s
    (`408 request_timeout` otherwise).
- **The core, in the singleton `DemoPepService` Durable Object.** It receives only a small, parsed,
  authenticated command and runs it in a serial queue. It does storage and signing only. A slow or
  stalled client can therefore never hold the queue.

| Limit | Scope | Value |
| --- | --- | --- |
| `DEMO_PEP_TOKEN_LIMITER` (Workers Rate Limiting) | per IP (`CF-Connecting-IP`), `POST /identity/token` | 10 per 60 s |
| `DEMO_PEP_API_LIMITER` (Workers Rate Limiting) | per IP, `/authorize`, receipts, epochs | 60 per 60 s |
| Daily tokens | per IP | 50 |
| Daily decisions | per principal | 300 |
| Daily tokens and decisions | global backstop | 5,000 and 20,000 |

IPs are stored only as a day-scoped SHA-256 digest, inside quota counters that are deleted after their day. If
a rate-limit binding is absent, only the daily quotas apply.

**Retention.** An hourly alarm does the following:
- deletes expired pending requests, accepted-result facts and empty pending lists, using per-entry
  `exp:<time>:<key>` index keys listed in time order;
- seals pending leaves into an epoch;
- deletes leaves and decision indexes 30 days after their epoch was sealed (epoch rows stay, so the chain of
  roots stays checkable);
- deletes quota counters from earlier days.

Sealing stores every leaf's inclusion path, computed in one O(n) pass, so a receipt read is one leaf, one
epoch and an O(log n) path check.

## Decision ledger

The ledger uses Gatekeeper's construction (GATE-12) with the demo PEP's own labels, so a receipt never claims
to be from Gatekeeper.

- **Commitment:** `SHA-256("attest.demo-pep.decision/v1\n" salt "\n" canonical(decision))`
- **Leaf:** `SHA-256("attest.demo-pep.leaf/v1\n" prev "\n" commitment)`

The genesis `prev` is 64 zeros. Each leaf has a random 32-byte salt, so a leaf or root does not confirm a guessed
decision. The decision names its principal only as `SHA-256(canonical({issuer, subject}))`.

**Sealing.** An epoch is sealed by the hourly alarm, or on demand when a receipt is first asked for. Before
sealing, the PEP re-verifies the chain from the last sealed leaf and refuses a damaged span (`chain_broken`).
Receipts are available for 30 days after their epoch is sealed.

**Verification.** `verifyDecisionReceipt` (in `@attest/chain-evm`, `decision-receipt.ts`) recomputes the
commitment and leaf from the revealed decision and salt, then checks RFC 6962 inclusion. Given an anchored
epoch, it also compares the root, the span and the size. The browser picks the label profile from labels it
knows, never from the server.

**On-chain anchoring.** The demo PEP publishes its sealed epochs to `DecisionLogAnchor` on Sepolia:

| | |
| --- | --- |
| Contract | `0x7020EE914B517Da8F7F8D42Dc436763898FaA8Ad` (chain 11155111, deployed at block 12190829) |
| Administrator | `0x98770836EA0C26c7a2259B2b8F8E44Ee01D213ee` (testnet deployer) |
| Log name / id | `attest-demo-pep` / `decisionLogId("attest-demo-pep")` = `0x6b0b609dfc1698b1d74ce391632963f26f2e8e658f85b133594967a3145a054c` |
| Publisher | `0xD8BF0e16f8273D086B6873a3F8ef9A6b127D55Ad` (`setPublisher` tx `0x6c639903171c2da6f8938c1cccf788d590853c562a15a6778c99ce6efc10fc46`, block 12190863) |

**Publishing.**
- **When.** It runs from `DemoPepService`'s alarm, after the hourly maintenance. A receipt read that seals an
  epoch on demand wakes the alarm about a second later.
- **Outside the request queue.** The queue is entered only for short local reads and writes. The simulation,
  the transaction and the wait for its receipt happen between them, so requests keep flowing while a
  transaction confirms. At most one publication is in flight.
- **Clients.** It uses `decisionLogAnchorAdapter` with `viemAnchorClients`, over both of the network's RPCs (a
  viem fallback transport).
- **Fee cap.** Every write is capped at `maxFeePerGas` 1000 wei with a 10 wei priority fee; Sepolia's base fee
  is about 17 wei.
- **Chain check.** The adapter checks the chain the RPC reports against the configured one
  (`chain_mismatch`), and the shared write gate refuses mainnet and unlisted chains.
- **Retries.** They are idempotent: an epoch already anchored with the same commitment is recognised and no
  transaction is sent, and a different commitment is refused (`anchor_conflict`).
- **Failures.** A failure records only a sanitized code on the epoch (`anchorError`) and in `anchor:state`, for
  example `contract_reverted:not_publisher` or `chain_mismatch`. Retries back off exponentially from 1 minute
  to 1 hour.
- **Success.** The epoch row records `{chainId, address, logId, txHash, blockNumber, anchoredAt}`.

**Fail closed, degrade honestly.**
- With no `DEMO_PEP_ANCHOR`, or an invalid one, nothing is sent and the PEP works as before. Invalid settings
  include a wrong log id, an unlisted or non-writable chain, and a missing or malformed key.
- Receipts carry `ledger.anchor.status`:
  - `not-configured` or `misconfigured`: anchoring is off; the UI shows "sealed locally";
  - `awaiting-anchoring`: anchoring is configured but this epoch is not on-chain yet;
  - `anchored`: the epoch row records the anchoring transaction.

**Browser check.**
- **Pinned contract and log.** The browser pins the contract: the manifest entry when present, otherwise
  `0x7020…A8Ad`. It also pins the expected log id for the demo profile. An address or log id reported by the
  PEP is only compared against these pins, and a mismatch is an error.
- **Settled read.** It reads the epoch with `readAnchoredEpoch` through the Sepolia reader: both public RPCs
  must agree, at 3 confirmations, as in ATTE-27. It then checks the receipt with `verifyDecisionReceipt`
  against that root, span and size.
- **What the UI shows:**
  - "matches the root anchored on Sepolia", with the anchoring transaction linked on Etherscan;
  - "awaiting confirmations" when the transaction is not settled yet;
  - "awaiting anchoring" when the epoch is not on-chain yet;
  - an error when the on-chain root disagrees; the journey then does not complete.

**Publisher setup (one-time, by the administrator).**
1. Generate a publisher key and fund the address with a little Sepolia ETH; 0.00005 ETH covers many epochs at
   these fees.
2. From the administrator account, call `setPublisher(logId, publisher)` on `DecisionLogAnchor`, with
   `logId = 0x6b0b609dfc1698b1d74ce391632963f26f2e8e658f85b133594967a3145a054c`. The contract has no plural
   `publishers` getter; check the setting with the `PublisherSet` event or `publisher(logId)`.
3. Set the secret: `pnpm exec wrangler secret put DEMO_PEP_ANCHOR_KEY`, entering the 0x-prefixed 64-hex
   private key interactively. It is never logged, stored in the Durable Object or returned.
4. `DEMO_PEP_ANCHOR` is already in `wrangler.jsonc`. To rotate the publisher, the administrator calls
   `setPublisher` with the new address, and you replace the secret.

The demo ledger's log name changed to `attest-demo-pep` with this work. Epoch 1 of that log is the first epoch
the deployed PEP seals.

## Trust boundaries

| Party | Trusts | Pins |
| --- | --- | --- |
| Browser (holder) | The PEP it was pointed at, for the challenge | The PEP's `/jwks` (fetched; the verifier's pin is what protects the presentation) and the verifier base URL it chose |
| Demo PEP | The verifier, for `demo.insurance.cgl.min-2m` only | `DEMO_PEP_VERIFIER`: issuer, result public keys, requirement id and digest |
| Demo PEP | Its demo identity (built in); optional IdPs | `DEMO_PEP_IDENTITY_PROVIDERS` |
| Verifier | The demo PEP, for request authenticity | `TRUSTED_PEPS` entry with the demo PEP's request key |
| Verifier | The demo identity, for enrollment | `IDENTITY_PROVIDERS` entry (issuer, JWKS URI, audience, `clientId`, `bindingTtlMs`) |
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
- **Anchoring is testnet-only.** Epochs are anchored on Sepolia by a single hot publisher key, and the contract has not been audited (see above).
- **The demo does not speak for anyone.** It does not speak for ACORD, insurers, regulators or Gatekeeper.

## Configuration

`attest-demo` (root `wrangler.jsonc`):

| Name | Kind | Value |
| --- | --- | --- |
| `DEMO_PEP_ISSUER` | var | `https://attest.gmac.io/api/demo-pep`. The demo identity issuer is `<issuer>/identity`. |
| `DEMO_PEP_VERIFIER` | var (JSON) | Gatekeeper `verifiers[]` shape: `{issuer, endpoint, keys: [{kid, publicKey}], requirements: [{id, digest}]}`. `keys` come from `https://verify.attest.gmac.io/.well-known/jwks.json`. With `keys: []` the PEP challenges with `attest_not_configured`. |
| `DEMO_PEP_IDENTITY_PROVIDERS` | var (JSON) | Default `[]`. Further IdPs in the verifier's `IDENTITY_PROVIDERS` shape. |
| `DEMO_PEP_CORS_ORIGINS` | var (JSON, optional) | Extra browser origins. The portal itself is same-origin. Every response carries `Vary: Origin`. |
| `DEMO_PEP_ANCHOR` | var (JSON) | `{"chainId":11155111,"address":"0x7020EE914B517Da8F7F8D42Dc436763898FaA8Ad","logId":"0x6b0b609dfc1698b1d74ce391632963f26f2e8e658f85b133594967a3145a054c"}`. Optional; unset or invalid disables anchoring. |
| `DEMO_PEP_ANCHOR_KEY` | **secret** | The publisher's EVM private key, `0x` plus 64 hex digits, parsed strictly |
| `DEMO_PEP_TOKEN_LIMITER`, `DEMO_PEP_API_LIMITER` | `ratelimits` bindings | Namespaces `2001` and `2002`; see the limits table above. |
| `DEMO_PEP_SIGNING_KEY` | **secret** | `{"active": kid, "keys": [{kid, privateKey}]}`: the proof-request key |
| `DEMO_IDENTITY_SIGNING_KEY` | **secret** | The same shape, a different key: the access-token key |

Durable Object `DEMO_PEP` (`DemoPepService`, migration `demo-pep-v1`) holds the pending requests, the facts,
the quota counters and the ledger. A single serial queue makes consume-once and append/seal atomic. Its alarm
runs the hourly maintenance.

Generate each key with `apps/issuer/scripts/new-demo-pep-key.mjs`. The script prints the secret to stdout and the
public JWK to stderr, together with the verifier entry to add. It writes nothing to disk.

```sh
node apps/issuer/scripts/new-demo-pep-key.mjs request  | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
node apps/issuer/scripts/new-demo-pep-key.mjs identity | pnpm exec wrangler secret put DEMO_IDENTITY_SIGNING_KEY
```

To rotate a key, pipe the current secret JSON from your password manager on stdin with `--merge-stdin`. The new
key becomes active and the old keys stay published. The script refuses a file path (`--merge <file>`), so the
current secret is never written to disk:

```sh
pbpaste | node apps/issuer/scripts/new-demo-pep-key.mjs request --merge-stdin \
  | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
```

Clear the clipboard afterwards. Add the new `kid` to the verifier's `TRUSTED_PEPS` before the PEP signs with
it.

On `attest-verifier` (`apps/verifier/wrangler.jsonc`):
- `TRUSTED_PEPS` gets `{"issuer": "https://attest.gmac.io/api/demo-pep", "keys": [{"kid", "publicKey"}]}` from
  the request key's stderr.
- `IDENTITY_PROVIDERS` gets `{"issuer": "https://attest.gmac.io/api/demo-pep/identity", "jwksUri":
  "https://attest.gmac.io/api/demo-pep/identity/jwks", "audience": "https://verify.attest.gmac.io", "clientId":
  "attest-vendor-portal-demo", "bindingTtlMs": 86400000}`. The script prints this entry for the identity key.
  - `clientId` refuses tokens minted for any other client.
  - `bindingTtlMs` makes demo holder bindings expire after 24 hours; an alarm deletes them.
  - Each subject may hold at most 5 active holder keys (`too_many_holder_keys`).
- The `ENROLLMENT_RATE_LIMITER` binding (namespace `2101`, 10 per 60 s per IP) limits `POST /v1/enrollments`.
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
- The security-review tests in `demo-pep.test.ts`, `verifier-service.test.ts` (ATTE-20 M3) and
  `packages/demo/test/vendor-portal.test.ts` cover:
  - per-IP and per-principal quotas, and the rate-limit bindings;
  - discovery and JWKS served without the Durable Object;
  - stored inclusion paths;
  - a stalled body timing out without blocking other callers;
  - all-or-nothing retries;
  - the maintenance alarm and retention;
  - the cap on holder keys per subject, expiring bindings and the enrollment rate limit;
  - `Vary: Origin`;
  - the receipt verdict when an anchor disagrees.
- `apps/issuer/test/demo-pep-anchor.test.ts` runs against anvil with `--chain-id 11155111` and a 7 wei base
  fee. It deploys `DecisionLogAnchor` and authorizes the publisher, then:
  - seals and publishes from the alarm path, and checks the transaction's fee cap;
  - verifies receipts against the on-chain root and continues to a second epoch;
  - checks idempotent retries and a single in-flight publication;
  - negative cases: an unauthorized publisher (error recorded, backoff, no transaction), a chain mismatch, a
    tampered root or decision, a foreign contract address, and strict configuration and key parsing.
