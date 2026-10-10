# Private graph and presentation profile

## Three representations

1. **Original authenticated records** preserve issuer boundaries and signatures.
2. **Private working graph** indexes records, subjects, activities, concepts and
   persona access policies. Holder-created edges are not automatically authoritative.
3. **Proof witness** contains only the authenticated records and joins needed for one
   requirement.

## Wallet family

A root wallet is a protected control context. Persona wallets provide compartmented
operational identities. A presentation wallet is a root-authorized projection over
selected personas and namespaces.

Common control is not the same as common subject. A parent company controlling a
subsidiary wallet cannot present the subsidiary's license as its own without a
policy-supported organizational relationship.

## Policy relation

A proof establishes:

```text
there exists private witness W such that
  authenticated(W)
  authorityAccepted(W)
  sameRelevantSubject(W)
  current(W)
  requirement(W) = true
```

Public inputs bind the proof to the verifier's exact requirement, accepted authority
state, freshness epoch, audience, challenge and intended action.

## Initial proof algebra

- conjunction and alternatives;
- existence;
- equality joins;
- integer/date bounds;
- accepted-set membership;
- distinct authenticated records;
- bounded authority paths;
- freshness;
- request-scoped holder nullifiers.

The protocol does not initially promise arbitrary SPARQL or arbitrary computation
over a hidden RDF graph.

## Reference backend

The POC signs insurance records as PODs and uses GPC to prove hidden numeric ranges,
accepted signer membership, holder binding, required booleans, validity and a
challenge-bound nullifier. The policy planner remains backend-independent.


## Reference verifier binding

The insurance adapter requires the verifier's subject binding as a public input.
A tuple constraint binds the signed schema, subject and USD currency; signer
membership, watermark and external nullifier are compared with the verifier's
request before cryptographic verification. The policy commitment includes both
the circuit configuration and the complete insurance request, including challenge
and accepted issuer keys. Proofs made with the earlier configuration must be
regenerated.

The subject binding and accepted issuer set are visible in the proof's public
membership lists. Use a verifier-scoped subject identifier where correlation is a
concern; the demo identifier is synthetic. Exact limits and the selected signer
remain hidden.

The local policy algebra provides `sameAttestation(id, child)` for claims that
must come from one record. The supplier profile uses one group per insurance
policy, SOC 2 report and ISO certificate. Plain `all` joins independent groups for
the requested subject; it does not establish cross-record policy or engagement
identity. Witness selection is a greedy heuristic, not a globally minimal set.
