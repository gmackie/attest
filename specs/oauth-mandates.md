# Experimental OAuth + Attest mandate intersection (A1)

The optional `@attest/mandates/oauth` module provides a **conjunctive
constraint check** for an already issuer-verified OAuth access token and
an independently signature/status-verified Attest agent mandate chain.

The verification order is mandatory:

1. Verify the OAuth access token independently with a trusted issuer JWT
   resource server (RFC 9068) or RFC 7662 introspection. If DPoP is
   required, validate the RFC 9449 proof, `cnf.jkt`, method, URI and replay.
   Resolve the subject's current tenant membership from an authoritative
   PIP and independently establish the agent client's identity.
2. Call Attest `verifyMandateChain` / `verifyPresentation` using a
   trusted issuer/key registry and fresh, digest-bound status. Never
   deserialize a caller-supplied object as an already verified chain.
3. Call `assertOAuthMandateIntersection(verifiedOAuth, verifiedChain,
   exactServerOperation, trustedScopeRequirement, now)`. This requires
   the exact user/tenant/resource audience, OAuth client, authenticated
   DPoP key, expiry and every required OAuth scope. It also delegates to
   the signed chain's full action, purpose, resource, business-term and
   per-action money-limit verification.
4. Finally run current Gatekeeper ABAC/PIP authorization and mandatory
   exact transaction approval, then atomically reserve all ancestor and
   leaf budgets before dispatch with a stable idempotency key.

A signed Attest credential **never issues OAuth access tokens, creates
missing OAuth scopes, proves a client is registered, or overrides policy
denial**. An AuthZEN `decision:true` likewise cannot replace the
OAuth or mandate verification layers.

The adapter is deliberately pure and does not introduce a new protocol,
new OAuth grant, cryptographic key fetch URL, consent ceremony, or new
metadata discovery endpoint. It does not claim RFC 9396, PAP or ZK
conformance. Future issuer-specific RAR constraints can be checked
independently *in addition* to these requirements.

Tests consume Attest's fixed signed ES256 interoperability fixture, verify
the chain using the existing reference verifier, and attempt scope
amplification, cross-client, audience/tenant, holder key and term swaps.

Run `pnpm exec vitest run packages/mandates/test/oauth.test.ts`.
Broad deployment remains gated on production issuer/PIP integration,
resilient revocation, binding key enrollment, budget reservation and
security review.
