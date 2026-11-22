/**
 * WorkspaceRegistryV2 client: governance-aware anchor status, issuer key validity at a time,
 * and gated writes. Reads go through ChainStatusReader (agreeing RPCs at one settled block) and
 * always check the registry's runtime code against the pinned deployment manifest in the same
 * read, so status from an unpinned or substituted registry is refused rather than returned.
 *
 * Semantics: specs/registry-v2-governance.md.
 */
import { encodeAbiParameters, encodeFunctionData, hexToString, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { ChainStatusError, chainEvidence, type ChainSnapshot, type ChainStatusReader, type WorkspaceAnchorQuery } from "./status";
import { assertPinnedCode, codeHashAt, pinnedDeployment, runtimeCodeHash, type DeploymentManifest } from "./manifest";

export const REGISTRY_V2_CONTRACT = "WorkspaceRegistryV2";

export const registryV2Abi = parseAbi([
  "constructor(address administrator_)",
  // V1-compatible surface.
  "function administrator() view returns (address)",
  "function issuers(address,bytes32) view returns (bool enabled,bytes32 signingKeyHash)",
  "function verifiers(address) view returns (bool)",
  // V2: keyed by anchorKey(issuer, id), not by the issuer-chosen id.
  "function anchors(bytes32) view returns (address issuer,bytes32 scope,bytes32 commitment,uint64 validUntil,bool revoked)",
  "function usedRequests(address,bytes32) view returns (bool)",
  "function configureIssuer(address issuer,bytes32 scope,bytes32 signingKeyHash,bool enabled)",
  "function configureVerifier(address verifier,bool enabled)",
  "function anchor(bytes32 id,bytes32 scope,bytes32 commitment,uint64 validUntil)",
  "function revoke(bytes32 id)",
  "function recordDecision(bytes32 requestCommitment,bytes32 proofCommitment,bool satisfied)",
  // V2 governance.
  "function registryVersion() pure returns (uint256)",
  "function anchorKey(address issuer,bytes32 id) pure returns (bytes32)",
  "function OPEN_ENDED() view returns (uint64)",
  "function PROPOSAL_TTL() view returns (uint64)",
  "function pendingAdministrator() view returns (address)",
  "function pendingAdministratorDeadline() view returns (uint64)",
  "function anchorBindings(bytes32) view returns (bytes32 signingKeyHash,uint64 anchoredAt)",
  "function issuerKeys(address,bytes32) view returns (uint64 validFrom,uint64 validUntil,uint64 compromisedAt,bytes32 compromiseReason)",
  "function anchorRevocations(bytes32) view returns (bytes32 reason,uint64 revokedAt)",
  "function grantRevocations(address,bytes32) view returns (bytes32 reason,uint64 revokedAt)",
  "function keyUsableAt(address issuer,bytes32 signingKeyHash,uint64 at) view returns (bool)",
  "function proposeAdministrator(address next)",
  "function cancelAdministratorProposal()",
  "function acceptAdministrator()",
  "function registerIssuerKey(address issuer,bytes32 signingKeyHash,uint64 validFrom,uint64 validUntil)",
  "function rotateIssuerKey(address issuer,bytes32 scope,bytes32 signingKeyHash)",
  "function retireIssuerKey(address issuer,bytes32 signingKeyHash,uint64 validUntil)",
  "function markIssuerKeyCompromised(address issuer,bytes32 signingKeyHash,uint64 compromisedAt,bytes32 reason)",
  "function emergencyRevokeAnchor(address issuer,bytes32 id,bytes32 reason)",
  "function emergencyRevokeGrant(address issuer,bytes32 scope,bytes32 reason)",
  "event AdministratorProposed(address indexed current,address indexed proposed,uint64 deadline)",
  "event AdministratorProposalCancelled(address indexed current,address indexed proposed)",
  "event AdministratorChanged(address indexed previous,address indexed current)",
  "event CredentialAnchored(bytes32 indexed id,address indexed issuer,bytes32 scope,bytes32 commitment,uint64 validUntil)",
  "event CredentialRevoked(bytes32 indexed id)",
  "event CredentialKeyBound(bytes32 indexed key,address indexed issuer,bytes32 indexed id,bytes32 signingKeyHash,uint64 anchoredAt)",
  "event IssuerKeyRegistered(address indexed issuer,bytes32 indexed signingKeyHash,uint64 validFrom,uint64 validUntil)",
  "event IssuerKeyRetired(address indexed issuer,bytes32 indexed signingKeyHash,uint64 validUntil)",
  "event IssuerKeyCompromised(address indexed issuer,bytes32 indexed signingKeyHash,uint64 compromisedAt,bytes32 reason)",
  "event IssuerKeyRotated(address indexed issuer,bytes32 indexed scope,bytes32 previousKeyHash,bytes32 signingKeyHash)",
  "event AnchorEmergencyRevoked(bytes32 indexed key,address indexed issuer,bytes32 indexed reason,bytes32 id,uint64 revokedAt)",
  "event GrantEmergencyRevoked(address indexed issuer,bytes32 indexed scope,bytes32 indexed reason,uint64 revokedAt)",
  "error Unauthorized()",
  "error InvalidInput()",
  "error AlreadyUsed()",
  "error NotPendingAdministrator()",
  "error ProposalExpired()",
  "error GrantRevoked()",
  "error KeyUnusable()",
]);

const fail = (code: string, detail?: string): never => { throw new ChainStatusError(code, detail); };
const ZERO32 = /^0x0{64}$/i;

/** Storage key of an issuer's anchor id in V2 (mirrors the contract's anchorKey). */
export const registryV2AnchorKey = (issuer: Address, id: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [issuer, id]));

