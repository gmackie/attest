# Threat model

## Semantic attacks

- mixing claims from different subjects, policies, periods or projects;
- stripping supervision or context qualifiers;
- treating `closeMatch` as identity;
- duplicate attestations for one underlying engagement;
- converting a qualification alignment into an unsupported firsthand observation;
- treating selected positive records as a complete history.

## Authority attacks

- self-declared roots;
- cycles of mutually endorsing issuers;
- delegation beyond parent scope;
- stale or revoked grants;
- multiple keys controlled by one credential mill presented as independent roots;
- compromised issuer keys and ambiguous historical revocation.

## Privacy attacks

- correlating personas through payment addresses, timestamps or RPC metadata;
- unique combinations of otherwise hidden claims;
- global nullifiers reused across interactions;
- issuer/verifier collusion;
- status endpoints that call home for a unique credential;
- revealing exact ranges through repeated binary-search requirements.

## Protocol mitigations in the POC

- same-subject filtering before policy evaluation;
- coherent attestation fragments;
- scoped authority resolution;
- request-specific requirements and nullifiers;
- minimal-witness alternative selection;
- no hidden values in local evaluation output;
- evidence and proof commitments rather than raw records on-chain;
- verifier comparison against the expected GPC configuration.

## Remaining work

Production requires audited cryptography, durable status/revocation, rate limits on
adaptive threshold queries, network-metadata protections, key recovery, issuer
compromise procedures, interoperable source adapters and formal conformance tests.
