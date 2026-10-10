# Scoped authority profile

A cryptographically valid statement and an authorized statement are different.
Verifiers select accepted roots and resolve a constrained path from the issuer.

```text
AuthorityGrant
  grantor
  grantee
  allowed actions
  predicate patterns / claim shapes
  credential schemas
  jurisdiction
  validity interval
  delegation permission
  maximum delegation depth
```

Every path edge must cover the requested action, predicate, schema, jurisdiction and
time. A child may not exceed its parent's scope.

The current reference evaluator supports finite scopes and bounded paths. It does not
attempt implication between arbitrary policy programs.

Observation authority is epistemic: a practitioner may report what they directly
observed. Certification and licensing are constitutive: only an accepted scheme or
statutory authority, or its valid delegate, can confer those statuses.