// ---------------------------------------------------------------- reason codes

/**
 * Suggested revocation/compromise reason labels. Reason codes are bytes32: a short ASCII label,
 * right-padded with zeros, so explorers and clients can read them without a lookup table.
 * Any non-empty label up to 31 characters is accepted; these are conventions, not an enum.
 */
export const registryReasons = [
  "key_compromise", "issuer_account_lost", "issued_in_error", "issuer_misconduct",
  "authority_withdrawn", "legal_order", "superseded",
] as const;
export function reasonCode(label: string): Hex {
  if (!/^[a-z0-9_.:-]{1,31}$/.test(label)) fail("invalid_reason", label);
  return toHex(label, { size: 32 });
}
/** Decode a bytes32 reason; returns undefined if it is not a printable label. */
export function reasonLabel(code: Hex): string | undefined {
  if (ZERO32.test(code)) return undefined;
  const text = hexToString(code, { size: 32 }).replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(text) ? text : undefined;
}

// ---------------------------------------------------------------- status

/** `anchorId` is the issuer-chosen id; the client derives the storage key from (issuer, anchorId). */
export interface RegistryV2AnchorQuery extends WorkspaceAnchorQuery {
  /**
   * Signing time asserted by the credential itself (ms), if the verifier has one. Key validity
   * and compromise cutoff are checked at this time as well as at the on-chain anchoring time.
   */
  signedAt?: number;
}
export type RegistryV2Reason =
  | "anchor_revoked" | "anchor_expired" | "issuer_grant_inactive"
  | "emergency_revoked" | "key_compromised" | "key_not_yet_valid" | "key_expired";
export interface Revocation { target: "anchor" | "grant"; reason: Hex; label?: string; revokedAt: number }
export type RegistryV2AnchorStatus = {
  status: "active" | "revoked" | "superseded" | "expired";
  reason?: RegistryV2Reason;
  /** Present for emergency revocations: who/what was revoked, and the on-chain reason code. */
  revocation?: Revocation;
  /** Key compromise details, when reason is key_compromised. */
  compromise?: { compromisedAt: number; reason: Hex; label?: string };
  /** Anchor validity end, ms. */
  validUntil: number;
  /** Block time the anchor was written, ms. */
  anchoredAt: number;
  signingKeyHash: Hex;
  evidence: ReturnType<typeof chainEvidence>;
};

