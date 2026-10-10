# Guided Sepolia contractor passport

The `/demo` route uses distinct real EVM accounts for fictional institutions.
Cedar Skills Academy issues training, Atlas Field Services issues experience,
Harbor Mutual issues insurance, and Northstar Procurement verifies eligibility.
Synthetic claims are explicitly fictional; authenticated issuers do not establish
real-world qualifications. The advanced `/app` workspace remains separate.

## Host activation

1. Open https://attest.gmac.io/#/demo with a Sepolia-funded wallet.
2. Connect and open **Host: launch the shared demo**.
3. Review the four public institution addresses and funding amount (default
   0.004 Sepolia ETH, split equally). Launch deploys and funds in one transaction.
4. Share the public registry address/invitation after inclusion; wait for finality
   before relying on the deployment. No private key is transferred.
5. The operator validates external Sepolia bytecode, all four wallet addresses,
   and all three credential-key commitments, then sets `registry` in
   `apps/web/public/demo-deployment.json` and redeploys the site.

Both contract and adapter require Sepolia chain 11155111. Invitations have the
form `/#/demo?registry=0x…`. Each read/write validates pinned runtime bytecode and
institution configuration. Anyone may deploy a compatible registry; deployment
confers no issuer authority or accreditation. `fundInstitutions()` refills the
same four wallets. Gas sponsorship is finite, and depleted wallets need test ETH.

## Visitor journey

Connect a real wallet and create an encrypted private passport. Visit Cedar
(at least 24 training hours), Atlas (at least 24 experience months), and Harbor
(at least USD 1M coverage). Each request displays its synthetic input and asks
for an EIP-191 wallet signature binding the account, registry, holder key,
journey, institution, value, expiry, action, domain and Sepolia chain.

The institution processes the synthetic input transiently, signs a POD using its
private credential key, and submits its commitment using its own EVM account.
Visitors sign requests but do not pay gas for these sponsored transactions.
A stable encrypted issuance plan supports recovery after network timeouts.

Northstar's fixed Project 817 policy creates a fresh one-hour request. After
explicit disclosure consent, three real GPC proofs are generated in the browser.
Local checks are available before submission. The Northstar service independently
checks the holder-signed presentation, expected issuer/schema/subject bindings,
thresholds, content/holder commitments, expiry and revocation at one latest block.
Only then does Northstar's wallet record an approval commitment. The contract
authenticates Northstar's transaction; it does **not** verify GPC proofs on-chain.
Replaying the same request does not create another decision or spend more gas.
Revocation is submitted by the original issuer after holder authorization.

## Keys, custody and storage

- `packages/demo/src/config/institutions.json` contains public addresses and POD
  keys only. Each issuer uses a different EVM key and credential key.
- `packages/chain-evm/scripts/provision-institutions.mjs` idempotently provisions
  keys outside the repository in `~/.config/attest/sepolia/institution-wallets.json`
  with mode 0600. Back up this operator secret securely. Cloudflare's
  `INSTITUTION_WALLETS` secret contains the service bundle; no keys enter the client.
  This demo uses operator-managed hot wallets, not independent real organizations.
- Private source input is never persisted by Attest. Issuer signing keys necessarily
  persist as operational secrets. Durable Objects retain public signed transactions,
  hashes, content commitments, retry markers and usage counters, not source values,
  credentials, holder secrets, witnesses or proof bundles. Disable body logging.
- A hidden HMAC-derived credential salt prevents dictionary reconstruction from
  public commitments, while reproducing identical credentials on a safe retry.
- Browser custody uses passphrase-derived AES-GCM encryption, optionally persisted
  locally. Exports are encrypted and bound to account, registry and Sepolia.
  Unlock/restore verifies credential signatures and bindings. Concurrent save
  conflicts are rejected. Losing passport data prevents proof generation;
  blockchain commitments cannot reconstruct private evidence.
- Chain state/calldata/logs disclose wallet, journey commitment, institution,
  content commitment, holder-key commitment, expiry, revocation and decision
  commitments. Public presentations include linkable holder/issuer keys, wallet,
  registry, journey/content IDs, thresholds, validity and challenge. Exact values,
  raw credentials and credential signatures remain hidden from Northstar.

## Service reliability and limits

The API accepts wallet-authorized credential commands at `/api/v2/credentials`
and holder-signed proof bundles at `/api/v2/decisions`. Institution Durable Objects
serialize transactions and persist signed public calldata before broadcasting.
Retries rebroadcast the same transaction/hash and recover the same credential.
A pending transaction blocks later nonce allocation until inclusion is known.
An issuance cannot be replaced with different contents; revocation is permanent.

Requests are bounded to 100 KB. Sponsored transactions are limited to 100/day per
institution and 8/day per holder per institution, at most 20 gwei and 0.002 ETH
estimated gas cost per transaction. These are demo limits, not production abuse
protection. A public demo can exhaust its sponsor allowance. Mainnet is gated.

## Proof runtime and validation

The browser uses the POD/GPC proving backend. Cloudflare Workers cannot run the
snarkjs browser worker loader, so the server-only Groth16 adapter evaluates the
standard pairing equation using noble BN254 arithmetic. It enforces canonical
field encodings and point/subgroup validity. Public verification keys are bundled from the pinned 0.13.0 artifact package; no runtime filesystem or CDN access is needed. Differential tests compare real GPC
proofs with snarkjs and reject modified signals and malformed points. This adapter,
POD/GPC and the overall protocol remain experimental, beta and unaudited.

Contract tests cover distinct authority, unauthorized grants/revokes, expiry,
no overwrite, verifier-only decisions and replay. Browser checks use a local EVM
and Worker to exercise the actual service path. External Sepolia activation is a
separate funded host transaction. Latest-block status can reorganize or change;
an approval receipt never freezes future eligibility. GMA-750 tracks activation;
GMA-748 tracks production prerequisites.
