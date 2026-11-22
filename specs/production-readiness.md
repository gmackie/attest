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
| Governance | V1 `contracts/src/WorkspaceRegistry.sol`: immutable administrator; scoped issuer grants and signing-key hashes; verifier allowlist. V2 `contracts/src/WorkspaceRegistryV2.sol` (ATTE-23, experimental, `specs/registry-v2-governance.md`): explicit Safe-compatible administrator (`msg.sender` checks only), two-step propose/accept/cancel rotation with 7-day proposal expiry, per-issuer anchor namespaces, `registryVersion()` marker that V1 readers refuse. `packages/chain-evm/src/manifest.ts`: pinned deployment manifest (`contracts/deployments/<chainId>.json`, `attest.deployment-manifest/v1`); V2 status reads refuse a missing record, wrong chain ID or runtime code hash, checked across agreeing RPCs. Anvil drills cover lost-key rotation to a Safe-like contract, cancellation, expiry and manifest refusal | Deploy V2 with a reviewed Safe (signers, threshold, owner-rotation runbook) and commit its manifest; decide on a timelock or Safe delay module; independent audit of V2; exact compiler version in the manifest; no recovery exists for a lost administrator without a pending proposal, so the administrator must be a multisig from deployment |
| Credential revocation | V1: original issuer may revoke its anchor; grant changes affect trust. V2: irreversible administrator emergency revocation of an anchor or an issuer grant with `bytes32` reason codes visible to clients; issuer signing keys with validity windows, non-retroactive retirement and a compromise cutoff (anchored or claimed signed at/after T invalid, earlier anchors stay valid); anchors bind the key in effect, so rotation continues service without invalidating history. `registryV2AnchorStatus` reports `emergency_revoked`, `key_compromised`, `key_not_yet_valid`, `key_expired` | Operating runbook for compromise reporting (who chooses T, alerting, re-issuance); review of issuer self-reported compromise; verifiers must pass the credential's signing time where available; migrate or retire V1 deployments, whose readers ignore V2 key lifecycle |
| Proofs and artifacts | POD/GPC versions pinned; Worker verification keys bundled; browser artifacts fetched from versioned CDN | Independent cryptographic review or an explicitly reviewed constrained-use decision; hashes/provenance for circuit, WASM, zkey and verification keys; fail closed on mismatches and unsupported circuits |
| Request exchange | Connected workspace compares the verifier's retained request and context; `specs/connected-workspaces.md` documents unsigned request exchange | Authenticated issuer/verifier discovery and request channel or signed request protocol with audience, expiry and replay protection; user-entered issuer addresses alone are insufficient |
| Status and finality | Connected verification checks issuer grant, exact anchor, expiry and revocation at a displayed block; UI offers finality checks. `packages/chain-evm/src/status.ts` (ATTE-18) adds a ChainStatusReader that reads at a finalized or N-confirmation block, requires two agreeing RPC endpoints by default, re-checks the block hash after reads (reorg detection), refuses stale heads, and returns chain evidence for `@attest/verifier`. The hosted demo issuer (ATTE-27) checks decisions at 3 confirmations through two agreeing RPCs, answers `409 awaiting_confirmations` while the confirmed and latest states differ, and records the checked block hash; the demo deliberately uses confirmations, not finality, for usability. Pilot verifiers should use finality | Chain-specific confirmation/finality policy, bounded freshness, reorg handling and independent RPC consistency checks; proof acceptance must not silently use stale status |
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