type KeyTuple = readonly [bigint, bigint, bigint, Hex];
type KeyCheck = { valid: true } | { valid: false; reason: "key_unknown" | "key_compromised" | "key_not_yet_valid" | "key_expired" };
/** Pure key-window check at time `at` (seconds). Compromise wins over window reasons. */
export function keyValidityAtSeconds(key: KeyTuple, at: bigint): KeyCheck {
  const [validFrom, validUntil, compromisedAt] = key;
  if (validUntil === 0n) return { valid: false, reason: "key_unknown" };
  if (compromisedAt !== 0n && at >= compromisedAt) return { valid: false, reason: "key_compromised" };
  if (at < validFrom) return { valid: false, reason: "key_not_yet_valid" };
  if (at >= validUntil) return { valid: false, reason: "key_expired" };
  return { valid: true };
}
const msToSeconds = (ms: number) => {
  if (!Number.isSafeInteger(ms) || ms < 0) fail("invalid_query", "signedAt");
  return BigInt(Math.floor(ms / 1000));
};

/**
 * V2 equivalent of workspaceAnchorStatus. Reads, at one settled block and on every endpoint:
 * the registry runtime code hash (must match the pinned manifest), the anchor, the key it was
 * bound to, that key's lifecycle, both emergency revocation records and the issuer grant.
 *
 * Differences from V1: an anchor is checked against the key bound when it was written, not the
 * grant's current key, so key rotation does not invalidate earlier anchors (query.signingKeyHash
 * must equal the bound key or the read fails closed with anchor_mismatch). Returns null when no
 * anchor exists.
 */
export async function registryV2AnchorStatus(
  reader: ChainStatusReader,
  manifest: DeploymentManifest | null | undefined,
  query: RegistryV2AnchorQuery,
  snapshot?: ChainSnapshot,
): Promise<RegistryV2AnchorStatus | null> {
  const record = pinnedDeployment(manifest, { chainId: reader.options.chainId, contract: REGISTRY_V2_CONTRACT, address: query.registry });
  const signedAt = query.signedAt === undefined ? undefined : msToSeconds(query.signedAt);
  const at = snapshot ?? (await reader.snapshot());
  const address = record.address;
  const storageKey = registryV2AnchorKey(query.issuer, query.anchorId);
  const [codeHash, anchor, bound, key, anchorRevocation, grantRevocation, grant] = (await reader.read(at, (client, blockNumber) => {
    const read = (functionName: string, args: readonly unknown[]) =>
      client.readContract({ address, abi: registryV2Abi, functionName, args, blockNumber });
    return Promise.all([
      codeHashAt(client, address, blockNumber),
      read("anchors", [storageKey]),
      read("anchorBindings", [storageKey]),
      read("issuerKeys", [query.issuer, query.signingKeyHash]),
      read("anchorRevocations", [storageKey]),
      read("grantRevocations", [query.issuer, query.scope]),
      read("issuers", [query.issuer, query.scope]),
    ]);
  })) as [Hex | null, [Address, Hex, Hex, bigint, boolean], [Hex, bigint], KeyTuple, [Hex, bigint], [Hex, bigint], [boolean, Hex]];
  assertPinnedCode(record, codeHash);

  const [issuer, scope, commitment, validUntil, revoked] = anchor;
  if (/^0x0{40}$/i.test(issuer)) return null;
  const [boundKey, anchoredAt] = bound;
  if (issuer.toLowerCase() !== query.issuer.toLowerCase() || scope.toLowerCase() !== query.scope.toLowerCase() ||
    commitment.toLowerCase() !== query.commitment.toLowerCase() || boundKey.toLowerCase() !== query.signingKeyHash.toLowerCase())
    fail("anchor_mismatch");

  const base = {
    validUntil: Number(validUntil) * 1000, anchoredAt: Number(anchoredAt) * 1000,
    signingKeyHash: boundKey.toLowerCase() as Hex, evidence: chainEvidence(at),
  };
  const revocation = (target: Revocation["target"], [reason, revokedAt]: [Hex, bigint]): Revocation => {
    const label = reasonLabel(reason);
    return { target, reason: reason.toLowerCase() as Hex, ...(label ? { label } : {}), revokedAt: Number(revokedAt) * 1000 };
  };
  // Emergency revocations are permanent and apply regardless of time or key.
  if (anchorRevocation[1] !== 0n)
    return { status: "revoked", reason: "emergency_revoked", revocation: revocation("anchor", anchorRevocation), ...base };
  if (grantRevocation[1] !== 0n)
    return { status: "revoked", reason: "emergency_revoked", revocation: revocation("grant", grantRevocation), ...base };
  if (revoked) return { status: "revoked", reason: "anchor_revoked", ...base };

  // Key lifecycle at the anchoring time and at the credential's own signing time, if given.
  for (const t of signedAt === undefined ? [anchoredAt] : [anchoredAt, signedAt]) {
    const check = keyValidityAtSeconds(key, t);
    if (check.valid) continue;
    // The contract registers every key it binds, so an unknown bound key means a corrupted read.
    if (check.reason === "key_unknown") fail("anchor_mismatch", "bound key not registered");
    if (check.reason === "key_compromised") {
      const label = reasonLabel(key[3]);
      return { status: "revoked", reason: "key_compromised", ...base,
        compromise: { compromisedAt: Number(key[2]) * 1000, reason: key[3].toLowerCase() as Hex, ...(label ? { label } : {}) } };
    }
    return { status: "revoked", reason: check.reason as "key_not_yet_valid" | "key_expired", ...base };
  }
  if (validUntil <= at.timestamp) return { status: "expired", reason: "anchor_expired", ...base };
  // V1 semantics retained: a disabled grant suspends its anchors (reversible, unlike emergency revocation).
  if (!grant[0]) return { status: "revoked", reason: "issuer_grant_inactive", ...base };
  return { status: "active", ...base };
}

