# Ethereum production readiness

Review baseline: merged Attest revision `ef21de5455965560076a069ee6b63fa0c2bd44b6`.
Tracked by GMA-748. This source review records existing controls and unmet release
requirements; it is not an independent contract or cryptography audit. Ethereum
mainnet writes remain disabled. Deployment of the website does not enable them.

## Assets and trust boundaries

The holder owns credential-signing keys, source credentials, witnesses, and the
vault passphrase. Browser memory contains plaintext while unlocked. Encrypted
exports and optional local storage cross the browser persistence boundary; the
account/chain namespace is authenticated with AES-GCM. A compromised origin,
extension, device, or third-party script can read an unlocked vault. An EVM wallet
connection does not establish institutional authority or recover a lost vault.

Issuer and verifier signing keys are distinct from holder keys. The hosted demo
service holds synthetic institution keys in Worker secrets and sponsors Sepolia
transactions. Wallet-signed commands cross an untrusted HTTP boundary; contract
code, profile, pinned institution addresses and signing keys are checked before
execution. These fictional identities are not a production accreditation root.

The registry administrator controls grants. RPC providers supply code and status
observations; their chain identity and responses are part of the trust model.
Proof verification depends on the expected request, allowed issuers, holder,
policy configuration and circuit artifacts. A mathematically valid proof alone
does not establish current authority, revocation, or real-world truth.

Public calldata, addresses, timestamps, expiry, credential/content commitments,
request/proof commitments and decision outcomes can correlate activity. Neither
salted commitments nor hidden proof inputs erase metadata already on-chain.

## Reviewed controls and release gaps

| Area | Source evidence | Requirement before mainnet writes |
| --- | --- | --- |
| Write gate | `packages/chain-evm/src/connected.ts` rejects production deployment and every registry action before provider access; UI disables writes | Retain the closed gate until a reviewed release profile exists; run direct-adapter rejection tests in CI |
| Custody | `packages/wallet/src/custody.ts`: AES-256-GCM, fresh IV/salt, PBKDF2-SHA256 310,000 iterations, authenticated account/chain namespace; negative recovery tests | Browser/XSS and dependency review; passphrase threat model; tested lost-device, key compromise and backup lifecycle; no claim that encryption protects an unlocked origin |
| Governance | `contracts/src/WorkspaceRegistry.sol`: immutable administrator; scoped issuer grants and signing-key hashes; verifier allowlist | Reviewed multisig/administrator lifecycle, replacement/recovery procedure, audited contracts and pinned deployment manifest; current contract cannot rotate the administrator |
| Credential revocation | Original issuer may revoke its anchor; grant changes affect trust | Define recovery when the original issuer key is lost, historical key rotation semantics, and compromise cutoff; current registry has no administrator emergency credential revocation |
| Proofs and artifacts | POD/GPC versions pinned; Worker verification keys bundled; browser artifacts fetched from versioned CDN | Independent cryptographic review or an explicitly reviewed constrained-use decision; hashes/provenance for circuit, WASM, zkey and verification keys; fail closed on mismatches and unsupported circuits |
| Request exchange | Connected workspace compares the verifier's retained request and context; `specs/connected-workspaces.md` documents unsigned request exchange | Authenticated issuer/verifier discovery and request channel or signed request protocol with audience, expiry and replay protection; user-entered issuer addresses alone are insufficient |
| Status and finality | Connected verification checks issuer grant, exact anchor, expiry and revocation at a displayed block; UI offers finality checks | Chain-specific confirmation/finality policy, bounded freshness, reorg handling and independent RPC consistency checks; proof acceptance must not silently use stale status |
| Hosted institutions | `apps/issuer/src/index.ts` checks Sepolia chain, exact runtime, institution keys, wallet signatures, idempotency and sponsored quotas | Production issuer onboarding, key isolation/rotation, abuse policy, authenticated exchange and operating runbooks; do not repurpose synthetic testnet keys |
| Receipts | `recordDecision` checks authorized verifier and request uniqueness | Document that receipts assert the caller's decision, not on-chain proof verification; recipients must verify independently or adopt explicit verifier trust |
| Delivery | ForgeGraph binds CI, deployment source, Worker artifact and production health; ATTE-6/7 completed | Keep production evidence for each future release, rollback rehearsals, incident handling, key compromise alerts and security review sign-off |

## Required acceptance evidence

GMA-748 remains open until the unresolved requirements above are implemented and
reviewed. Each independent change needs an owning issue, regression evidence,
reviewed source revision and verified delivery. Keep the mainnet gate closed
through intermediate releases. Do not replace it with a browser flag, environment
variable or unchecked registry address.

The release dossier must identify contract source/compiler settings, creation and
runtime bytecode hashes, chain/address/admin, authority grants and key lifecycle,
proof artifact hashes and reviewed usage constraints, custody recovery results,
request authentication, finality/freshness policy, and deployed service versions.
Include adverse tests for wrong chain/account, request substitution, unknown or
rotated keys, expiry/revocation, stale/reorganized status, artifact tampering and
recovery failure. Require independent review of security-sensitive assumptions;
passing repository tests does not constitute that review.

External Sepolia activation and its end-to-end exercise are owned by ATTE-4 and
GMA-750 in the separate testnet thread. Their evidence should be linked here when
available. This readiness work neither submits transactions nor changes registry
defaults, public invitations, or funding manifests.
