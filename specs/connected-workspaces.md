# Connected workspaces (experimental)

## Product and custody boundary

Explore contains four fictional, ephemeral institution simulations. The workspace
sandbox retains the original public-key demo and CLI document operations. The
connected Workspace uses locally generated credential-signing keys and an injected
EIP-1193 transaction wallet. Connecting an account is not institutional authority.

Attest operates no private evidence store. Credentials and keys live in browser
memory until an explicit encrypted save or export. The optional browser vault uses
AES-256-GCM, a fresh 96-bit IV and 128-bit salt, and PBKDF2-SHA256 with 310,000
iterations. Account and chain namespace are authenticated additional data. A
minimum twelve-character passphrase is enforced. Use a strong unique passphrase.
An exported encrypted JSON file can be stored wherever its owner chooses. There
is no remote provider integration, recovery escrow, or automatic synchronization.

Back up before locking, navigating away or reloading: memory-only changes disappear.
Losing both the unlocked vault and its backup/passphrase loses the credential key.
An EVM account cannot decrypt a vault by itself. Browser-origin compromise can
access an unlocked vault; encryption at rest does not prevent XSS or malware.
Previously saved local copies persist until explicitly deleted. Concurrent edits
are rejected if the saved encrypted copy changed; cross-device merging is not
implemented. Vaults are separated by account and network.

## Testnet setup

1. Open Workspace with an EIP-1193 wallet on Ethereum Sepolia, chain 11155111.
   Use synthetic evidence. Gas requires that user's funded Sepolia account.
2. In Custody create a vault, choose whether to save an encrypted local copy, and
   export a backup. Each participant uses their own vault and public holder key.
3. In Registry & team, deploy a test registry or enter one whose administrator
   you independently trust. Load permissions. Deployment creates no issuer grants.
4. The administrator grants an issuer address the `attest.connected.training.v1`
   scope and the commitment to its credential-signing public key. Grant verifier
   permission separately if on-chain decision receipts are wanted.
5. The issuer enters subject, holder public key, hours and validity; signs locally;
   exports the signed credential directly to the holder; and anchors its commitment.
6. The holder imports the credential and exports public request metadata. The
   verifier uses this to create its own independently retained request. Requests
   are unsigned: authenticate the communication channel and recipient independently.
7. The holder imports that request, generates a real GPC proof locally, reviews
   the explicit disclosure, and exports the approved presentation to the verifier.
8. The verifier checks its own request against the presentation, issuer grant,
   exact anchored POD content ID, validity and revocation at one displayed block.
   An authorized verifier can optionally record an assertion on-chain. The UI
   rechecks proof and registry state before preparing that transaction.

This change ships a registry deployment tool, not a shared deployed Sepolia
registry. Local integration tests use Anvil with Sepolia's chain ID. They do not
establish external Sepolia deployment or network finality.

## What is public

Chain state/calldata/logs contain account addresses, issuer scope/key commitments,
credential ID/content commitments, expiry, revocation, request/proof commitments
and decision outcomes. An anchor's validity date is public even though the GPC
presentation hides the signed expiry field. Do not mistake hidden proof fields
for secrecy of equivalent public registry metadata.

Presentations expose the subject, holder/issuer public keys, credential ID, POD
content ID, policy threshold, required date and request challenge. Exact training
hours, raw POD and credential signature stay private. IDs and keys correlate
presentations. The content-ID commitment is not a general anonymization mechanism.
Keys, evidence, witnesses and passphrases are never contract arguments. A verifier
receipt commits to a presentation; it does not make that presentation available.

## Contract and verification semantics

`WorkspaceRegistry` is separate from the earlier `AssuranceAnchor` reference.
It enforces an immutable administrator, issuer scopes with signing-key hashes,
unique anchors, future expiry, original-issuer permanent revocation, authorized
verifiers, and per-verifier request uniqueness. Only locally verified presentations
bound to the exact signed POD content ID pass the reference UI's acceptance check.
All proof and authority bindings are also checked off-chain. The administrator
can change trust grants; this is a test governance root, not accreditation.

`recordDecision` records the authorized caller's assertion. It does not verify
GPC/Groth16 on-chain. Independent recipients must verify the proof/status themselves
or explicitly trust the verifier. A state change after preflight can invalidate
an assertion; the receipt does not guarantee continued eligibility. Latest block
reads may be reorganized. The UI distinguishes submitted, included and finalized
transactions and lets users explicitly check canonical finality.

## Production gates

Ethereum mainnet (chain 1) is a read-only configuration. Writes are rejected in
the adapter as well as disabled in the UI. Enabling production needs reviewed
contract deployment/address and bytecode, governance and key rotation/recovery,
proof parameter and artifact integrity review, custody and browser security review,
authenticated request exchange, status/finality policy, integration testing and
operational monitoring. POD/GPC is beta and unaudited. The connected profile is
custom Attest JSON, not a conformant W3C VC or OpenID4VC implementation.
