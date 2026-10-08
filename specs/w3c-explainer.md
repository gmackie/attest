# Explainer: Portable Private Assurance

## Summary

Organizations and people routinely need to prove that they satisfy requirements
without disclosing the full records from which those requirements are derived.
Examples include insurance limits, audit scope, professional licensing, work
experience, safety records and business qualifications.

Existing credential standards describe and transport credentials well, but a shared
profile is still needed for:

- coherent experience and observation assertions;
- issuer authority scoped by action, claim shape, jurisdiction and time;
- holder-controlled composition across private persona contexts;
- verifier policies over authenticated assertions;
- cryptographic predicate presentations such as `coverage >= X`;
- and provenance-preserving adaptation of legacy evidence sources.

## Motivating examples

A supplier should be able to prove:

```text
CGL aggregate >= $2,000,000
SOC 2 Type II security criterion was in scope
ISO 9001 certificate is current and covers the contracted activity
```

without handing every buyer the exact policy limits, the SOC 2 report body or a full
certificate packet.

A person should be able to prove:

```text
practical web-exploitation evidence exists
at least two qualifying engagements were completed
a valid government identity is bound to the same holder
```

without exposing the person's legal identity or prior clients during initial
qualification.

## Proposed composition

The proposal should profile, not replace:

- RDF / JSON-LD for public semantics;
- PROV-O for agents, activities, roles and derivation;
- SKOS for independently governed concept schemes and mappings;
- W3C Verifiable Credentials for signed issuer/holder/verifier envelopes;
- SHACL for structural profile constraints;
- Open Badges and CTDL for achievements, qualifications and competencies;
- ISO/IEC 11179 principles for registry stewardship and lifecycle;
- OpenID4VCI / OpenID4VP for issuance and presentation;
- federation/recognized-entity mechanisms for issuer discovery and recognition.

## New profile surface

The smallest useful addition is:

1. an **authenticated assertion profile** defining coherent signed fragments,
   evidence basis, time, scope and subject/activity bindings;
2. a **scoped authority profile** defining what a recognized entity may issue or
   delegate;
3. a **private assurance presentation profile** defining requirements, authenticated
   joins, status freshness, replay scope and minimum disclosure.

## Non-goals

The work does not define:

- a global reputation score;
- a single global credential authority;
- a required blockchain;
- a mandatory domain ontology;
- a replacement for VC, Open Badges, CTDL or OpenID;
- or a way for an organization to self-certify a protected status.

## Implementation evidence required before standards track

- at least two independent implementations of the assertion/policy fixtures;
- public conformance vectors including failure cases;
- one privacy-preserving presentation backend;
- one non-blockchain verifier;
- one chain-anchored implementation demonstrating optional ledger use;
- domain trials in structurally different markets;
- and a documented correlation/privacy analysis.
