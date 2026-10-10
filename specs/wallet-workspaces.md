# Wallet workspaces (experimental v1alpha1)

The demo now has personal and organizational workspaces backed by the same Effect
operations as the CLI. Jordan holds credentials, Alder Nursing Board issues a
license, Pine Training Institute issues training evidence, and Willow Creek
Hospital requests and verifies a presentation. The existing industry walkthroughs
remain available separately.

## Documents and operations

`pnpm attest schema --json` exposes the JSON Schema generated from runtime
validators. YAML and JSON are accepted for these document kinds:

- `Wallet`: display name, fixed demo roles, key references, and agent permissions.
  Only display names are editable in this slice. Documents cannot grant authority.
- `IssuanceTemplate`: issuer, subject, schema, and source claims. Applying a template
  updates the issuer's local source record; issuance is a separate approved action.
- `TrustProfile`: inspectable fixed issuer keys and schema scopes. The hospital
  recognizes Alder's license assertions only for Michigan. This profile is not
  user-editable in the current UI or CLI.
- `PresentationRequest`: subject, purpose, audience, challenge, disclosure mode,
  requirements, creation/expiry, and status freshness bound. The hospital signs it.
- `DecisionRecord`: timestamped results for authenticity, recognition, current
  status, and request satisfaction. Downloadable; not a legally binding decision.

Unknown document fields and duplicate YAML keys are rejected. YAML alias expansion
is disabled and input documents are limited to 100 KB. Parsed values are validated
before being used. Documents use the project's existing custom commitment encoding;
this is not RFC 8785 or JSON-LD canonicalization conformance.

## Try the CLI

Requires Node 24.14+ and the installed pnpm workspace dependencies. From repo root:

```sh
pnpm attest init
pnpm attest issue --actor board --approve
pnpm attest issue --actor training --approve
pnpm --silent attest request draft > request.yaml
pnpm attest request create --actor hospital --file request.yaml
pnpm attest prepare --actor jordan
pnpm attest inspect --actor jordan --json
pnpm attest send --actor jordan --approve
pnpm attest verify --actor hospital --json
```

The default is two real GPC proofs. Proof artifacts are fetched from the pinned
upstream CDN by the existing proof adapter. To use installed artifacts, pass
`--artifacts packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts` to prepare
and verify. For fast disclosed comparison, generate a request using
`request draft --mode disclosed-records`; this deliberately shares signed records.

```sh
pnpm attest document --actor jordan
pnpm attest template show --actor board
pnpm attest template apply --actor board --file template.yaml
pnpm attest trust --actor hospital
pnpm attest revoke --actor board --credential CREDENTIAL_ID --approve
pnpm attest verify --actor hospital --json
pnpm attest status refresh --actor board
pnpm attest status offline --actor hospital
```

Use `inspect --actor board --json` to find the credential ID. Revocation is
irreversible in this workspace; reissue a new credential and make a fresh request.
Refreshing status preserves revocation. A pending outage decision is different
from rejection. Decisions remain historical until explicitly rechecked.

All commands support `--state PATH`; default `./attest-wallet-demo.json`. Init never
overwrites an existing file. Writes use an exclusive lock, a mode-0600 temporary
file and atomic rename. A process killed while holding a lock can leave a `.lock`
file: only remove it after confirming the process has exited. Human output is YAML;
`--json` emits machine-readable output and failures have nonzero exit status.
Use `pnpm --silent` when redirecting documents to avoid package-manager log output.

`--agent` permits reads, presentation preparation, and verification. It rejects
issuance, sending, revocation and configuration mutations even with `--approve`.
This is an explicit execution mode, not authentication of an actual agent process.
The Node launcher adapts the upstream blakejs CommonJS exports for ESM consumers;
it does not alter crypto primitives or browser resolution.

## Presentation and verification boundaries

Private presentations contain issuer-specific proofs and a holder signature.
Public inputs expose the subject, holder key, accepted issuer keys, credential IDs,
required license scope, thresholds, request binding, and proof metadata. Exact
training hours, expiry dates and original credential signatures stay out of the
verifier presentation. Identifiers can correlate presentations. The license encodes
active status and jurisdiction as one signed `licenseScope` value to fit the
supported GPC circuit. Validity is modeled as an inclusive UTC calendar date.

The request digest includes all request fields. Each proof binds its credential ID
so status cannot be substituted from another credential. The holder signs the
entire bundle. Sending requires explicit approval, checks the current request and
rejects a second presentation for the same request. Verification checks the exact
request, audience, subject, holder, both independent issuers, schema, constraints,
and signed freshness-bounded issuer status. Revocation is a separate status check;
it is not a claim that the GPC proof proves live status.

## Persistence and security boundary

This remains a fictional local simulation, not a production wallet. All demo keys
are public and deterministically reproducible. Participant selection and CLI
`--actor` are role simulation, not authentication. Source data and all workspaces
share the browser origin's unencrypted localStorage or the CLI state file. The
role-specific UI and inspect projections are not an access isolation boundary.
Never use real records, secrets, or identities here. Browser and CLI storage are
independent; no synchronization is implemented.

Browser operations save only after a successful command and report storage errors.
A stale-tab check rejects writes if another tab changed storage during preparation;
it is not a multi-user transaction system. Reset deletes this demo's browser state.

Passkeys, secure keystores, recovery, authenticated team permissions, managed agent
identities, production key rotation, live status endpoints, and OpenID/VC adapters
are future integrations. POD/GPC remains beta and unaudited. No chain transaction
is submitted. The format is an experimental Attest profile, not an adopted standard.

## Example wallet manifest

```yaml
apiVersion: attest.dev/v1alpha1
kind: Wallet
id: jordan
name: Jordan Lee
roles:
  - holder
key:
  provider: demo-keystore
  reference: demo:jordan:signing
agentPolicy:
  allow:
    - inspect
    - evaluate
    - prepare
  approvalRequired:
    - issue
    - send
    - revoke
```

The approval list is not a grant of those operations: Jordan cannot issue or revoke
institutional credentials. Actor scope is enforced first. `demo-keystore` is a
reference to reproducible public sandbox keys, not encrypted key custody.
