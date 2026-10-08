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

Live demo: https://attest.gmac.io

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


## Deploy

The demo is hosted as static assets on Cloudflare Workers at `attest.gmac.io`.
The browser evaluates synthetic evidence and generates proofs locally; there is
no server wallet, upload endpoint or production issuer integration.

With Node 24+, pnpm and access to the configured Cloudflare account:

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm deploy:web
```

`pnpm deploy:web` runs all quality gates, builds the assets, and deploys the
`attest-demo` Worker and its custom domain from `wrangler.jsonc`. Cloudflare
credentials remain in the operator's environment, never in this repository.
Deployments are manual; opening or merging the PR does not automatically deploy.

## Interactive network lab

The demo includes 15 fictional institutions: three trust roots, an accreditor,
six independent issuers, three suppliers, and two buyers. Select institutions and
buyer thresholds, then use **Run walkthrough** or **Next step** to execute seven
stages: request, signed issuance, authority resolution, private wallet, policy
planning, real insurance proof generation, and independent verification.

Pause stops automatic advancement after the current operation. Completed stages
can be inspected without rerunning them. Reset creates a fresh holder identity and
request challenge; late results from an older run are discarded. Nothing persists
across a page reload. The download contains only the public request, proof and
receipt, and **Test replay rejection** verifies against a different challenge.

Failure scenarios cover tampering, missing authority, expired or revoked records,
wrong subjects, and insufficient coverage. Changing buyers updates the default
thresholds; Beacon cannot meet Metro's defaults, while Novus can. Every issuer has
a distinct public demo signing key. Authority grants and status are local fixtures,
with a fixed evaluation date of October 7, 2026. Neither SOC 2 / ISO checks nor the
receipt's evidence root are proven by the insurance GPC circuit. No transaction is
submitted to a chain.

`packages/demo` owns the executable workflow and scenario tests; `apps/web` renders
it with Cloudflare Kumo controls and surfaces. Proof computation uses real artifacts
and reports completion only after the prover and verifier return.

Each walkthrough stage includes a visual crypto explainer: request ticket, issuer
key and signature envelope, an interactive signature-tampering check, openable
wallet cards, coherent planner witnesses, private proving inputs, and the buyer's
public verification package. Shortened cryptographic values come from the actual
run; key labels and drawings are teaching aids. The final stage can simulate
receipt inclusion in a block. This visualization distinguishes the contract's
anchor mapping from its receipt event log, and makes no chain transaction. The
current contract records caller-supplied verification claims, not on-chain GPC
verification. Merkle inclusion witnesses are explained, but are not generated by
this demo.

## Industry data journeys

All four examples have matching industry headers. Healthcare, education and
cold-chain logistics each include five independently signed sources and ten
explicit approval criteria:

| Industry | Evidence sources | Approval examples |
| --- | --- | --- |
| Healthcare | License board, training institute, employer, screening provider, occupational health | Current license and screening, training, experience, fitness clearance |
| Education | University, language assessment, scholarship foundation, course registry, funding trust | Degree/GPA, language score, scholarship, prerequisite credits, sufficient funds |
| Cold-chain logistics | Monitoring provider, lab, carrier, calibration bureau, manufacturer QA | Temperature range, lot tests/expiry, custody, calibrated sensors, batch release |

The new journeys default to **private proof mode**. Issuers sign field-addressable
PODs alongside their display credentials. The holder wallet checks feasibility and
then generates a real GPC/Groth16 proof for each source. Each proof is bound to the
expected issuer, schema, subject, holder public key, policy and fresh source-specific
challenge. The holder separately signs the exact proof bundle for the verifier's
request. The verifier reconstructs every expected proof configuration and public
input before cryptographic verification. Numeric fields use a fixed scale of 1,000
(up to three decimal places); dates use epoch days.

Exact numeric values, dates, credential records and issuer signatures stay private.
Subjects, holder public keys, trusted issuer keys, policy thresholds and challenges
remain public. Equality checks necessarily imply their required categorical or
boolean value. Failed private preflight sends no proof or source values. These
proofs establish signed assertions and policy satisfaction, not real-world truth.
POD/GPC remains beta and unaudited.

A disclosed comparison mode sends the signed credentials instead, allowing users
to inspect the difference in verifier inboxes. The institution workspace and stage
ownership table show input records, mapped claims, issued credentials, wallet
copies, proof bundles and decision commitments. Internal notes never leave source
stores. Editing any input resets the request and invalidates late async results.

`proofCommitment` hashes the selected presentation. In private mode, `evidenceRoot`
is a hash of the proof-commitment set; in disclosed mode it hashes the credential
set. Neither is a Merkle tree. All stores are logical partitions in browser memory,
with no production access isolation or persistence. Ledger inclusion is a local
illustration, not a chain transaction. Supplier assurance retains its insurance
proof plus local SOC 2 / ISO checks. Demo policies use fixed October 2026 dates.
