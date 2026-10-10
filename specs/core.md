# Authenticated assertion profile

## Primitive

An Attest record is a coherent issuer assertion over one subject, one issuer,
shared evidence/provenance and one validity context.

```text
Attestation
  id
  schema
  subject binding
  issuer
  claims
  context
  evidence references
  assurance basis
  issued/valid time
  jurisdiction
  status
```

Claims are typed values: integer with optional unit, boolean, string or date.
Profiles may add richer types later, but proof backends need a bounded, explicit
representation.

## Coherence rule

Claims from different attestations may not be recombined unless the verifier policy
also proves the relevant joins. A large insurance limit from one policy cannot be
combined with the insured entity or date from another policy.

## Evidence commitments

Raw evidence normally stays at its authoritative source or in holder-controlled
storage. An evidence reference identifies its source kind and commitment. A chain
may anchor the commitment, schema, issuer and status without publishing the evidence.

## Interpretation

A qualification may be evidence for a capability. It is not automatically identical
to every observation implied by its curriculum. Mapping assertions remain separately
attributed and versioned.
