# Guided Sepolia contractor passport

The `/demo` route is a self-service fictional institution journey with real EVM
wallet transactions. It complements `/app`, the advanced scoped issuer registry.
It does not convert self-issued demo records into real institutional authority.

## Host activation

1. Open https://attest.gmac.io/#/demo in a browser with a Sepolia-funded wallet.
2. Connect, open **Host: launch the shared demo**, then **Launch shared demo**.
3. Review the contract deployment and gas in the wallet. Only Sepolia (11155111)
   is accepted by the adapter and contract constructor.
4. Once included, copy the public registry address/invitation. Wait for finality
   before relying on deployment. Share the invitation to let visitors join.
5. The site operator validates the contract bytecode on Sepolia, sets `registry`
   in `apps/web/public/demo-deployment.json`, builds and deploys. Then visitors
   can enter directly without a registry address. No private key is transferred.

An invitation looks like `/#/demo?registry=0x…`. Address selection remounts and locks
the journey. The client checks exact compiled runtime bytecode before accepting a
registry and before each write/read used for verification. Any visitor can deploy
an identical demo; deployment is not accreditation and conveys no admin privileges.
The compiled bytecode is supplied by the website and inherits its trust boundary.

## Visitor journey

Connect a real wallet, join the registry, and create an encrypted passport. Visit
Cedar Skills Academy (at least 24 training hours), Atlas Field Services (at least
24 experience months), and Harbor Mutual (at least USD 1M coverage). Each fictional
institution signs its own custom POD with a distinct publicly known teaching key.
The user registers each commitment with a separate wallet-approved Sepolia call.

Northstar Procurement creates a fresh one-hour request for Project 817. Review the
public inputs, consent, create three real GPC proofs locally, then share them with
the simulated verifier. It checks the exact expected request, holder signature,
issuer/schema/subject binding, content commitments, current expiry and revocation
at a single latest chain block. Every criterion must pass. A lower input prevents
proof creation. A revocation rejects an already valid proof at the fresh check.
The optional on-chain receipt is the holder's assertion, not a Northstar signature
or on-chain proof verification. The contract prevents same-wallet request replay.

## Data and trust boundaries

- Credential subject binds Sepolia chain, registry, wallet account and random journey
  ID. Each profile/institution has its own schema and signing key.
- Private passport contains random holder secret, raw credentials, exact values,
  signatures and hidden per-credential random salt. Salt prevents guessing hidden
  values by recomputing public POD content IDs from predictable source fields.
- Public presentations include holder/issuer keys, wallet account, registry,
  journey/content IDs, thresholds, validity requirements and challenge. They are
  linkable. Exact values and credential signatures remain hidden.
- Chain state, calldata and logs expose account, journey commitment, institution
  number, salted content commitment, holder-key commitment, expiry and revocation.
  No raw source data, secrets, credentials or witnesses are submitted.
- Issuers are local fictional simulators with intentionally public keys. Anyone
  can reproduce their signatures. Contract writes are holder self-registration;
  they are not authenticated institutional submissions. Real issuer authorization
  belongs to the separate advanced WorkspaceRegistry and production roadmap.
- `DemoJourneyRegistry` is permissionless, immutable and has no administrator.
  Each holder's records are isolated; credentials cannot be overwritten; revocation
  is permanent for a journey/institution. A new journey allows another experiment.
- Verification is off-chain. Latest state may reorganize or change after a check;
  recorded receipts do not freeze future eligibility or establish proof validity.

## Custody and recovery

AES-GCM encrypted browser storage is selected by default but can be disabled.
Passphrase and plaintext never leave the browser. Exports are encrypted portable
JSON files, authenticated to the account + registry + Sepolia namespace. The app
validates every restored credential's signature and contents against its metadata,
issuer, holder, account and journey. Save conflicts are rejected if another tab
changed the encrypted copy. Restore opens in memory without overwriting a saved
copy. Unlocking reads fresh on-chain status. Back up after collecting credentials.

Locking, account/network changes and navigation discard the unlocked memory view.
Losing the key/passphrase without backup prevents proof generation: chain commitments
cannot reconstruct private evidence. An unlocked vault remains exposed to browser
origin compromise. This is beta/unaudited proof-of-concept custody.

## Verification and rollout

Tests cover real proving, altered values, changed wallet/registry/journey, duplicate
issuers, request replay, insufficient experience, stale/revoked/wrong anchors and
encrypted recovery. Anvil contract tests execute isolated grants, replay prevention,
expiry limits, permanent revocation and wallet ownership checks. Browser checks run
against a real local EVM; an external Sepolia-funded deployment is a separate host
action. GMA-750 tracks activation; GMA-748 tracks production security prerequisites.
