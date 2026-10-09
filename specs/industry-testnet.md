# Connected industry journeys

ATTE-4 extends the Sepolia demo to healthcare, education and cold-chain logistics.
Each has five issuer wallets and one verifier wallet. The existing contractor
journey and InstitutionRegistry remain compatible. `/demo` selects a journey;
old contractor invitations at `/demo?registry=...` continue to work.

| Journey | Issuing institutions | Verifier |
| --- | --- | --- |
| Healthcare | Aster Nursing Board; Pulse Training Institute; Harbor Community Clinic; ClearPath Screening; Everwell Occupational Health | Willow Creek Hospital |
| Education | Westhaven University; Lingua Assessment; Brightpath Foundation; Summit Course Registry; Crescent Education Trust | Northbridge Graduate School |
| Logistics | ThermoTrace Monitoring; Clearwell Laboratories; Polar Route Transport; Precision Calibration Bureau; Alpine Manufacturing QA | Cedarway Pharmacy |

## Visitor experience

Connect an injected EVM wallet on Sepolia, join the industry's registry, and create
an encrypted passport. Each step explains the source system, editable synthetic
input, signed statement, public commitment and verifier's view. Multiple claims
from a source are signed and proven together. No cross-issuer combination can
substitute for a coherent record. Inspect detailed clauses and select standard,
enhanced or critical assurance at the verifier step. Defaults pass standard;
stricter levels intentionally expose insufficient evidence.

The holder signs an EIP-191 command containing industry, account, registry,
journey, holder key, institution, exact fields, action, validity, consent, expiry
and nonce. The institution service processes synthetic fields transiently, signs
a salted POD with its private key, and sponsors the commitment transaction. Retry
plans are saved in the encrypted passport before issuance. Identical retries
recover the same credential and transaction; differing contents are rejected.

After explicit consent, five GPC proofs are generated locally. The request binds
the full agreement commitment, level, audience, account, registry, industry,
journey, expected content IDs and fresh challenge. The holder key signs the entire
presentation. The server rebuilds the policy from its own definitions, verifies
all proofs, requires source validity dates to cover the request expiry date as well as contractual minimum dates, and checks five records at one latest chain block. Only its designated
verifier wallet can record a decision. Revocation remains issuer-authorized and
permanent. Subsequent checks reject revoked evidence even if a receipt exists.

## Registry and deployment

`IndustryRegistry` is Sepolia-only. Its constructor pins the profile commitment,
six distinct addresses, and five credential-key commitments. All are immutable by
interface. Issuer slots 0–4 have separate grant/revoke authority; slot 5 alone
records decisions. Runtime bytecode, profile, wallets and keys are validated by
both the client and service. The EVM authenticates writes; it does not run GPC.

Each industry's Host screen deploys and funds in one wallet transaction. Default
funding is 0.006 Sepolia ETH, divided equally among six wallets, plus deployment
gas. `fundInstitutions()` supports subsequent refills. Public invitations take the
form `/#/demo/healthcare?registry=0x…`. Configure validated shared addresses in
`apps/web/public/industry-deployments.json` only after external Sepolia deployment.
Local Anvil checks do not establish external deployment or funding.

Provision keys idempotently with
`node packages/chain-evm/scripts/provision-industry-wallets.mjs`. Private keys stay
in `~/.config/attest/sepolia/industry-wallets.json` (0600); the script also writes compact `industry-worker-secret.json` in the same protected directory. Install that compact JSON as the Cloudflare `INDUSTRY_WALLETS` secret (the complete backup exceeds Cloudflare’s 5 KB secret limit). The committed directory is public-only.
These fictional institutions share an operator; this does not claim independent
real-world organizational custody, accreditation or authorization.

## API and custody boundaries

- `GET /api/v3/institutions`: public directory and configuration presence.
- `POST /api/v3/credentials`: wallet-authorized issue/revoke command.
- `POST /api/v3/decisions`: holder-signed, contract-bound presentation.
- Durable Objects are isolated per industry and institution. Transaction nonce
  serialization, safe rebroadcast, sponsor limits and bounded 100 KB requests
  reuse the contractor service machinery.
- Private fields, PODs, witnesses and holder secrets are never persisted server-side.
  Operational signer secrets, public signed transactions, commitments, retry
  metadata and usage counters persist. No request-body logging is enabled.
- Browser storage and portable backups use passphrase-derived AES-GCM, bound to
  industry, wallet, registry and Sepolia. Restored POD signatures and all fields
  are validated. Account/network changes discard unlocked state; concurrent
  browser writes fail rather than silently overwrite.
- Public proof inputs are linkable. Equality clauses disclose the required value;
  thresholds hide exact numeric values. The UI explicitly explains this boundary.
  Fictional license, health, funding and telemetry claims are not real evidence.

POD/GPC and the Worker verifier remain experimental and unaudited. Mainnet stays
disabled. Source defaults and agreement clauses are illustrative; future production
profiles require issuer governance, current temporal policy, audits, secure key
management and operational abuse controls (GMA-748).