export interface KeyValidity {
  valid: boolean;
  reason?: "key_unknown" | "key_compromised" | "key_not_yet_valid" | "key_expired";
  validFrom?: number;
  /** Absent for open-ended keys. */
  validUntil?: number;
  compromisedAt?: number;
  compromiseReason?: Hex;
  evidence: ReturnType<typeof chainEvidence>;
}

/** Whether an issuer signing key was usable at time `at` (ms), as recorded at one settled block. */
export async function registryV2KeyValidity(
  reader: ChainStatusReader,
  manifest: DeploymentManifest | null | undefined,
  query: { registry: Address; issuer: Address; signingKeyHash: Hex; at: number },
  snapshot?: ChainSnapshot,
): Promise<KeyValidity> {
  const record = pinnedDeployment(manifest, { chainId: reader.options.chainId, contract: REGISTRY_V2_CONTRACT, address: query.registry });
  const t = msToSeconds(query.at);
  const snap = snapshot ?? (await reader.snapshot());
  const [codeHash, key] = (await reader.read(snap, (client, blockNumber) => Promise.all([
    codeHashAt(client, record.address, blockNumber),
    client.readContract({ address: record.address, abi: registryV2Abi, functionName: "issuerKeys", args: [query.issuer, query.signingKeyHash], blockNumber }),
  ]))) as [Hex | null, KeyTuple];
  assertPinnedCode(record, codeHash);
  const evidence = chainEvidence(snap);
  const check = keyValidityAtSeconds(key, t);
  if (check.valid === false && check.reason === "key_unknown") return { valid: false, reason: "key_unknown", evidence };
  const [validFrom, validUntil, compromisedAt, compromiseReason] = key;
  return {
    valid: check.valid, ...(check.valid ? {} : { reason: check.reason }),
    validFrom: Number(validFrom) * 1000,
    ...(validUntil === 2n ** 64n - 1n ? {} : { validUntil: Number(validUntil) * 1000 }),
    ...(compromisedAt === 0n ? {} : { compromisedAt: Number(compromisedAt) * 1000, compromiseReason: compromiseReason.toLowerCase() as Hex }),
    evidence,
  };
}

