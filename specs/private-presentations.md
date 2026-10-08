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
