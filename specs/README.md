# Attest protocol notes

These documents describe the interoperable kernel exercised by the reference
implementation. They are intentionally smaller than the product vocabulary.

The [agent mandate profile](agent-mandates.md) specifies experimental operational delegation, exact approvals and status.

- [`w3c-explainer.md`](w3c-explainer.md) — problem statement, use cases, relationship to existing standards and incubation proposal.
- [`core.md`](core.md) — authenticated assertion profile and evidence commitments.
- [`authority.md`](authority.md) — scoped recognition and delegation.
- [`private-presentations.md`](private-presentations.md) — private graph representation, witness planning and proof relation.
- [`threat-model.md`](threat-model.md) — privacy, semantic and authority attacks.
- [`decision-log-anchoring.md`](decision-log-anchoring.md) — experimental on-chain commitments to sealed epochs of hash-chained decision logs (Gatekeeper's ledger) and RFC 6962 inclusion checks.
- [`proof-requests.md`](proof-requests.md) — experimental signed proof requests, holder presentations and short-lived verification results for enforcement points such as Gatekeeper.
- [`mandate-status-registry.md`](mandate-status-registry.md) — experimental on-chain, digest-bound mandate status (active, revoked, superseded) read through settled, multi-RPC chain snapshots with ≤ 60 s leases.

The normative direction is: standardize facts, provenance, authority and proof
interfaces—not a universal reputation score or a single global credential root.
- [`registry-v2-governance.md`](registry-v2-governance.md) — experimental WorkspaceRegistryV2: Safe-compatible two-step administrator rotation, irreversible emergency revocation with reason codes, issuer key windows and compromise cutoff, and pinned deployment manifests.
