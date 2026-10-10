# Agent mandates and exact transaction approvals

Experimental Attest reference profile version 1. This is not a standardized PAP token, W3C Verifiable Credential, ZK proof, or legal determination of consent. It was designed against Poppy draft 0.1 and Operations version 1, inspected on 2026-10-10:

- https://personalagentprotocol.org/docs/spec
- https://personalagentprotocol.org/docs/extensions/operations

Poppy handles company discovery, sign-in, sessions and confirmations. A confirmation records the personal agent's assertion about approval; it cannot prove a person saw the terms. This profile adds separately verifiable operational authority.

## Package and model

@attest/mandates supplies closed-shape parsers, portable Web Crypto signing/verification, Effect 4 service facades, a local status registry and a pure operation-constraint check. Application flows use the Effect facade; integration adapters can use the portable subpath.

The assurance AuthorityGraph answers who may certify a claim. An operational mandate answers who may act for a subject. Certification authority does not confer authority to spend that subject's money. These graphs remain separate.

| Mandate field | Binding |
| --- | --- |
| schema | attest.agent-mandate/v1 |
| id, issuer, subject | Immutable credential ID, independently authorized signing authority, represented subject |
| tenant, audience | Exact tenant and HTTPS company resource |
| delegate | HTTPS agent client ID and RFC 7638 P-256 key thumbprint |
| actions | Exact canonical actions, without wildcards |
| constraints.resources, purposes | Exact allowlists |
| constraints.terms | One explicit rule per business term |
| constraints.money | Optional currency, per-action and lifetime aggregate ceilings |
| issuedAt, validFrom, validUntil | Safe-integer Unix milliseconds; expiry is exclusive |
| statusRef | Opaque reference resolved by a trusted authority |
| mayDelegate, maxDelegationDepth | Explicit permission and remaining depth, at most eight |
| parentDigest | Child's binding to its immutable parent payload |

Money uses nonnegative safe-integer minor units. The server adapter owns the currency unit scale; two decimal places are not assumed. Floating-point amounts and currency conversion are unsupported.

Each term rule is exactly equals, oneOf, or any:true. A match requires the same complete term-key set in the operation and every mandate. Missing/unknown terms and ignored constraints are refused. any:true is an explicit issuer choice. The company must derive every business effect, cost, resource and purpose from its provider schema; agent descriptions are not authoritative.

## Delegation and approval

Presentations are ordered root-to-leaf chains of at most nine credentials. Every child issuer and signing key must match the parent's delegate client/key. Parent commitment, subject, tenant and audience must match. Actions, resources, purposes, term rules, money ceilings and validity only narrow; delegation depth decreases. Every ancestor needs fresh active status. Duplicate IDs, chain splicing, detached children and scope expansion are rejected.

Executors must reserve every ancestor's aggregate budget with the leaf's. Two children cannot reset their parent's ceiling.

attest.agent-approval/v1 is a separate signature binding subject, tenant, audience, delegate client/key, leaf mandate commitment, exact operation ID/revision/commitment, validity and independent status. Changed terms or a new operation require fresh approval. Approval issuer authority is checked separately from mandate issuance authority.

A company can trust an enrolled user key or its own approval ceremony. approved_by:user, conversation text, a click assertion and an agent signature do not create this credential. Enrollment and that ceremony are outside this package. A signature cannot establish that a person consciously understood the terms.

## Crypto, status and privacy

The codec uses compact JWS, ES256/P-256 and 64-byte IEEE P1363 signatures. Headers are exactly alg, kid and typ; typ equals the schema. A verifier-owned issuer/key registry selects keys. Caller-selected remote key/status URLs and algorithms are refused.

Canonicalization orders keys by UTF-16 code units, retains array order, and rejects non-JSON values, negative zero, getters, prototype gadgets, symbols, sparse arrays, duplicate-key encodings, excessive depth and oversized inputs. Signed bytes must use this exact representation. This pinned local profile does not claim general RFC 8785 compliance.

Payload commitments are lowercase SHA-256 hex without 0x. They remain stable across fresh or malleated ECDSA signatures. Budgets, status and parent links use payload commitments; re-signing cannot reset spend.

VerificationPorts requires a trusted key resolver, an independent issuer/subject authority check and a digest-bound status reader. Original observation/lease timestamps must be fresh. The configured status age is positive and at most 60 seconds; tests use five seconds. A result expires at the earliest credential or status lease. It is a snapshot, not perpetual bearer authority. Remote cached status supplies bounded rather than instantaneous global revocation.

The leaf key must match the company's independently authenticated holder, such as a DPoP-bound Session Token. Caller JSON describing the actor is insufficient. Gatekeeper re-verifies before reservation and separately checks OAuth scopes and company policy.

LocalStatusRegistry is an in-process reference authority for tests/demos. It binds each reference to one immutable payload, rejects rebinding, and never reactivates revocation on retries. Its methods belong behind the issuer's authenticated service. Multi-process use requires a durable authoritative backend.

The package performs no blockchain writes. Mandates disclose their contents to the verifier and claim no ZK privacy. Raw credentials, private graphs and keys are not placed on-chain.

## Verification and follow-up

    pnpm exec vitest run packages/mandates/test/mandates.test.ts

packages/mandates/fixtures/mandate-v1.json is a fixed signed interoperability vector with public keys only. Gatekeeper consumes the same fixture and tests signed company sessions/DPoP, atomic quotas, revision approval, audit rollback and uncertain provider outcomes.

Further work: authenticated durable issuer/status services and consent UI; reviewed enrollment, rotation and recovery; package publication/profile migration; independent cryptographic review; and a shared quota authority before broadening the single-company audience model.
