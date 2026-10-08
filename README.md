# Attest

Attest is an open, privacy-preserving assurance substrate for businesses and people.
It represents authenticated assertions, scoped issuer authority, private evidence
wallets, machine-readable requirements and cryptographic presentations that prove a
requirement is satisfied without disclosing unnecessary source data.

This repository contains the first end-to-end proof of concept:

- a TypeScript/Effect 4 assurance kernel,
- scoped authority-chain resolution,
- a private root/persona/presentation wallet model,
- a composable requirement language and privacy-minimizing witness planner,
- signed POD credentials and a GPC/Groth16 hidden-range proof for insurance limits,
- example insurance, SOC 2 and ISO 9001 domain packs,
- a Kumo-based supplier/buyer workbench,
- and a Solidity commitment/verification-receipt registry for Sepolia-style deployments.

## The demo

A synthetic supplier privately holds:

- `$5M` commercial-general-liability aggregate coverage,
- `$2M` per-occurrence coverage,
- a current SOC 2 Type II examination,
- and an ISO 9001 certificate covering industrial-controls manufacturing.

The buyer can change its public thresholds. The local planner proves whether all
requirements are supported by current, authorized evidence while omitting source
values from its result. When the policy is satisfied, the browser can generate and
verify a real GPC proof that the carrier-signed hidden insurance values meet the
thresholds.

The chain payload contains commitments and a pairwise receipt—not policy documents,
exact limits, audit reports, certificate files or legal identity.

## Run it

Requirements: Node 24+ and pnpm 10+.

```bash
pnpm install --no-frozen-lockfile
pnpm dev
```

Then open the Vite URL and:

1. inspect the supplier's three private evidence records;
2. change the buyer's insurance thresholds;
3. confirm a `$2M` requirement succeeds and a `$10M` requirement fails without the
   UI returning the supplier's `$5M` value;
4. generate the GPC proof for a satisfied policy;
5. inspect the proof, evidence, policy and pairwise-nullifier commitments prepared
   for `AssuranceAnchor.sol`.

The first browser proof downloads the selected proving artifacts and may be slow.
A Node smoke proof is also available:

```bash
pnpm proof:smoke
```

## Quality gates

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

## Workspace

```text
apps/web                 Kumo assurance workbench
packages/domain          assertion and authority data model
packages/core            canonical commitments and Merkle roots
packages/authority       scoped authority-chain evaluator
packages/policy          requirement algebra and witness planner
packages/wallet          private root/persona/presentation wallet
packages/proofs          POD issuance and GPC proof adapter
packages/domains         insurance, SOC 2 and ISO 9001 examples
packages/chain-evm       EVM receipt model and ABI
contracts                Solidity commitment registry
specs                    protocol explainer, profiles and threat model
```

## Architectural boundary

Attest distinguishes five objects that frequently get blurred together:

1. **Evidence** — a policy, report, registry record or assessment artifact.
2. **Attestation** — a signed, coherent assertion about that evidence.
3. **Authority** — why the issuer is accepted for a particular assertion scope.
4. **Policy** — the verifier's requirements over authenticated assertions.
5. **Proof** — evidence that a private witness satisfies the policy.

A valid signature does not make an issuer authoritative. A local policy match is not
a zero-knowledge proof. A credential about a subsidiary is not automatically about
its parent. The implementation and negative tests preserve those boundaries.

## Standards posture

The proposed standards layer is a composition profile rather than a replacement for
existing ecosystems. It is intended to align with W3C Verifiable Credentials,
PROV-O, SKOS, SHACL, Open Badges, CTDL, ISO/IEC 11179 governance and OpenID4VCI /
OpenID4VP. See [`specs/w3c-explainer.md`](specs/w3c-explainer.md).

## Security status

This is a research and testnet proof of concept—not production compliance software.
In particular, POD/GPC is an upstream beta implementation whose circuits, compiler
and proving setup must not be treated as audited production cryptography. The demo
uses synthetic issuers and records. No domain pack is endorsed by ACORD, AICPA, ISO,
an accreditation body, insurer, auditor or regulator.
