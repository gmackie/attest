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

## Guided stories and reference kernel

Explore contains supplier assurance, healthcare, education and logistics. Each
story follows source capture, claim preparation, signing, wallet custody,
presentation, verification and simulated anchoring. Inspect institution forms,
signed statements, private proving inputs, public proof packages and who sees each
copy. Agreement and ownership details open on demand. All four stories use real
issuer-specific proofs in private mode; their ledger is explicitly simulated.

The earlier insurance/network reference kernel remains in `packages/demo` and its
tests, including Semaphore holder binding and authority-chain examples. Its old
monolithic walkthrough is superseded in the UI by the routed stories. This
separates that legacy single-insurance circuit from the current twenty-clause
supplier flow. Proof computation reports completion only after the prover and
verifier return. No story submits transactions; connected actions live separately
in Workspace.

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
illustration, not a chain transaction. Supplier assurance now proves all twenty criteria from seven separately signed sources. Demo policies use fixed October 2026 dates.

## Detailed approval contracts

All four industries include standard, enhanced and critical
agreements. Healthcare, education and logistics each have ten numbered executable clauses; supplier assurance has twenty. Each clause has a named issuer, schema,
subject, comparison, privacy explanation and failure consequence. Contract levels
change actual thresholds and validity requirements; the baseline source records
need not satisfy critical engagements. The explorer includes parties, scope,
data-handling terms, re-evaluation triggers, an explicit enforcement boundary and
a downloadable canonical JSON document. Issued-statement inspectors show the exact
assertions and original signed record.

Capture hashes the complete agreement into the request challenge. Verification
recomputes that digest, including descriptive terms, to reject agreement
substitution. Private proofs and holder presentations remain bound to the fresh
challenge. All clauses are conjunctive; no alternatives or cross-source arithmetic
are implied. Retention and future-monitoring duties are explanatory only. These
are fictional approval specifications, not legal advice or on-chain contracts.

## EVM and credential clearinghouses

The shared architecture explorer walks through ABI call preparation, transaction
signing and gas, RPC submission, EVM execution, finality, and application-level
interpretation. It separates contract state, public calldata/logs, and private
evidence/witness custody, and documents AssuranceAnchor’s actual enforcement
boundary: receipt events contain caller assertions, not verified proofs.

Four proposed coordination models compare direct federation, registry services,
managed verification, and consortium governance. A clinical example traces scoped
authorities through holder presentations to independent buyer verification. Six
illustrative decision scenarios explain revocation, freshness, request binding,
untrusted receipt callers, and outages. These are educational UI states, not live
status checks, deployed clearinghouses, or blockchain transactions.

## Standards composition map

The interactive standards explorer covers every ecosystem named in the composition
proposal: RDF/JSON-LD, PROV-O, SKOS, SHACL, W3C Verifiable Credentials, Open Badges,
CTDL, ISO/IEC 11179 governance principles, OpenID4VCI/OpenID4VP, and federation /
recognized entities. Each entry explains its role, example handoff, authoritative
reference, and implementation boundary. These remain proposed alignments.

Separate entries describe the implemented POD/GPC/Groth16 backend, legacy insurance
Semaphore V4 identity binding, SHA-256 commitments with custom serialization, the
local Attest model, domain examples, and the optional EVM reference contract. The
map does not claim VC, OpenID, JSON-LD, SHACL, or domain certification conformance.
A worked composition explains why importing or re-signing credentials requires
explicit provenance and trust rules rather than assuming proof compatibility.

## Personal and organization wallet workspaces

Explore → workspace sandbox opens a persistent fictional wallet workspace: issue credentials as the
board and training provider, create a hospital request, prepare private proofs as
Jordan, inspect and approve disclosure, then verify at the hospital. Revoke a
credential and recheck to see a distinct current-status failure. A status outage
produces a pending decision, not approval. Existing industry journeys are still
available through **Explore**.

`pnpm attest --help` opens the matching CLI. UI and CLI share document validation,
issuance, proof preparation, request binding, approval, status, and verification
operations. Both expose readable wallet manifests, issuance templates, trust
profiles, requests and decision records with a generated JSON Schema. See
[wallet-workspaces.md](specs/wallet-workspaces.md) for the runnable CLI sequence,
format, privacy boundary, and storage details.

This is a fictional local sandbox: public demo keys, simulated participant roles,
and unencrypted storage. It does not implement passkey login, production key
custody, team authentication, or live standards adapters. Never enter real data.

## Connected workspaces and custody

The site separates Explore, Workspace, Learn, and Developers. Workspace connects
an injected EIP-1193 wallet to Ethereum Sepolia (11155111); Ethereum (1) is
configured but production writes are disabled. Holder, issuer, verifier and registry
administration tasks use a separate `WorkspaceRegistry` contract, not the legacy
`AssuranceAnchor`. No shared external registry has been deployed by this change.
A user can deploy a test registry with their own funded Sepolia account.

Private evidence stays in memory or an opt-in AES-GCM encrypted browser vault.
Portable encrypted files can be stored with a provider of the user's choice;
there is no Attest evidence server or automatic remote synchronization. This is
experimental custody, not production key management. See
[connected-workspaces.md](specs/connected-workspaces.md) for setup, disclosure,
contract semantics, recovery and outstanding production gates.

## Guided testnet passport

**Testnet demo** (`/#/demo`) walks visitors through fictional training, employment
experience and liability assurance institutions using their own Sepolia wallet.
The guided flow handles issuance, salted content anchoring, explicit disclosure,
three real private proofs and current chain-status verification without JSON
copy/paste. An optional holder-recorded receipt is clearly distinguished from
on-chain proof verification.

The host launches the shared `DemoJourneyRegistry` with one funded Sepolia wallet
transaction, shares the generated invitation, and supplies its public address for
`apps/web/public/demo-deployment.json`. Until that transaction, the launch screen
shows the pending setup rather than inventing a deployment. See
[guided-testnet.md](specs/guided-testnet.md) for host activation, custody, wallet
requirements, fictional issuer semantics and the on-chain data boundary.