// ---------------------------------------------------------------- writes

export type RegistryV2Write =
  | "configureIssuer" | "configureVerifier" | "anchor" | "revoke" | "recordDecision"
  | "proposeAdministrator" | "cancelAdministratorProposal" | "acceptAdministrator"
  | "registerIssuerKey" | "rotateIssuerKey" | "retireIssuerKey" | "markIssuerKeyCompromised"
  | "emergencyRevokeAnchor" | "emergencyRevokeGrant";

/**
 * Calldata for a registry call, for submission through a Safe (or any multisig) rather than an
 * EOA. Building calldata is not gated; executing it on mainnet is gated by the Safe's signers and
 * by this package's writers.
 */
export function encodeRegistryV2Call(functionName: RegistryV2Write, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: registryV2Abi, functionName, args } as never);
}

/** Minimal viem-like clients a writer needs. */
export interface RegistryV2WriteClients {
  publicClient: {
    getChainId(): Promise<number>;
    simulateContract(args: never): Promise<{ request: unknown }>;
    waitForTransactionReceipt(args: never): Promise<{ status: "success" | "reverted"; blockNumber: bigint; contractAddress?: Address | null | undefined }>;
    getCode(args: never): Promise<Hex | undefined>;
  };
  walletClient: { writeContract(args: never): Promise<Hex>; deployContract(args: never): Promise<Hex> };
  account: Address;
  /** Chain the caller intends to write to; checked against the RPC before every write. */
  chainId: number;
  confirmations?: number;
}
const assertWritableChain = async (clients: RegistryV2WriteClients) => {
  // Mainnet writes stay closed until the production release gate is lifted (specs/production-readiness.md).
  if (clients.chainId === 1) fail("production_writes_disabled");
  const actual = await clients.publicClient.getChainId();
  if (actual !== clients.chainId) fail("chain_mismatch", `expected ${clients.chainId}, RPC reports ${actual}`);
};

/** Simulate-then-send writer for one registry. Refuses chain ID 1 at construction and before each write. */
export function registryV2Writer(clients: RegistryV2WriteClients, address: Address) {
  if (clients.chainId === 1) fail("production_writes_disabled");
  return {
    async write(functionName: RegistryV2Write, args: readonly unknown[]) {
      await assertWritableChain(clients);
      const sim = await clients.publicClient.simulateContract(
        { address, abi: registryV2Abi, functionName, args, account: clients.account } as never);
      const hash = await clients.walletClient.writeContract(sim.request as never);
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash, confirmations: clients.confirmations ?? 1 } as never);
      if (receipt.status !== "success") fail("write_reverted", hash);
      return { hash, blockNumber: receipt.blockNumber };
    },
  };
}

/**
 * Deploy WorkspaceRegistryV2 with an explicit administrator (use a Safe). Returns the facts a
 * manifest record needs; sourceDigest and compiler settings come from the build, not the chain.
 */
export async function deployRegistryV2(
  clients: RegistryV2WriteClients,
  input: { bytecode: Hex; administrator: Address },
) {
  await assertWritableChain(clients);
  if (!/^0x[0-9a-fA-F]+$/.test(input.bytecode)) fail("invalid_artifact");
  const deployTx = await clients.walletClient.deployContract(
    { abi: registryV2Abi, bytecode: input.bytecode, args: [input.administrator], account: clients.account } as never);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: deployTx, confirmations: clients.confirmations ?? 1 } as never);
  if (receipt.status !== "success" || !receipt.contractAddress) fail("write_reverted", deployTx);
  const code = await clients.publicClient.getCode({ address: receipt.contractAddress, blockNumber: receipt.blockNumber } as never);
  if (!code || code === "0x") fail("no_code");
  return {
    contract: REGISTRY_V2_CONTRACT, address: receipt.contractAddress!, deployTx, blockNumber: Number(receipt.blockNumber),
    runtimeCodeHash: runtimeCodeHash(code!), administrator: input.administrator,
  };
}
